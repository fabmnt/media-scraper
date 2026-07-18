import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { automaticProfiles, type Database } from '@media-scraper/database';
import {
  AUTOMATIC_PROFILE_JOB_NAME,
  AUTOMATIC_PROFILE_JOB_OPTIONS,
  AUTOMATIC_PROFILE_SCHEDULER_PREFIX,
  automaticProfileSchedulerId,
  type AutomaticProfileJobPayload,
} from '@media-scraper/shared';

const MILLISECONDS_PER_MINUTE = 60_000;

export async function reconcileAutomaticProfileSchedulers(
  db: Database,
  queue: Queue<AutomaticProfileJobPayload>,
) {
  const profiles = await db
    .select({
      id: automaticProfiles.id,
      intervalMinutes: automaticProfiles.intervalMinutes,
    })
    .from(automaticProfiles)
    .where(eq(automaticProfiles.enabled, true));
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const schedulers = await queue.getJobSchedulers();
  await Promise.all(
    schedulers
      .filter(
        (scheduler) =>
          scheduler.key.startsWith(AUTOMATIC_PROFILE_SCHEDULER_PREFIX) &&
          !profileIds.has(
            scheduler.key.slice(AUTOMATIC_PROFILE_SCHEDULER_PREFIX.length),
          ),
      )
      .map((scheduler) => queue.removeJobScheduler(scheduler.key)),
  );
  const scheduledJobs = await Promise.all(
    profiles.map((profile) =>
      queue.upsertJobScheduler(
        automaticProfileSchedulerId(profile.id),
        { every: profile.intervalMinutes * MILLISECONDS_PER_MINUTE },
        {
          name: AUTOMATIC_PROFILE_JOB_NAME,
          data: { profileId: profile.id },
          opts: AUTOMATIC_PROFILE_JOB_OPTIONS,
        },
      ),
    ),
  );
  await Promise.all(
    profiles.map((profile, index) => {
      const job = scheduledJobs[index];
      if (!job) return Promise.resolve();
      return db
        .update(automaticProfiles)
        .set({ nextCheckAt: new Date(job.timestamp + (job.opts.delay ?? 0)) })
        .where(eq(automaticProfiles.id, profile.id));
    }),
  );
  return profiles.length;
}
