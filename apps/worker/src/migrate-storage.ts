import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { loadWorkerConfig, mediaStorageOptions } from '@media-scraper/config';
import {
  createDatabase,
  enqueueAssetCleanup,
  mediaAssets,
} from '@media-scraper/database';
import { MediaStorage, type StoredAssetLocation } from '@media-scraper/storage';

const config = loadWorkerConfig();
const storage = new MediaStorage(mediaStorageOptions(config));
if (storage.driver !== 's3') {
  throw new Error('Set MEDIA_STORAGE_DRIVER=s3 before migrating local media');
}

const shutdownController = new AbortController();
process.once('SIGINT', () => shutdownController.abort());
process.once('SIGTERM', () => shutdownController.abort());

const database = createDatabase(config.DATABASE_URL);
try {
  const localAssets = await database.db
    .select({
      contentHash: mediaAssets.contentHash,
      id: mediaAssets.id,
      mimeType: mediaAssets.mimeType,
      relativePath: mediaAssets.relativePath,
    })
    .from(mediaAssets)
    .where(
      and(isNotNull(mediaAssets.relativePath), isNull(mediaAssets.storageKey)),
    );
  let migratedCount = 0;
  let migratedBytes = 0;

  for (const asset of localAssets) {
    shutdownController.signal.throwIfAborted();
    if (!asset.relativePath) continue;
    const absolutePath = storage.localPath(asset.relativePath);
    if (!absolutePath) {
      throw new Error(`Asset ${asset.id} has an invalid local path`);
    }

    let location: StoredAssetLocation | undefined;
    try {
      location = await storage.store(
        absolutePath,
        asset.contentHash,
        asset.mimeType,
        shutdownController.signal,
      );
      if (!location.storageKey) {
        throw new Error('S3 upload did not return a key');
      }
      const storageKey = location.storageKey;

      const updatedAsset = await database.db.transaction(
        async (transaction) => {
          const [updated] = await transaction
            .update(mediaAssets)
            .set({ relativePath: null, storageKey })
            .where(
              and(
                eq(mediaAssets.id, asset.id),
                isNotNull(mediaAssets.relativePath),
                isNull(mediaAssets.storageKey),
              ),
            )
            .returning({ sizeBytes: mediaAssets.sizeBytes });
          if (updated) {
            await enqueueAssetCleanup(transaction, [
              { relativePath: asset.relativePath, storageKey: null },
            ]);
          }
          return updated;
        },
      );
      if (!updatedAsset) {
        await enqueueAssetCleanup(database.db, [location]);
        continue;
      }

      migratedCount += 1;
      migratedBytes += updatedAsset.sizeBytes;
      console.info(`Migrated asset ${asset.id}`);
    } catch (error) {
      if (location?.storageKey) {
        try {
          await enqueueAssetCleanup(database.db, [location]);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Storage migration failed and cleanup could not be queued',
          );
        }
      }
      throw error;
    }
  }

  console.info(
    `Storage migration completed: ${String(migratedCount)} assets, ${String(migratedBytes)} bytes`,
  );
} finally {
  await database.close();
  storage.close();
}
