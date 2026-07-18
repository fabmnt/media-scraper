import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queue } from 'bullmq';
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  automaticProfiles,
  collections,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import { discoverProfileMedia } from '@media-scraper/extractors';
import {
  COLLECTION_JOB_OPTIONS,
  COLLECTION_QUEUE_NAME,
  MAX_PROFILE_MEDIA,
  PLATFORM_CREDENTIALS,
  type CollectionJobPayload,
} from '@media-scraper/shared';

const MAX_ERROR_LENGTH = 4_000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MAX_PROFILE_BACKOFF_MS = 24 * 60 * MILLISECONDS_PER_MINUTE;

interface AutomaticProfileOptions {
  collectionQueue: Queue<CollectionJobPayload>;
  credentialsRoot: string;
  db: Database;
  force?: boolean;
  signal: AbortSignal;
}

async function credentialPath(
  credentialsRoot: string,
  platform: keyof typeof PLATFORM_CREDENTIALS,
) {
  const path = join(credentialsRoot, PLATFORM_CREDENTIALS[platform].fileName);
  return access(path)
    .then(() => path)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
}

async function queueCollections(
  collectionQueue: Queue<CollectionJobPayload>,
  pendingCollections: Array<{
    id: string;
    platform: CollectionJobPayload['platform'];
    sourceUrl: string;
  }>,
  db: Database,
) {
  const results = await Promise.allSettled(
    pendingCollections.map(async (collection) => {
      try {
        await collectionQueue.add(
          COLLECTION_QUEUE_NAME,
          {
            collectionId: collection.id,
            platform: collection.platform,
            url: collection.sourceUrl,
          },
          { ...COLLECTION_JOB_OPTIONS, jobId: collection.id },
        );
      } catch (error) {
        const existingJob = await collectionQueue.getJob(collection.id);
        if (!existingJob) throw error;
      }
    }),
  );
  const failedIds = results.flatMap((result, index) => {
    const collection = pendingCollections[index];
    return result.status === 'rejected' && collection ? [collection.id] : [];
  });
  if (failedIds.length === 0) return;

  await db
    .update(collections)
    .set({
      status: 'failed',
      errorMessage: 'Automatic collection could not be queued',
      updatedAt: new Date(),
    })
    .where(inArray(collections.id, failedIds));
  throw new Error(
    `${String(failedIds.length)} automatic collection jobs could not be queued`,
  );
}

export async function processAutomaticProfile(
  profileId: string,
  {
    collectionQueue,
    credentialsRoot,
    db,
    force = false,
    signal,
  }: AutomaticProfileOptions,
) {
  const [profile] = await db
    .select()
    .from(automaticProfiles)
    .where(eq(automaticProfiles.id, profileId));
  if (!profile?.enabled) return { queuedCollections: 0 };

  const now = new Date();
  if (!force && profile.retryAt && profile.retryAt > now) {
    return { queuedCollections: 0 };
  }

  try {
    const cookiesPath = await credentialPath(credentialsRoot, profile.platform);
    const result = await discoverProfileMedia(
      { platform: profile.platform, username: profile.username },
      cookiesPath,
      signal,
      MAX_PROFILE_MEDIA,
    );
    signal.throwIfAborted();

    const sourceIds = result.items.map((item) => item.id);
    const sourceUrls = result.items.map((item) => item.sourceUrl);
    const [collectedRows, collectionRows] =
      sourceIds.length === 0
        ? [[], []]
        : await Promise.all([
            db
              .select({ sourceId: mediaItems.sourceId })
              .from(mediaItems)
              .where(
                and(
                  eq(mediaItems.platform, profile.platform),
                  inArray(mediaItems.sourceId, sourceIds),
                ),
              ),
            db
              .select({
                sourceId: collections.discoveredSourceId,
                sourceUrl: collections.sourceUrl,
              })
              .from(collections)
              .where(
                and(
                  eq(collections.platform, profile.platform),
                  or(
                    inArray(collections.discoveredSourceId, sourceIds),
                    inArray(collections.sourceUrl, sourceUrls),
                  ),
                ),
              ),
          ]);
    const knownSourceIds = new Set([
      ...collectedRows.map((item) => item.sourceId),
      ...collectionRows.flatMap((item) =>
        item.sourceId ? [item.sourceId] : [],
      ),
    ]);
    const knownSourceUrls = new Set(
      collectionRows.map((item) => item.sourceUrl),
    );
    const pendingValues = result.items
      .filter(
        (item) =>
          !knownSourceIds.has(item.id) && !knownSourceUrls.has(item.sourceUrl),
      )
      .map((item) => ({
        id: randomUUID(),
        automaticProfileId: profile.id,
        discoveredSourceId: item.id,
        origin: 'automatic' as const,
        platform: profile.platform,
        sourceUrl: item.sourceUrl,
      }));
    const pendingCollections =
      pendingValues.length === 0
        ? []
        : await db
            .insert(collections)
            .values(pendingValues)
            .onConflictDoNothing()
            .returning({
              id: collections.id,
              platform: collections.platform,
              sourceUrl: collections.sourceUrl,
            });
    await queueCollections(collectionQueue, pendingCollections, db);

    const checkedAt = new Date();
    await db
      .update(automaticProfiles)
      .set({
        consecutiveFailures: 0,
        lastCheckedAt: checkedAt,
        lastError: null,
        lastSuccessAt: checkedAt,
        nextCheckAt: new Date(
          checkedAt.getTime() +
            profile.intervalMinutes * MILLISECONDS_PER_MINUTE,
        ),
        retryAt: null,
        updatedAt: checkedAt,
      })
      .where(eq(automaticProfiles.id, profile.id));
    return { queuedCollections: pendingCollections.length };
  } catch (error) {
    const checkedAt = new Date();
    const consecutiveFailures = profile.consecutiveFailures + 1;
    const backoffMultiplier = 2 ** Math.min(consecutiveFailures, 10);
    const retryDelayMs = Math.min(
      profile.intervalMinutes * MILLISECONDS_PER_MINUTE * backoffMultiplier,
      MAX_PROFILE_BACKOFF_MS,
    );
    const message = (
      error instanceof Error ? error.message : 'Unknown profile check failure'
    ).slice(0, MAX_ERROR_LENGTH);
    await db
      .update(automaticProfiles)
      .set({
        consecutiveFailures,
        lastCheckedAt: checkedAt,
        lastError: message,
        nextCheckAt: new Date(checkedAt.getTime() + retryDelayMs),
        retryAt: new Date(checkedAt.getTime() + retryDelayMs),
        updatedAt: checkedAt,
      })
      .where(eq(automaticProfiles.id, profile.id));
    throw error;
  }
}
