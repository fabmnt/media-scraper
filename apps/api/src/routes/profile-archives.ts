import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createProfileArchiveSchema,
  type AutomaticProfileJobPayload,
  type ProfileArchive,
  type ProfileBackfillJobPayload,
  type ProfileCollectionProgress,
} from '@media-scraper/shared';
import {
  automaticProfiles,
  collections,
  profileBackfills,
  type Database,
} from '@media-scraper/database';
import { upsertAutomaticProfileScheduler } from '../automatic-profile-scheduler.js';
import { isUniqueViolation } from '../database-errors.js';
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

class ProfileArchiveNotFoundError extends Error {
  readonly statusCode = 404;
}

class ProfileArchiveConflictError extends Error {
  readonly statusCode = 409;
}

class ProfileArchiveQueueError extends Error {
  readonly statusCode = 503;
}

const profileArchiveParamsSchema = z.object({ id: z.uuid() });
const ACTIVE_BACKFILL_STATUSES = new Set(['queued', 'processing']);

const collectionStatusCount = (
  status: 'queued' | 'processing' | 'completed' | 'failed',
) =>
  sql<number>`count(${collections.id}) filter (where ${collections.status} = ${status})`.mapWith(
    Number,
  );

export async function profileArchiveRoutes(
  app: FastifyInstance,
  {
    automaticProfileQueue,
    db,
    profileBackfillQueue,
  }: ProfileArchiveRoutesOptions,
) {
  app.get('/progress', async (): Promise<ProfileCollectionProgress[]> => {
    const rows = await db
      .select({
        backfillId: profileBackfills.id,
        backfillStatus: profileBackfills.status,
        collectionsQueued: profileBackfills.collectionsQueued,
        itemsDiscovered: profileBackfills.itemsDiscovered,
        profileId: automaticProfiles.id,
        platform: automaticProfiles.platform,
        username: automaticProfiles.username,
        completedCollections: collectionStatusCount('completed'),
        failedCollections: collectionStatusCount('failed'),
        processingCollections: collectionStatusCount('processing'),
        queuedCollections: collectionStatusCount('queued'),
      })
      .from(profileBackfills)
      .innerJoin(
        automaticProfiles,
        eq(profileBackfills.automaticProfileId, automaticProfiles.id),
      )
      .leftJoin(
        collections,
        and(
          eq(collections.automaticProfileId, automaticProfiles.id),
          eq(collections.origin, 'automatic'),
        ),
      )
      .groupBy(profileBackfills.id, automaticProfiles.id)
      .orderBy(desc(profileBackfills.createdAt));

    return rows
      .filter(
        (row) =>
          ACTIVE_BACKFILL_STATUSES.has(row.backfillStatus) ||
          row.queuedCollections + row.processingCollections > 0,
      )
      .map((row) => ({
        profile: {
          id: row.profileId,
          platform: row.platform,
          username: row.username,
        },
        backfill: {
          id: row.backfillId,
          status: row.backfillStatus,
          itemsDiscovered: row.itemsDiscovered,
          collectionsQueued: row.collectionsQueued,
        },
        collections: {
          queued: row.queuedCollections,
          processing: row.processingCollections,
          completed: row.completedCollections,
          failed: row.failedCollections,
        },
      }));
  });

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
            includeHighlights: input.includeHighlights,
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
      throw new ProfileArchiveNotFoundError('Profile archive not found');
    }
    const [backfill] = await db
      .select()
      .from(profileBackfills)
      .where(eq(profileBackfills.automaticProfileId, profile.id));
    if (!backfill) {
      throw new ProfileArchiveNotFoundError('Profile archive not found');
    }
    if (!profile.enabled) {
      throw new ProfileArchiveConflictError(
        'Resume automatic collection before retrying this profile archive',
      );
    }

    let scheduledProfile: typeof automaticProfiles.$inferSelect | undefined;
    let queuedBackfill: typeof profileBackfills.$inferSelect | undefined;
    try {
      const nextCheckAt = await upsertAutomaticProfileScheduler(
        automaticProfileQueue,
        profile,
      );
      [scheduledProfile] = await db
        .update(automaticProfiles)
        .set({ nextCheckAt, updatedAt: new Date() })
        .where(eq(automaticProfiles.id, profile.id))
        .returning();
      [queuedBackfill] = await db
        .update(profileBackfills)
        .set({ status: 'queued', lastError: null, updatedAt: new Date() })
        .where(eq(profileBackfills.id, backfill.id))
        .returning();
    } catch (error) {
      request.log.error(error, 'Could not restore profile archive scheduling');
      throw new ProfileArchiveQueueError(
        'Profile archive could not be retried',
      );
    }

    try {
      await queueProfileBackfill(
        profileBackfillQueue,
        backfill.id,
        backfill.pageNumber,
      );
    } catch (error) {
      request.log.error(error, 'Could not requeue profile archive');
      try {
        await db
          .update(profileBackfills)
          .set({
            status: 'failed',
            lastError: 'Profile archive could not be queued',
            updatedAt: new Date(),
          })
          .where(eq(profileBackfills.id, backfill.id));
      } catch (cleanupError) {
        request.log.error(
          cleanupError,
          'Could not record profile archive failure',
        );
      }
      throw new ProfileArchiveQueueError(
        'Profile archive could not be retried',
      );
    }

    return reply.code(202).send({
      profile: serializeAutomaticProfile(scheduledProfile ?? profile),
      backfill: serializeProfileBackfill(queuedBackfill ?? backfill),
    });
  });
}
