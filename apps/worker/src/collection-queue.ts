import type { Queue } from 'bullmq';
import {
  COLLECTION_JOB_OPTIONS,
  COLLECTION_QUEUE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';

const REPLACEABLE_COLLECTION_JOB_STATES = new Set([
  'completed',
  'failed',
  'unknown',
]);

export interface QueuedCollection {
  id: string;
  platform: CollectionJobPayload['platform'];
  sourceUrl: string;
}

export async function ensureCollectionQueued(
  queue: Queue<CollectionJobPayload>,
  collection: QueuedCollection,
) {
  const existingJob = await queue.getJob(collection.id);
  if (existingJob) {
    const existingJobState = await existingJob.getState();
    if (!REPLACEABLE_COLLECTION_JOB_STATES.has(existingJobState)) return;
    try {
      await existingJob.remove();
    } catch (error) {
      if (await queue.getJob(collection.id)) throw error;
    }
  }

  try {
    await queue.add(
      COLLECTION_QUEUE_NAME,
      {
        collectionId: collection.id,
        platform: collection.platform,
        url: collection.sourceUrl,
      },
      { ...COLLECTION_JOB_OPTIONS, jobId: collection.id },
    );
  } catch (error) {
    if (!(await queue.getJob(collection.id))) throw error;
  }
}
