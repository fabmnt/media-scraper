import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerConfig, mediaStorageOptions } from '@media-scraper/config';
import { createDatabase } from '@media-scraper/database';
import {
  COLLECTION_QUEUE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { MediaStorage } from '@media-scraper/storage';
import { processCollection } from './process-collection.js';

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const shutdownController = new AbortController();
const storage = new MediaStorage(mediaStorageOptions(config));
const worker = new Worker<CollectionJobPayload>(
  COLLECTION_QUEUE_NAME,
  async (job) =>
    processCollection(job.data, {
      credentialsRoot: config.CREDENTIALS_ROOT,
      db: database.db,
      extractionTimeoutMs: config.EXTRACTION_TIMEOUT_MS,
      imageMaxDimension: config.IMAGE_MAX_DIMENSION,
      isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      maxAssetBytes: config.MAX_ASSET_BYTES,
      maxCollectionBytes: config.MAX_COLLECTION_BYTES,
      maxMediaStorageBytes: config.MAX_MEDIA_STORAGE_BYTES,
      mediaRoot: config.MEDIA_ROOT,
      metadataConcurrency: config.METADATA_CONCURRENCY,
      optimizationTimeoutMs: config.OPTIMIZATION_TIMEOUT_MS,
      retentionTargetPercent: config.MEDIA_RETENTION_TARGET_PERCENT,
      retentionTriggerPercent: config.MEDIA_RETENTION_TRIGGER_PERCENT,
      signal: shutdownController.signal,
      storage,
      videoMaxDimension: config.VIDEO_MAX_DIMENSION,
    }),
  { connection: redis, concurrency: 1 },
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
worker.on('error', (error) => {
  console.error('Collection worker error', error);
});

let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  shutdownPromise ??= (async () => {
    shutdownController.abort();
    const failures: unknown[] = [];
    for (const close of [
      () => worker.close(),
      () => redis.quit(),
      () => database.close(),
      () => storage.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more shutdown steps failed');
    }
  })().catch((error: unknown) => {
    console.error('Worker shutdown failed', error);
    process.exitCode = 1;
  });
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
