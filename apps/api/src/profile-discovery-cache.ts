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

const CACHE_VERSION = 2;
const CACHE_KEY_PREFIX = `profile-discovery:v${String(CACHE_VERSION)}`;
const cacheCursorSchema = z.object({
  version: z.literal(CACHE_VERSION),
  snapshotId: z.uuid(),
  offset: z.number().int().nonnegative().max(PROFILE_DISCOVERY_CACHE_ITEMS),
});
const cachedSnapshotSchema = z.object({
  platform: platformSchema,
  username: z.string().min(1).max(100),
  items: z.array(profileMediaSchema).max(PROFILE_DISCOVERY_CACHE_ITEMS),
  sourceCursor: z.string().max(MAX_PROFILE_SOURCE_CURSOR_LENGTH).nullable(),
  nextSnapshotId: z.uuid().nullable(),
});

type CachedSnapshot = z.infer<typeof cachedSnapshotSchema>;
type SnapshotIdentity = Pick<ProfileLookup, 'platform' | 'username'>;
type SnapshotLoader = (
  cursor: string | undefined,
  signal: AbortSignal,
) => Promise<ProfileMediaResults>;

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
  private readonly inFlight = new Map<
    string,
    Promise<{ id: string; snapshot: CachedSnapshot }>
  >();

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
    load: SnapshotLoader,
  ): Promise<ProfileMediaResults> {
    if (input.cursor === undefined) {
      const lookupKey = this.lookupKey(input, credentialVersion);
      const initial = await this.initialSnapshot(lookupKey, input, load);
      return this.snapshotPage(initial.id, initial.snapshot, 0, input, load);
    }

    const cursor = decodeCacheCursor(input.cursor);
    const snapshot = await this.readSnapshot(cursor.snapshotId);
    if (!snapshot) {
      throw invalidCursor(
        'This profile result has expired. Find the profile again to refresh it.',
      );
    }
    this.assertSnapshotIdentity(snapshot, input);
    return this.snapshotPage(
      cursor.snapshotId,
      snapshot,
      cursor.offset,
      input,
      load,
    );
  }

  private async initialSnapshot(
    lookupKey: string,
    identity: SnapshotIdentity,
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

    return this.once(lookupKey, async () => {
      const recheckedId = await this.redis.get(lookupKey);
      if (recheckedId) {
        const snapshot = await this.readSnapshot(recheckedId);
        if (snapshot) {
          this.assertSnapshotIdentity(snapshot, identity);
          return { id: recheckedId, snapshot };
        }
      }

      const result = await load(undefined, this.abortController.signal);
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
    load: SnapshotLoader,
  ): Promise<ProfileMediaResults> {
    if (offset > snapshot.items.length) throw invalidCursor();

    if (offset === snapshot.items.length && snapshot.sourceCursor) {
      const next = await this.nextSnapshot(
        snapshotId,
        snapshot,
        identity,
        load,
      );
      return this.snapshotPage(next.id, next.snapshot, 0, identity, load);
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

    return this.once(`next:${snapshotId}`, async () => {
      const current = await this.readSnapshot(snapshotId);
      if (!current?.sourceCursor) throw invalidCursor();
      if (current.nextSnapshotId) {
        const cached = await this.readSnapshot(current.nextSnapshotId);
        if (cached) {
          this.assertSnapshotIdentity(cached, identity);
          return { id: current.nextSnapshotId, snapshot: cached };
        }
      }

      const result = await load(
        current.sourceCursor,
        this.abortController.signal,
      );
      const created = await this.createSnapshot(identity, result);
      await this.writeSnapshot(snapshotId, {
        ...current,
        nextSnapshotId: created.id,
      });
      return created;
    });
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
      snapshot.username !== identity.username
    ) {
      throw invalidCursor('The profile cursor does not match this profile.');
    }
  }

  private lookupKey(identity: SnapshotIdentity, credentialVersion: string) {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          platform: identity.platform,
          username: identity.username,
          credentialVersion,
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
    operation: () => Promise<{ id: string; snapshot: CachedSnapshot }>,
  ) {
    const active = this.inFlight.get(key);
    if (active) return active;

    const promise = operation().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
