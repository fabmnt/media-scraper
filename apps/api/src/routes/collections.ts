import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  collectionStatusSchema,
  COLLECTION_JOB_OPTIONS,
  COLLECTION_QUEUE_NAME,
  createCollectionBatchSchema,
  createCollectionSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CollectionJobPayload,
  type Page,
  type Collection,
} from '@media-scraper/shared';
import { collections, type Database } from '@media-scraper/database';
import { serializeCollection } from '../serialization.js';

interface CollectionRoutesOptions {
  db: Database;
  queue: Queue<CollectionJobPayload>;
}

const MAX_ERROR_LENGTH = 4_000;
const collectionQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: collectionStatusSchema.optional(),
});
const collectionParamsSchema = z.object({ id: z.uuid() });
function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : 'Queue unavailable').slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

export async function collectionRoutes(
  app: FastifyInstance,
  { db, queue }: CollectionRoutesOptions,
) {
  app.get('/', async (request): Promise<Page<Collection>> => {
    const query = collectionQuerySchema.parse(request.query);
    const rows = await db
      .select()
      .from(collections)
      .where(query.status ? eq(collections.status, query.status) : undefined)
      .orderBy(desc(collections.createdAt))
      .limit(query.limit + 1)
      .offset(query.offset);
    const hasMore = rows.length > query.limit;
    return {
      items: rows.slice(0, query.limit).map(serializeCollection),
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  });

  app.post(
    '/batch',
    { schema: { tags: ['collections'] } },
    async (request, reply) => {
      const input = createCollectionBatchSchema.parse(request.body);
      const pendingCollections = input.items.map((item) => ({
        id: randomUUID(),
        platform: item.platform,
        sourceUrl: item.url,
      }));
      const createdCollections = await db
        .insert(collections)
        .values(pendingCollections)
        .returning();

      const jobs = pendingCollections.map((collection) => ({
        name: COLLECTION_QUEUE_NAME,
        data: {
          collectionId: collection.id,
          platform: collection.platform,
          url: collection.sourceUrl,
        },
        opts: { ...COLLECTION_JOB_OPTIONS, jobId: collection.id },
      }));
      try {
        await queue.addBulk(jobs);
      } catch (error) {
        const recoveryResults = await Promise.allSettled(
          jobs.map(async (job) => {
            try {
              await queue.add(job.name, job.data, job.opts);
            } catch (recoveryError) {
              const existingJob = await queue.getJob(job.opts.jobId);
              if (!existingJob) throw recoveryError;
            }
          }),
        );
        const failedCollectionIds = recoveryResults.flatMap((result, index) => {
          if (result.status === 'fulfilled') return [];
          const collection = pendingCollections[index];
          return collection ? [collection.id] : [];
        });
        if (failedCollectionIds.length > 0) {
          const failedCollections = await db
            .update(collections)
            .set({
              status: 'failed',
              errorMessage: errorMessage(error),
              updatedAt: new Date(),
            })
            .where(inArray(collections.id, failedCollectionIds))
            .returning();
          const failedCollectionsById = new Map(
            failedCollections.map((collection) => [collection.id, collection]),
          );
          const batchCollections = createdCollections.map(
            (collection) =>
              failedCollectionsById.get(collection.id) ?? collection,
          );
          if (failedCollectionIds.length === pendingCollections.length) {
            return reply.code(503).send({
              message: 'Collections could not be queued',
              collections: batchCollections.map(serializeCollection),
            });
          }
          return reply
            .code(202)
            .send(batchCollections.map(serializeCollection));
        }
      }

      return reply.code(202).send(createdCollections.map(serializeCollection));
    },
  );

  app.post(
    '/',
    { schema: { tags: ['collections'] } },
    async (request, reply) => {
      const input = createCollectionSchema.parse(request.body);
      const [collection] = await db
        .insert(collections)
        .values({ sourceUrl: input.url, platform: input.platform })
        .returning();
      if (!collection) throw new Error('Failed to create collection');

      try {
        await queue.add(
          COLLECTION_QUEUE_NAME,
          { ...input, collectionId: collection.id },
          { ...COLLECTION_JOB_OPTIONS, jobId: collection.id },
        );
      } catch (error) {
        const [failedCollection] = await db
          .update(collections)
          .set({
            status: 'failed',
            errorMessage: errorMessage(error),
            updatedAt: new Date(),
          })
          .where(eq(collections.id, collection.id))
          .returning();
        return reply.code(503).send({
          message: 'Collection could not be queued',
          collection: failedCollection
            ? serializeCollection(failedCollection)
            : undefined,
        });
      }

      return reply.code(202).send(serializeCollection(collection));
    },
  );

  app.post('/:id/retry', async (request, reply) => {
    const { id } = collectionParamsSchema.parse(request.params);
    const [collection] = await db
      .update(collections)
      .set({ status: 'queued', errorMessage: null, updatedAt: new Date() })
      .where(and(eq(collections.id, id), eq(collections.status, 'failed')))
      .returning();
    if (!collection) {
      const [existing] = await db
        .select({ status: collections.status })
        .from(collections)
        .where(eq(collections.id, id));
      return existing
        ? reply
            .code(409)
            .send({ message: 'Only failed collections can be retried' })
        : reply.code(404).send({ message: 'Collection not found' });
    }

    try {
      const existingJob = await queue.getJob(collection.id);
      const existingJobState = await existingJob?.getState();
      if (
        existingJob &&
        (existingJobState === 'failed' || existingJobState === 'completed')
      ) {
        await existingJob.remove();
      }
      if (
        !existingJob ||
        existingJobState === 'failed' ||
        existingJobState === 'completed' ||
        existingJobState === 'unknown'
      ) {
        await queue.add(
          COLLECTION_QUEUE_NAME,
          {
            collectionId: collection.id,
            platform: collection.platform,
            url: collection.sourceUrl,
          },
          { ...COLLECTION_JOB_OPTIONS, jobId: collection.id },
        );
      }
    } catch (error) {
      const [failedCollection] = await db
        .update(collections)
        .set({
          status: 'failed',
          errorMessage: errorMessage(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(collections.id, collection.id),
            eq(collections.status, 'queued'),
          ),
        )
        .returning();
      return reply.code(503).send({
        message: 'Collection could not be queued',
        collection: failedCollection
          ? serializeCollection(failedCollection)
          : undefined,
      });
    }
    return reply.code(202).send(serializeCollection(collection));
  });
}
