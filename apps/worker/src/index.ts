import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerConfig } from '@media-scraper/config';
import { createDatabase } from '@media-scraper/database';
import {
  COLLECTION_QUEUE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { processCollection } from './process-collection.js';

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker<CollectionJobPayload>(
  COLLECTION_QUEUE_NAME,
  async ({ data }) =>
    processCollection(data, {
      credentialsRoot: config.CREDENTIALS_ROOT,
      db: database.db,
      mediaRoot: config.MEDIA_ROOT,
      maxAssetBytes: config.MAX_ASSET_BYTES,
    }),
  { connection: redis, concurrency: 2 },
);

worker.on('completed', (job) => {
  console.info(`Collection ${job.data.collectionId} completed`);
});
worker.on('failed', (job, error) => {
  console.error(
    `Collection ${job?.data.collectionId ?? 'unknown'} failed`,
    error,
  );
});

async function shutdown() {
  await worker.close();
  await redis.quit();
  await database.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
