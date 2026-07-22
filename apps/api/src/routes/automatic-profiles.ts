import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  createAutomaticProfileSchema,
  HIGHLIGHT_SUPPORTED_PLATFORMS,
  STORY_SUPPORTED_PLATFORMS,
  updateAutomaticProfileSchema,
  type AutomaticProfileJobPayload,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';
import {
  automaticProfiles,
  profileBackfills,
  type Database,
} from '@media-scraper/database';
import {
  queueAutomaticProfileCheck,
  removeAutomaticProfileScheduler,
  upsertAutomaticProfileScheduler,
} from '../automatic-profile-scheduler.js';
import { isUniqueViolation } from '../database-errors.js';
import { queueProfileBackfill } from '../profile-backfill-queue.js';
import { serializeAutomaticProfile } from '../serialization.js';

interface AutomaticProfileRoutesOptions {
  db: Database;
  profileBackfillQueue: Queue<ProfileBackfillJobPayload>;
  queue: Queue<AutomaticProfileJobPayload>;
}

const automaticProfileParamsSchema = z.object({ id: z.uuid() });

class AutomaticProfileConflictError extends Error {
  readonly statusCode = 409;
}

class AutomaticProfileQueueError extends Error {
  readonly statusCode = 503;
}

class AutomaticProfileOptionUnsupportedError extends Error {
  readonly statusCode = 400;
}

export async function automaticProfileRoutes(
  app: FastifyInstance,
  { db, profileBackfillQueue, queue }: AutomaticProfileRoutesOptions,
) {
  app.get('/', async () => {
    const profiles = await db
      .select()
      .from(automaticProfiles)
      .orderBy(asc(automaticProfiles.createdAt));
    return profiles.map(serializeAutomaticProfile);
  });

  app.post('/', async (request, reply) => {
    const input = createAutomaticProfileSchema.parse(request.body);
    let profile: typeof automaticProfiles.$inferSelect;
    try {
      const [createdProfile] = await db
        .insert(automaticProfiles)
        .values(input)
        .returning();
      if (!createdProfile)
        throw new Error('Failed to create automatic profile');
      profile = createdProfile;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AutomaticProfileConflictError(
          'Automatic collection is already configured for this profile',
        );
      }
      throw error;
    }

    try {
      const nextCheckAt = await upsertAutomaticProfileScheduler(queue, profile);
      const [scheduledProfile] = await db
        .update(automaticProfiles)
        .set({ nextCheckAt, updatedAt: new Date() })
        .where(eq(automaticProfiles.id, profile.id))
        .returning();
      profile = scheduledProfile ?? profile;
    } catch (error) {
      request.log.error(error, 'Could not schedule automatic profile');
      throw new AutomaticProfileQueueError(
        'Automatic collection was saved but could not be scheduled',
      );
    }

    return reply.code(201).send(serializeAutomaticProfile(profile));
  });

  app.patch('/:id', async (request) => {
    const { id } = automaticProfileParamsSchema.parse(request.params);
    const input = updateAutomaticProfileSchema.parse(request.body);
    const [existingProfile] = await db
      .select({ platform: automaticProfiles.platform })
      .from(automaticProfiles)
      .where(eq(automaticProfiles.id, id));
    if (!existingProfile) {
      const error = new Error('Automatic profile not found');
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    if (
      input.includeStories &&
      !STORY_SUPPORTED_PLATFORMS.includes(existingProfile.platform)
    ) {
      throw new AutomaticProfileOptionUnsupportedError(
        'Stories are only supported for Instagram and TikTok profiles',
      );
    }
    if (
      input.includeHighlights &&
      !HIGHLIGHT_SUPPORTED_PLATFORMS.includes(existingProfile.platform)
    ) {
      throw new AutomaticProfileOptionUnsupportedError(
        'Story Highlights are only supported for Instagram profiles',
      );
    }

    const [profile] = await db
      .update(automaticProfiles)
      .set({
        ...input,
        ...(input.enabled === true ||
        input.intervalMinutes !== undefined ||
        input.includeStories !== undefined ||
        input.includeHighlights !== undefined
          ? { lastError: null, retryAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(automaticProfiles.id, id))
      .returning();
    if (!profile) throw new Error('Automatic profile was not updated');

    let scheduledProfile: typeof automaticProfiles.$inferSelect | undefined;
    try {
      const nextCheckAt = profile.enabled
        ? await upsertAutomaticProfileScheduler(queue, profile)
        : null;
      if (!profile.enabled) {
        await removeAutomaticProfileScheduler(queue, profile.id);
      }
      [scheduledProfile] = await db
        .update(automaticProfiles)
        .set({ nextCheckAt, updatedAt: new Date() })
        .where(eq(automaticProfiles.id, profile.id))
        .returning();
    } catch (error) {
      request.log.error(error, 'Could not update automatic profile schedule');
      throw new AutomaticProfileQueueError(
        'Automatic collection settings were saved but the schedule could not be updated',
      );
    }

    if (input.enabled === true) {
      const [backfill] = await db
        .select({
          id: profileBackfills.id,
          pageNumber: profileBackfills.pageNumber,
        })
        .from(profileBackfills)
        .where(
          and(
            eq(profileBackfills.automaticProfileId, profile.id),
            inArray(profileBackfills.status, ['queued', 'processing']),
          ),
        );
      if (backfill) {
        try {
          await queueProfileBackfill(
            profileBackfillQueue,
            backfill.id,
            backfill.pageNumber,
          );
        } catch (error) {
          request.log.error(error, 'Could not resume profile archive');
          throw new AutomaticProfileQueueError(
            'Automatic collection was resumed but the profile archive could not be queued',
          );
        }
      }
    }
    return serializeAutomaticProfile(scheduledProfile ?? profile);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = automaticProfileParamsSchema.parse(request.params);
    const [profile] = await db
      .update(automaticProfiles)
      .set({ enabled: false, nextCheckAt: null, updatedAt: new Date() })
      .where(eq(automaticProfiles.id, id))
      .returning({ id: automaticProfiles.id });
    if (!profile) {
      return reply.code(404).send({ message: 'Automatic profile not found' });
    }
    try {
      await removeAutomaticProfileScheduler(queue, profile.id);
    } catch (error) {
      request.log.error(error, 'Could not remove automatic profile schedule');
      throw new AutomaticProfileQueueError(
        'Automatic collection could not be removed. Try again shortly.',
      );
    }
    const [deletedProfile] = await db
      .delete(automaticProfiles)
      .where(eq(automaticProfiles.id, profile.id))
      .returning({ id: automaticProfiles.id });
    return deletedProfile
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Automatic profile not found' });
  });

  app.post('/:id/run', async (request, reply) => {
    const { id } = automaticProfileParamsSchema.parse(request.params);
    const [profile] = await db
      .select({ id: automaticProfiles.id })
      .from(automaticProfiles)
      .where(
        and(eq(automaticProfiles.id, id), eq(automaticProfiles.enabled, true)),
      );
    if (!profile) {
      return reply
        .code(404)
        .send({ message: 'Enabled automatic profile not found' });
    }

    const [failedBackfill] = await db
      .select({
        id: profileBackfills.id,
        pageNumber: profileBackfills.pageNumber,
      })
      .from(profileBackfills)
      .where(
        and(
          eq(profileBackfills.automaticProfileId, profile.id),
          eq(profileBackfills.status, 'failed'),
        ),
      );
    if (failedBackfill) {
      const [resumedBackfill] = await db
        .update(profileBackfills)
        .set({ status: 'queued', lastError: null, updatedAt: new Date() })
        .where(
          and(
            eq(profileBackfills.id, failedBackfill.id),
            eq(profileBackfills.status, 'failed'),
          ),
        )
        .returning({ id: profileBackfills.id });
      if (resumedBackfill) {
        try {
          await queueProfileBackfill(
            profileBackfillQueue,
            failedBackfill.id,
            failedBackfill.pageNumber,
          );
        } catch (error) {
          request.log.error(error, 'Could not resume profile archive');
          await db
            .update(profileBackfills)
            .set({
              lastError: 'Profile archive could not be resumed',
              status: 'failed',
              updatedAt: new Date(),
            })
            .where(eq(profileBackfills.id, failedBackfill.id));
          throw new AutomaticProfileQueueError(
            'Profile archive could not be resumed',
          );
        }
      }
    }

    try {
      await queueAutomaticProfileCheck(queue, profile.id, true);
    } catch (error) {
      request.log.error(error, 'Could not queue automatic profile check');
      throw new AutomaticProfileQueueError(
        'Automatic profile check could not be queued',
      );
    }
    return reply.code(202).send({ queued: true });
  });

  app.post('/:id/archive', async (request, reply) => {
    const { id } = automaticProfileParamsSchema.parse(request.params);
    const [profile] = await db
      .select()
      .from(automaticProfiles)
      .where(
        and(eq(automaticProfiles.id, id), eq(automaticProfiles.enabled, true)),
      );
    if (!profile) {
      return reply
        .code(404)
        .send({ message: 'Enabled automatic profile not found' });
    }

    const [existingBackfill] = await db
      .select()
      .from(profileBackfills)
      .where(eq(profileBackfills.automaticProfileId, profile.id));
    const [backfill] = existingBackfill
      ? await db
          .update(profileBackfills)
          .set({
            collectionsQueued: 0,
            completedAt: null,
            cursor: null,
            includeHighlights: profile.includeHighlights,
            includeStories: profile.includeStories,
            itemsDiscovered: 0,
            lastError: null,
            pageNumber: 0,
            startedAt: null,
            status: 'queued',
            updatedAt: new Date(),
          })
          .where(eq(profileBackfills.id, existingBackfill.id))
          .returning()
      : await db
          .insert(profileBackfills)
          .values({
            automaticProfileId: profile.id,
            includeHighlights: profile.includeHighlights,
            includeStories: profile.includeStories,
          })
          .returning();
    if (!backfill) throw new Error('Failed to start profile archive');

    try {
      await queueProfileBackfill(profileBackfillQueue, backfill.id);
    } catch (error) {
      request.log.error(error, 'Could not queue profile archive');
      await db
        .update(profileBackfills)
        .set({
          lastError: 'Profile archive could not be queued',
          status: 'failed',
          updatedAt: new Date(),
        })
        .where(eq(profileBackfills.id, backfill.id));
      throw new AutomaticProfileQueueError(
        'Profile archive could not be queued',
      );
    }
    return reply.code(202).send({ queued: true });
  });
}
