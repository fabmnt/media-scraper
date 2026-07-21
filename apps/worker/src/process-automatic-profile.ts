import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { automaticProfiles, type Database } from '@media-scraper/database';
import { discoverProfileMedia } from '@media-scraper/extractors';
import {
  MAX_PROFILE_MEDIA,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { queueDiscoveredProfileMedia } from './profile-collection-queue.js';
import { profileCredentialPath } from './profile-credentials.js';
import { waitForProfileDiscovery } from './profile-discovery-rate-limiter.js';

const MAX_ERROR_LENGTH = 4_000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MAX_PROFILE_BACKOFF_MS = 24 * 60 * MILLISECONDS_PER_MINUTE;

interface AutomaticProfileOptions {
  collectionQueue: Queue<CollectionJobPayload>;
  credentialsRoot: string;
  db: Database;
  force?: boolean;
  profileDiscoveryIntervalMs: number;
  signal: AbortSignal;
}

export async function processAutomaticProfile(
  profileId: string,
  {
    collectionQueue,
    credentialsRoot,
    db,
    force = false,
    profileDiscoveryIntervalMs,
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
    const cookiesPath = await profileCredentialPath(
      credentialsRoot,
      profile.platform,
    );
    await waitForProfileDiscovery(profileDiscoveryIntervalMs, signal);
    const result = await discoverProfileMedia(
      {
        platform: profile.platform,
        username: profile.username,
        includeHighlights: profile.includeHighlights,
      },
      cookiesPath,
      signal,
      MAX_PROFILE_MEDIA,
      { includeStories: profile.includeStories },
    );
    signal.throwIfAborted();
    const queuedCollections = await queueDiscoveredProfileMedia(
      profile,
      result.items,
      {
        collectionQueue,
        db,
      },
    );

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
    return { queuedCollections };
  } catch (error) {
    if (signal.aborted) throw error;

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
