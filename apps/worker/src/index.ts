import { availableParallelism, totalmem } from 'node:os';
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
import { processMediaMaintenance } from './storage-retention.js';

const AUTO_COLLECTION_CONCURRENCY_LIMIT = 4;
const BYTES_PER_GIBIBYTE = 1024 ** 3;
const CPU_THREADS_PER_COLLECTION = 2;
const MAINTENANCE_INTERVAL_MS = 30_000;
const MEMORY_PER_COLLECTION_BYTES = 1.5 * BYTES_PER_GIBIBYTE;
const RESERVED_MEMORY_BYTES = 1.5 * BYTES_PER_GIBIBYTE;

const config = loadWorkerConfig();
const cpuCount = availableParallelism();
const constrainedMemoryBytes = process.constrainedMemory();
const memoryLimitBytes =
  constrainedMemoryBytes > 0 && constrainedMemoryBytes <= totalmem()
    ? constrainedMemoryBytes
    : totalmem();
const automaticCollectionConcurrency = Math.max(
  1,
  Math.min(
    AUTO_COLLECTION_CONCURRENCY_LIMIT,
    Math.floor(cpuCount / CPU_THREADS_PER_COLLECTION),
    Math.floor(
      (memoryLimitBytes - RESERVED_MEMORY_BYTES) / MEMORY_PER_COLLECTION_BYTES,
    ),
  ),
);
const collectionConcurrency =
  config.COLLECTION_CONCURRENCY ?? automaticCollectionConcurrency;
const concurrencySource = config.COLLECTION_CONCURRENCY
  ? 'configured override'
  : `${String(cpuCount)} CPUs and ${(memoryLimitBytes / BYTES_PER_GIBIBYTE).toFixed(1)} GiB memory`;
console.info(
  `Collection worker concurrency set to ${String(collectionConcurrency)} (${concurrencySource})`,
);
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
      metadataConcurrency: config.METADATA_CONCURRENCY,
      optimizationTimeoutMs: config.OPTIMIZATION_TIMEOUT_MS,
      signal: shutdownController.signal,
      storage,
      videoMaxDimension: config.VIDEO_MAX_DIMENSION,
    }),
  { connection: redis, concurrency: collectionConcurrency },
);

let maintenancePromise: Promise<void> | undefined;
function runMaintenance() {
  maintenancePromise ??= processMediaMaintenance(database.db, {
    maxStorageBytes: config.MAX_MEDIA_STORAGE_BYTES,
    signal: shutdownController.signal,
    storage,
    targetPercent: config.MEDIA_RETENTION_TARGET_PERCENT,
    triggerPercent: config.MEDIA_RETENTION_TRIGGER_PERCENT,
  }).finally(() => {
    maintenancePromise = undefined;
  });
  return maintenancePromise;
}
const maintenanceInterval = setInterval(() => {
  void runMaintenance().catch((error) =>
    console.error('Media maintenance failed', error),
  );
}, MAINTENANCE_INTERVAL_MS);
maintenanceInterval.unref();
void runMaintenance().catch((error) =>
  console.error('Initial media maintenance failed', error),
);

worker.on('completed', (job) => {
  console.info(`Collection ${job.data.collectionId} completed`);
  void runMaintenance().catch((error) =>
    console.error('Post-collection media maintenance failed', error),
  );
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
    clearInterval(maintenanceInterval);
    shutdownController.abort();
    const failures: unknown[] = [];
    for (const close of [
      () => worker.close(),
      () => maintenancePromise?.catch(() => undefined),
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
