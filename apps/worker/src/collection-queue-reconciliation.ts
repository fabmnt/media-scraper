import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { collections, type Database } from '@media-scraper/database';
import {
  COLLECTION_JOB_OPTIONS,
  COLLECTION_QUEUE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';

export async function reconcileQueuedCollections(
  db: Database,
  queue: Queue<CollectionJobPayload>,
) {
  const queuedCollections = await db
    .select({
      id: collections.id,
      platform: collections.platform,
      sourceUrl: collections.sourceUrl,
    })
    .from(collections)
    .where(eq(collections.status, 'queued'));
  const results = await Promise.allSettled(
    queuedCollections.map((collection) =>
      queue.add(
        COLLECTION_QUEUE_NAME,
        {
          collectionId: collection.id,
          platform: collection.platform,
          url: collection.sourceUrl,
        },
        { ...COLLECTION_JOB_OPTIONS, jobId: collection.id },
      ),
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
