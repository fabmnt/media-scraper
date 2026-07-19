import type { Queue } from 'bullmq';
import {
  PROFILE_BACKFILL_JOB_NAME,
  PROFILE_BACKFILL_JOB_OPTIONS,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';

const REPLACEABLE_JOB_STATES = new Set(['completed', 'failed', 'unknown']);

export async function queueProfileBackfill(
  queue: Queue<ProfileBackfillJobPayload>,
  backfillId: string,
  pageNumber = 0,
) {
  const jobId = `${backfillId}:${String(pageNumber)}`;
  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (!REPLACEABLE_JOB_STATES.has(state)) return;
    try {
      await existingJob.remove();
    } catch (error) {
      if (await queue.getJob(jobId)) throw error;
    }
  }

  await queue.add(
    PROFILE_BACKFILL_JOB_NAME,
    { backfillId, pageNumber },
    { ...PROFILE_BACKFILL_JOB_OPTIONS, jobId },
  );
}
