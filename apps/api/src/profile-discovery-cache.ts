import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  MAX_PROFILE_MEDIA,
  MAX_PROFILE_SOURCE_CURSOR_LENGTH,
  PROFILE_DISCOVERY_CACHE_ITEMS,
  platformSchema,
  profileMediaSchema,
  type ProfileLookup,
  type ProfileMediaResults,
} from '@media-scraper/shared';
import { InvalidProfileCursorError } from '@media-scraper/extractors';
import { z } from 'zod';

const CACHE_VERSION = 4;
const CACHE_KEY_PREFIX = `profile-discovery:v${String(CACHE_VERSION)}`;
const cacheCursorSchema = z.object({
  version: z.literal(CACHE_VERSION),
  snapshotId: z.uuid(),
  offset: z.number().int().nonnegative().max(PROFILE_DISCOVERY_CACHE_ITEMS),
});
const cachedSnapshotSchema = z.object({
  platform: platformSchema,
  username: z.string().min(1).max(100),
  credentialVersion: z.string().min(1).max(200),
  items: z.array(profileMediaSchema).max(PROFILE_DISCOVERY_CACHE_ITEMS),
  sourceCursor: z.string().max(MAX_PROFILE_SOURCE_CURSOR_LENGTH).nullable(),
  nextSnapshotId: z.uuid().nullable(),
});

type CachedSnapshot = z.infer<typeof cachedSnapshotSchema>;
type SnapshotIdentity = Pick<
  CachedSnapshot,
  'credentialVersion' | 'platform' | 'username'
>;
type SnapshotResult = { id: string; snapshot: CachedSnapshot };
type SnapshotLoader = (
  cursor: string | undefined,
  signal: AbortSignal,
) => Promise<ProfileMediaResults>;

interface InFlightLoad {
  abortController: AbortController;
  consumers: number;
  promise: Promise<SnapshotResult>;
  settled: boolean;
}

function invalidCursor(
  message = 'The profile continuation cursor is invalid.',
) {
  return new InvalidProfileCursorError(message);
}

function encodeCacheCursor(snapshotId: string, offset: number) {
  return Buffer.from(
    JSON.stringify(
      cacheCursorSchema.parse({ version: CACHE_VERSION, snapshotId, offset }),
    ),
  ).toString('base64url');
}

function decodeCacheCursor(cursor: string) {
  try {
    return cacheCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch (error) {
    throw new InvalidProfileCursorError(
      'The profile continuation cursor is invalid.',
      { cause: error },
    );
  }
}

export class ProfileDiscoveryCache {
  private readonly abortController = new AbortController();
  private readonly inFlight = new Map<string, InFlightLoad>();

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  close() {
    this.abortController.abort(new Error('Profile discovery cache closed'));
  }

  async page(
    input: ProfileLookup,
    credentialVersion: string,
    requestSignal: AbortSignal,
    load: SnapshotLoader,
  ): Promise<ProfileMediaResults> {
    requestSignal.throwIfAborted();
    const identity = {
      credentialVersion,
      platform: input.platform,
      username: input.username,
    };
    if (input.cursor === undefined) {
      const lookupKey = this.lookupKey(identity);
      const initial = await this.initialSnapshot(
        lookupKey,
        identity,
        requestSignal,
        load,
      );
      return this.snapshotPage(
        initial.id,
        initial.snapshot,
        0,
        identity,
        requestSignal,
        load,
      );
    }

    const cursor = decodeCacheCursor(input.cursor);
    const snapshot = await this.readSnapshot(cursor.snapshotId);
    if (!snapshot) {
      throw invalidCursor(
        'This profile result has expired. Find the profile again to refresh it.',
      );
    }
    this.assertSnapshotIdentity(snapshot, identity);
    return this.snapshotPage(
      cursor.snapshotId,
      snapshot,
      cursor.offset,
      identity,
      requestSignal,
      load,
    );
  }

  private async initialSnapshot(
    lookupKey: string,
    identity: SnapshotIdentity,
    requestSignal: AbortSignal,
    load: SnapshotLoader,
  ) {
    const cachedId = await this.redis.get(lookupKey);
    if (cachedId) {
      const snapshot = await this.readSnapshot(cachedId);
      if (snapshot) {
        this.assertSnapshotIdentity(snapshot, identity);
        await this.redis.expire(lookupKey, this.ttlSeconds);
        return { id: cachedId, snapshot };
      }
    }

    return this.once(lookupKey, requestSignal, async (loadSignal) => {
      const recheckedId = await this.redis.get(lookupKey);
      if (recheckedId) {
        const snapshot = await this.readSnapshot(recheckedId);
        if (snapshot) {
          this.assertSnapshotIdentity(snapshot, identity);
          return { id: recheckedId, snapshot };
        }
      }

      const result = await load(undefined, loadSignal);
      const created = await this.createSnapshot(identity, result);
      await this.redis.set(lookupKey, created.id, 'EX', this.ttlSeconds);
      return created;
    });
  }

  private async snapshotPage(
    snapshotId: string,
    snapshot: CachedSnapshot,
    offset: number,
    identity: SnapshotIdentity,
    requestSignal: AbortSignal,
    load: SnapshotLoader,
  ): Promise<ProfileMediaResults> {
    if (offset > snapshot.items.length) throw invalidCursor();

    if (offset === snapshot.items.length && snapshot.sourceCursor) {
      const next = await this.nextSnapshot(
        snapshotId,
        snapshot,
        identity,
        requestSignal,
        load,
      );
      return this.snapshotPage(
        next.id,
        next.snapshot,
        0,
        identity,
        requestSignal,
        load,
      );
    }

    const nextOffset = Math.min(
      offset + MAX_PROFILE_MEDIA,
      snapshot.items.length,
    );
    const hasMore =
      nextOffset < snapshot.items.length || Boolean(snapshot.sourceCursor);

    return {
      items: snapshot.items.slice(offset, nextOffset),
      nextCursor: hasMore ? encodeCacheCursor(snapshotId, nextOffset) : null,
    };
  }

  private async nextSnapshot(
    snapshotId: string,
    snapshot: CachedSnapshot,
    identity: SnapshotIdentity,
    requestSignal: AbortSignal,
    load: SnapshotLoader,
  ) {
    if (!snapshot.sourceCursor) throw invalidCursor();

    if (snapshot.nextSnapshotId) {
      const cached = await this.readSnapshot(snapshot.nextSnapshotId);
      if (cached) {
        this.assertSnapshotIdentity(cached, identity);
        return { id: snapshot.nextSnapshotId, snapshot: cached };
      }
    }

    return this.once(
      `next:${snapshotId}`,
      requestSignal,
      async (loadSignal) => {
        const current = await this.readSnapshot(snapshotId);
        if (!current?.sourceCursor) throw invalidCursor();
        this.assertSnapshotIdentity(current, identity);
        if (current.nextSnapshotId) {
          const cached = await this.readSnapshot(current.nextSnapshotId);
          if (cached) {
            this.assertSnapshotIdentity(cached, identity);
            return { id: current.nextSnapshotId, snapshot: cached };
          }
        }

        const result = await load(current.sourceCursor, loadSignal);
        const created = await this.createSnapshot(identity, result);
        await this.writeSnapshot(snapshotId, {
          ...current,
          nextSnapshotId: created.id,
        });
        return created;
      },
    );
  }

  private async createSnapshot(
    identity: SnapshotIdentity,
    result: ProfileMediaResults,
  ) {
    const id = randomUUID();
    const snapshot = cachedSnapshotSchema.parse({
      ...identity,
      items: result.items,
      sourceCursor: result.nextCursor,
      nextSnapshotId: null,
    });
    await this.writeSnapshot(id, snapshot);
    return { id, snapshot };
  }

  private async readSnapshot(id: string) {
    const key = this.snapshotKey(id);
    const value = await this.redis.get(key);
    if (!value) return undefined;

    try {
      const snapshot = cachedSnapshotSchema.parse(JSON.parse(value));
      await this.redis.expire(key, this.ttlSeconds);
      return snapshot;
    } catch {
      await this.redis.del(key);
      return undefined;
    }
  }

  private async writeSnapshot(id: string, snapshot: CachedSnapshot) {
    await this.redis.set(
      this.snapshotKey(id),
      JSON.stringify(snapshot),
      'EX',
      this.ttlSeconds,
    );
  }

  private assertSnapshotIdentity(
    snapshot: CachedSnapshot,
    identity: SnapshotIdentity,
  ) {
    if (
      snapshot.platform !== identity.platform ||
      snapshot.username !== identity.username ||
      snapshot.credentialVersion !== identity.credentialVersion
    ) {
      throw invalidCursor('The profile cursor does not match this profile.');
    }
  }

  private lookupKey(identity: SnapshotIdentity) {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          platform: identity.platform,
          username: identity.username,
          credentialVersion: identity.credentialVersion,
        }),
      )
      .digest('hex');
    return `${CACHE_KEY_PREFIX}:lookup:${digest}`;
  }

  private snapshotKey(id: string) {
    return `${CACHE_KEY_PREFIX}:snapshot:${id}`;
  }

  private once(
    key: string,
    requestSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<SnapshotResult>,
  ) {
    let active = this.inFlight.get(key);
    if (!active) {
      const abortController = new AbortController();
      const signal = AbortSignal.any([
        this.abortController.signal,
        abortController.signal,
      ]);
      const load: InFlightLoad = {
        abortController,
        consumers: 0,
        promise: operation(signal).finally(() => {
          load.settled = true;
          if (this.inFlight.get(key) === load) this.inFlight.delete(key);
        }),
        settled: false,
      };
      active = load;
      this.inFlight.set(key, load);
    }

    return this.waitForLoad(key, active, requestSignal);
  }

  private async waitForLoad(
    key: string,
    load: InFlightLoad,
    requestSignal: AbortSignal,
  ) {
    if (requestSignal.aborted) {
      if (!load.settled && load.consumers === 0) {
        load.abortController.abort(requestSignal.reason);
        if (this.inFlight.get(key) === load) this.inFlight.delete(key);
      }
      requestSignal.throwIfAborted();
    }

    load.consumers += 1;
    let abortRequest: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortRequest = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', abortRequest, { once: true });
    });

    try {
      return await Promise.race([load.promise, aborted]);
    } finally {
      requestSignal.removeEventListener('abort', abortRequest);
      load.consumers -= 1;
      if (!load.settled && load.consumers === 0) {
        load.abortController.abort(
          new Error('Profile discovery request abandoned'),
        );
        if (this.inFlight.get(key) === load) this.inFlight.delete(key);
      }
    }
  }
}
