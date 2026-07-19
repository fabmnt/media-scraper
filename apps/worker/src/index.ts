import { availableParallelism, totalmem } from 'node:os';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadWorkerConfig, mediaStorageOptions } from '@media-scraper/config';
import { createDatabase } from '@media-scraper/database';
import {
  AUTOMATIC_PROFILE_QUEUE_NAME,
  COLLECTION_QUEUE_NAME,
  PROFILE_BACKFILL_QUEUE_NAME,
  type AutomaticProfileJobPayload,
  type CollectionJobPayload,
  type ProfileBackfillJobPayload,
} from '@media-scraper/shared';
import { MediaStorage } from '@media-scraper/storage';
import { reconcileAutomaticProfileSchedulers } from './automatic-profile-scheduler.js';
import { reconcileQueuedCollections } from './collection-queue-reconciliation.js';
import { processAutomaticProfile } from './process-automatic-profile.js';
import { processCollection } from './process-collection.js';
import { processProfileBackfill } from './process-profile-backfill.js';
import { reconcileProfileBackfills } from './profile-backfill-reconciliation.js';
import { processMediaMaintenance } from './storage-retention.js';

const AUTO_COLLECTION_CONCURRENCY_LIMIT = 4;
const BYTES_PER_GIBIBYTE = 1024 ** 3;
const CPU_THREADS_PER_COLLECTION = 2;
const MAINTENANCE_INTERVAL_MS = 30_000;
const PROFILE_CHECK_RATE_LIMIT_MS = 5_000;
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
const collectionQueue = new Queue<CollectionJobPayload>(COLLECTION_QUEUE_NAME, {
  connection: redis,
});
const automaticProfileQueue = new Queue<AutomaticProfileJobPayload>(
  AUTOMATIC_PROFILE_QUEUE_NAME,
  { connection: redis },
);
const profileBackfillQueue = new Queue<ProfileBackfillJobPayload>(
  PROFILE_BACKFILL_QUEUE_NAME,
  { connection: redis },
);
collectionQueue.on('error', (error) => {
  console.error('Collection queue error', error);
});
automaticProfileQueue.on('error', (error) => {
  console.error('Automatic profile queue error', error);
});
profileBackfillQueue.on('error', (error) => {
  console.error('Profile archive queue error', error);
});
const [
  reconciledCollectionCount,
  reconciledProfileCount,
  reconciledProfileBackfillCount,
] = await Promise.all([
  reconcileQueuedCollections(database.db, collectionQueue),
  reconcileAutomaticProfileSchedulers(database.db, automaticProfileQueue),
  reconcileProfileBackfills(database.db, profileBackfillQueue),
]);
console.info(
  `Reconciled ${String(reconciledCollectionCount)} queued collections, ${String(reconciledProfileCount)} automatic profile schedules, and ${String(reconciledProfileBackfillCount)} profile archives`,
);

const collectionWorker = new Worker<CollectionJobPayload>(
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
const profileBackfillWorker = new Worker<ProfileBackfillJobPayload>(
  PROFILE_BACKFILL_QUEUE_NAME,
  async (job) =>
    processProfileBackfill(job.data, {
      collectionQueue,
      credentialsRoot: config.CREDENTIALS_ROOT,
      db: database.db,
      isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      queue: profileBackfillQueue,
      signal: shutdownController.signal,
    }),
  {
    connection: redis,
    concurrency: 1,
    limiter: { max: 1, duration: PROFILE_CHECK_RATE_LIMIT_MS },
  },
);
const automaticProfileWorker = new Worker<AutomaticProfileJobPayload>(
  AUTOMATIC_PROFILE_QUEUE_NAME,
  async (job) =>
    processAutomaticProfile(job.data.profileId, {
      collectionQueue,
      credentialsRoot: config.CREDENTIALS_ROOT,
      db: database.db,
      force: job.data.force ?? false,
      signal: shutdownController.signal,
    }),
  {
    connection: redis,
    concurrency: 1,
    limiter: { max: 1, duration: PROFILE_CHECK_RATE_LIMIT_MS },
  },
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

collectionWorker.on('completed', (job) => {
  console.info(`Collection ${job.data.collectionId} completed`);
  void runMaintenance().catch((error) =>
    console.error('Post-collection media maintenance failed', error),
  );
});
collectionWorker.on('failed', (job, error) => {
  console.error(
    `Collection ${job?.data.collectionId ?? 'unknown'} failed`,
    error,
  );
});
collectionWorker.on('error', (error) => {
  console.error('Collection worker error', error);
});

profileBackfillWorker.on('completed', (job, result) => {
  console.info(
    `Profile archive ${job.data.backfillId} page ${String(job.data.pageNumber)} processed; ${String(result.collectionsQueued)} collections queued`,
  );
});
profileBackfillWorker.on('failed', (job, error) => {
  console.error(
    `Profile archive ${job?.data.backfillId ?? 'unknown'} failed`,
    error,
  );
});
profileBackfillWorker.on('error', (error) => {
  console.error('Profile archive worker error', error);
});

automaticProfileWorker.on('completed', (job, result) => {
  console.info(
    `Automatic profile ${job.data.profileId} checked; ${String(result.queuedCollections)} collections queued`,
  );
});
automaticProfileWorker.on('failed', (job, error) => {
  console.error(
    `Automatic profile ${job?.data.profileId ?? 'unknown'} check failed`,
    error,
  );
});
automaticProfileWorker.on('error', (error) => {
  console.error('Automatic profile worker error', error);
});

let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  shutdownPromise ??= (async () => {
    clearInterval(maintenanceInterval);
    shutdownController.abort();
    const failures: unknown[] = [];
    for (const close of [
      () =>
        Promise.all([
          collectionWorker.close(),
          automaticProfileWorker.close(),
          profileBackfillWorker.close(),
        ]),
      () => maintenancePromise?.catch(() => undefined),
      () =>
        Promise.all([
          collectionQueue.close(),
          automaticProfileQueue.close(),
          profileBackfillQueue.close(),
        ]),
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
