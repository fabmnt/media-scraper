import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  automaticProfiles,
  profileBackfills,
  type Database,
} from '@media-scraper/database';
import { discoverProfileMedia } from '@media-scraper/extractors';
import {
  MAX_PROFILE_MEDIA,
  type CollectionJobPayload,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';
import { queueDiscoveredProfileMedia } from './profile-collection-queue.js';
import { profileCredentialPath } from './profile-credentials.js';
import { waitForProfileDiscovery } from './profile-discovery-rate-limiter.js';
import { ensureProfileBackfillQueued } from './profile-backfill-queue.js';

const MAX_ERROR_LENGTH = 4_000;

interface ProfileBackfillOptions {
  collectionQueue: Queue<CollectionJobPayload>;
  credentialsRoot: string;
  db: Database;
  isFinalAttempt: boolean;
  profileDiscoveryIntervalMs: number;
  queue: Queue<ProfileBackfillJobPayload>;
  signal: AbortSignal;
}

export async function processProfileBackfill(
  { backfillId, pageNumber }: ProfileBackfillJobPayload,
  {
    collectionQueue,
    credentialsRoot,
    db,
    isFinalAttempt,
    profileDiscoveryIntervalMs,
    queue,
    signal,
  }: ProfileBackfillOptions,
) {
  const [backfill] = await db
    .select()
    .from(profileBackfills)
    .where(eq(profileBackfills.id, backfillId));
  if (
    !backfill ||
    backfill.status === 'completed' ||
    backfill.status === 'failed'
  ) {
    return {
      collectionsQueued: 0,
      completed: backfill?.status === 'completed',
    };
  }
  if (pageNumber < backfill.pageNumber) {
    await ensureProfileBackfillQueued(queue, backfill.id, backfill.pageNumber);
    return { collectionsQueued: 0, completed: false };
  }
  if (pageNumber > backfill.pageNumber) {
    return { collectionsQueued: 0, completed: false };
  }

  const [profile] = await db
    .select()
    .from(automaticProfiles)
    .where(eq(automaticProfiles.id, backfill.automaticProfileId));
  if (!profile) return { collectionsQueued: 0, completed: false };
  if (!profile.enabled) {
    await db
      .update(profileBackfills)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(profileBackfills.id, backfill.id));
    return { collectionsQueued: 0, completed: false };
  }

  try {
    const startedAt = backfill.startedAt ?? new Date();
    await db
      .update(profileBackfills)
      .set({ status: 'processing', startedAt, updatedAt: startedAt })
      .where(eq(profileBackfills.id, backfill.id));

    const cookiesPath = await profileCredentialPath(
      credentialsRoot,
      profile.platform,
    );
    await waitForProfileDiscovery(profileDiscoveryIntervalMs, signal);
    const result = await discoverProfileMedia(
      {
        platform: profile.platform,
        username: profile.username,
        cursor: backfill.cursor ?? undefined,
      },
      cookiesPath,
      signal,
      MAX_PROFILE_MEDIA,
      { includeStories: backfill.includeStories },
    );
    signal.throwIfAborted();
    const collectionsQueued = await queueDiscoveredProfileMedia(
      profile,
      result.items,
      { collectionQueue, db },
    );

    const completed = result.nextCursor === null;
    const nextPageNumber = backfill.pageNumber + 1;
    const updatedAt = new Date();
    await db
      .update(profileBackfills)
      .set({
        status: completed ? 'completed' : 'queued',
        cursor: result.nextCursor,
        pageNumber: nextPageNumber,
        itemsDiscovered: backfill.itemsDiscovered + result.items.length,
        collectionsQueued: backfill.collectionsQueued + collectionsQueued,
        lastError: null,
        completedAt: completed ? updatedAt : null,
        updatedAt,
      })
      .where(eq(profileBackfills.id, backfill.id));

    if (!completed) {
      await ensureProfileBackfillQueued(queue, backfill.id, nextPageNumber);
    }
    return { collectionsQueued, completed };
  } catch (error) {
    if (signal.aborted) throw error;
    if (isFinalAttempt) {
      const message = (
        error instanceof Error
          ? error.message
          : 'Unknown profile archive failure'
      ).slice(0, MAX_ERROR_LENGTH);
      await db
        .update(profileBackfills)
        .set({ status: 'failed', lastError: message, updatedAt: new Date() })
        .where(eq(profileBackfills.id, backfill.id));
    }
    throw error;
  }
}
