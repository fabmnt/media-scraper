import type { Queue } from 'bullmq';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { collections, type Database } from '@media-scraper/database';
import {
  SUPPORTED_PLATFORMS,
  type CollectionJobPayload,
  type Platform,
} from '@media-scraper/shared';
import { ensureCollectionQueued } from './collection-queue.js';

export async function reconcileQueuedCollections(
  db: Database,
  queue: Queue<CollectionJobPayload>,
) {
  const queuedCollections = await db
    .select({
      id: collections.id,
      platform: sql<Platform>`${collections.platform}`,
      sourceUrl: sql<string>`${collections.sourceUrl}`,
    })
    .from(collections)
    .where(
      and(
        eq(collections.status, 'queued'),
        ne(collections.origin, 'upload'),
        isNotNull(collections.sourceUrl),
        inArray(collections.platform, SUPPORTED_PLATFORMS),
      ),
    );
  const results = await Promise.allSettled(
    queuedCollections.map((collection) =>
      ensureCollectionQueued(queue, collection),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more queued collections could not be reconciled',
    );
  }
  return queuedCollections.length;
}
