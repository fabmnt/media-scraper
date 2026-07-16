import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import {
  COLLECTION_QUEUE_NAME,
  createCollectionSchema,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { collections, type Database } from '@media-scraper/database';
import { serializeCollection } from '../serialization.js';

interface CollectionRoutesOptions {
  db: Database;
  queue: Queue<CollectionJobPayload>;
}

export async function collectionRoutes(
  app: FastifyInstance,
  { db, queue }: CollectionRoutesOptions,
) {
  app.get('/', async () => {
    const rows = await db
      .select()
      .from(collections)
      .orderBy(desc(collections.createdAt));
    return rows.map(serializeCollection);
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
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
        );
      } catch (error) {
        await db
          .update(collections)
          .set({
            status: 'failed',
            errorMessage:
              error instanceof Error ? error.message : 'Queue unavailable',
            updatedAt: new Date(),
          })
          .where(eq(collections.id, collection.id));
        throw error;
      }

      return reply.code(202).send(serializeCollection(collection));
    },
  );

  app.post('/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [collection] = await db
      .update(collections)
      .set({ status: 'queued', errorMessage: null, updatedAt: new Date() })
      .where(eq(collections.id, id))
      .returning();
    if (!collection)
      return reply.code(404).send({ message: 'Collection not found' });

    try {
      await queue.add(COLLECTION_QUEUE_NAME, {
        collectionId: collection.id,
        platform: collection.platform,
        url: collection.sourceUrl,
      });
    } catch (error) {
      const [failedCollection] = await db
        .update(collections)
        .set({
          status: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Queue unavailable',
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
  });
}
