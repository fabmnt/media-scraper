import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  collectionStatusSchema,
  COLLECTION_QUEUE_NAME,
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
const RETAINED_JOB_COUNT = 1_000;
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
const jobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: RETAINED_JOB_COUNT },
  removeOnFail: { count: RETAINED_JOB_COUNT },
};

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
          jobOptions,
        );
      } catch (error) {
        await db
          .update(collections)
          .set({
            status: 'failed',
            errorMessage: errorMessage(error),
            updatedAt: new Date(),
          })
          .where(eq(collections.id, collection.id));
        throw error;
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
      await queue.add(
        COLLECTION_QUEUE_NAME,
        {
          collectionId: collection.id,
          platform: collection.platform,
          url: collection.sourceUrl,
        },
        jobOptions,
      );
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
