import type { Queue } from 'bullmq';
import {
  PROFILE_BACKFILL_JOB_NAME,
  PROFILE_BACKFILL_JOB_OPTIONS,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';

function profileBackfillJobId(backfillId: string, pageNumber: number) {
  return `${backfillId}_${String(pageNumber)}`;
}

export async function ensureProfileBackfillQueued(
  queue: Queue<ProfileBackfillJobPayload>,
  backfillId: string,
  pageNumber: number,
) {
  const jobId = profileBackfillJobId(backfillId, pageNumber);
  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state !== 'failed' && state !== 'completed' && state !== 'unknown') {
      return;
    }
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
