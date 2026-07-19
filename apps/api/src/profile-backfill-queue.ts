import type { Queue } from 'bullmq';
import {
  PROFILE_BACKFILL_JOB_NAME,
  PROFILE_BACKFILL_JOB_OPTIONS,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';

export function queueProfileBackfill(
  queue: Queue<ProfileBackfillJobPayload>,
  backfillId: string,
) {
  return queue.add(
    PROFILE_BACKFILL_JOB_NAME,
    { backfillId, pageNumber: 0 },
    { ...PROFILE_BACKFILL_JOB_OPTIONS, jobId: `${backfillId}:0` },
  );
}
