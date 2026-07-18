import type { Queue } from 'bullmq';
import {
  AUTOMATIC_PROFILE_JOB_NAME,
  AUTOMATIC_PROFILE_JOB_OPTIONS,
  automaticProfileSchedulerId,
  type AutomaticProfileJobPayload,
} from '@media-scraper/shared';

const MILLISECONDS_PER_MINUTE = 60_000;

interface ScheduledProfile {
  id: string;
  intervalMinutes: number;
}

export async function upsertAutomaticProfileScheduler(
  queue: Queue<AutomaticProfileJobPayload>,
  profile: ScheduledProfile,
  runImmediately = false,
) {
  const job = await queue.upsertJobScheduler(
    automaticProfileSchedulerId(profile.id),
    { every: profile.intervalMinutes * MILLISECONDS_PER_MINUTE },
    {
      name: AUTOMATIC_PROFILE_JOB_NAME,
      data: { profileId: profile.id },
      opts: AUTOMATIC_PROFILE_JOB_OPTIONS,
    },
  );
  if (runImmediately) {
    await job.promote();
    return new Date();
  }
  return new Date(job.timestamp + (job.opts.delay ?? 0));
}

export function removeAutomaticProfileScheduler(
  queue: Queue<AutomaticProfileJobPayload>,
  profileId: string,
) {
  return queue.removeJobScheduler(automaticProfileSchedulerId(profileId));
}

export function queueAutomaticProfileCheck(
  queue: Queue<AutomaticProfileJobPayload>,
  profileId: string,
  force = false,
) {
  return queue.add(
    AUTOMATIC_PROFILE_JOB_NAME,
    { force, profileId },
    AUTOMATIC_PROFILE_JOB_OPTIONS,
  );
}
