import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createProfileArchiveSchema,
  type AutomaticProfileJobPayload,
  type ProfileArchive,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';
import {
  automaticProfiles,
  profileBackfills,
  type Database,
} from '@media-scraper/database';
import { upsertAutomaticProfileScheduler } from '../automatic-profile-scheduler.js';
import { queueProfileBackfill } from '../profile-backfill-queue.js';
import {
  serializeAutomaticProfile,
  serializeProfileBackfill,
} from '../serialization.js';

interface ProfileArchiveRoutesOptions {
  automaticProfileQueue: Queue<AutomaticProfileJobPayload>;
  db: Database;
  profileBackfillQueue: Queue<ProfileBackfillJobPayload>;
}

class ProfileArchiveConflictError extends Error {
  readonly statusCode = 409;
}

class ProfileArchiveQueueError extends Error {
  readonly statusCode = 503;
}

const profileArchiveParamsSchema = z.object({ id: z.uuid() });

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

export async function profileArchiveRoutes(
  app: FastifyInstance,
  {
    automaticProfileQueue,
    db,
    profileBackfillQueue,
  }: ProfileArchiveRoutesOptions,
) {
  app.post('/', async (request, reply): Promise<ProfileArchive> => {
    const input = createProfileArchiveSchema.parse(request.body);
    let created: {
      profile: typeof automaticProfiles.$inferSelect;
      backfill: typeof profileBackfills.$inferSelect;
    };
    try {
      created = await db.transaction(async (transaction) => {
        const [profile] = await transaction
          .insert(automaticProfiles)
          .values(input)
          .returning();
        if (!profile) throw new Error('Failed to create automatic profile');
        const [backfill] = await transaction
          .insert(profileBackfills)
          .values({
            automaticProfileId: profile.id,
            includeStories: input.includeStories,
          })
          .returning();
        if (!backfill) throw new Error('Failed to create profile archive');
        return { profile, backfill };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProfileArchiveConflictError(
          'Automatic collection is already configured for this profile',
        );
      }
      throw error;
    }

    let profile = created.profile;
    try {
      const nextCheckAt = await upsertAutomaticProfileScheduler(
        automaticProfileQueue,
        profile,
      );
      const [scheduledProfile] = await db
        .update(automaticProfiles)
        .set({ nextCheckAt, updatedAt: new Date() })
        .where(eq(automaticProfiles.id, profile.id))
        .returning();
      profile = scheduledProfile ?? profile;
    } catch (error) {
      request.log.error(error, 'Could not schedule profile archive watcher');
      throw new ProfileArchiveQueueError(
        'Profile archive was saved but automatic collection could not be scheduled',
      );
    }

    try {
      await queueProfileBackfill(profileBackfillQueue, created.backfill.id);
    } catch (error) {
      request.log.error(error, 'Could not queue profile archive');
      try {
        await db
          .update(profileBackfills)
          .set({
            status: 'failed',
            lastError: 'Profile archive could not be queued',
            updatedAt: new Date(),
          })
          .where(eq(profileBackfills.id, created.backfill.id));
      } catch (cleanupError) {
        request.log.error(
          cleanupError,
          'Could not record profile archive failure',
        );
      }
      throw new ProfileArchiveQueueError(
        `Automatic collection was saved, but the profile archive could not be queued. Retry it with /profile-archives/${created.profile.id}/retry.`,
      );
    }

    return reply.code(202).send({
      profile: serializeAutomaticProfile(profile),
      backfill: serializeProfileBackfill(created.backfill),
    });
  });

  app.post('/:id/retry', async (request, reply): Promise<ProfileArchive> => {
    const { id } = profileArchiveParamsSchema.parse(request.params);
    const [profile] = await db
      .select()
      .from(automaticProfiles)
      .where(eq(automaticProfiles.id, id));
    if (!profile) {
      const error = new Error('Profile archive not found');
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    const [backfill] = await db
      .select()
      .from(profileBackfills)
      .where(eq(profileBackfills.automaticProfileId, profile.id));
    if (!backfill) {
      const error = new Error('Profile archive not found');
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    if (!profile.enabled) {
      const error = new Error(
        'Resume automatic collection before retrying this profile archive',
      );
      Object.assign(error, { statusCode: 409 });
      throw error;
    }

    try {
      const nextCheckAt = await upsertAutomaticProfileScheduler(
        automaticProfileQueue,
        profile,
      );
      const [scheduledProfile] = await db
        .update(automaticProfiles)
        .set({ nextCheckAt, updatedAt: new Date() })
        .where(eq(automaticProfiles.id, profile.id))
        .returning();
      const [queuedBackfill] = await db
        .update(profileBackfills)
        .set({ status: 'queued', lastError: null, updatedAt: new Date() })
        .where(eq(profileBackfills.id, backfill.id))
        .returning();
      await queueProfileBackfill(
        profileBackfillQueue,
        backfill.id,
        backfill.pageNumber,
      );
      return reply.code(202).send({
        profile: serializeAutomaticProfile(scheduledProfile ?? profile),
        backfill: serializeProfileBackfill(queuedBackfill ?? backfill),
      });
    } catch (error) {
      request.log.error(error, 'Could not retry profile archive');
      throw new ProfileArchiveQueueError(
        'Profile archive could not be retried',
      );
    }
  });
}
