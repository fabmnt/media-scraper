import type { Queue } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { profileBackfills, type Database } from '@media-scraper/database';
import type { ProfileBackfillJobPayload } from '@media-scraper/shared';
import { ensureProfileBackfillQueued } from './profile-backfill-queue.js';

const RESUMABLE_PROFILE_BACKFILL_STATUSES = ['queued', 'processing'] as const;

export async function reconcileProfileBackfills(
  db: Database,
  queue: Queue<ProfileBackfillJobPayload>,
) {
  const backfills = await db
    .select({
      id: profileBackfills.id,
      pageNumber: profileBackfills.pageNumber,
    })
    .from(profileBackfills)
    .where(
      inArray(profileBackfills.status, RESUMABLE_PROFILE_BACKFILL_STATUSES),
    );
  const results = await Promise.allSettled(
    backfills.map((backfill) =>
      ensureProfileBackfillQueued(queue, backfill.id, backfill.pageNumber),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more profile archives could not be reconciled',
    );
  }
  return backfills.length;
}
