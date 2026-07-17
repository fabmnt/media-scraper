import { rm, rmdir } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { loadWorkerConfig, mediaStorageOptions } from '@media-scraper/config';
import { createDatabase, mediaAssets } from '@media-scraper/database';
import { MediaStorage } from '@media-scraper/storage';

async function removeEmptyParents(root: string, filePath: string) {
  let directory = dirname(filePath);
  while (directory.startsWith(`${root}${sep}`)) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

const config = loadWorkerConfig();
const storage = new MediaStorage(mediaStorageOptions(config));
if (storage.driver !== 's3') {
  throw new Error('Set MEDIA_STORAGE_DRIVER=s3 before migrating local media');
}

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
    if (!asset.relativePath) continue;
    const absolutePath = storage.localPath(asset.relativePath);
    if (!absolutePath) {
      throw new Error(`Asset ${asset.id} has an invalid local path`);
    }
    const location = await storage.store(
      absolutePath,
      asset.contentHash,
      asset.mimeType,
    );
    if (!location.storageKey) throw new Error('S3 upload did not return a key');

    const [updatedAsset] = await database.db
      .update(mediaAssets)
      .set({ relativePath: null, storageKey: location.storageKey })
      .where(
        and(
          eq(mediaAssets.id, asset.id),
          isNotNull(mediaAssets.relativePath),
          isNull(mediaAssets.storageKey),
        ),
      )
      .returning({ sizeBytes: mediaAssets.sizeBytes });
    if (!updatedAsset) continue;

    await rm(absolutePath, { force: true });
    await removeEmptyParents(storage.mediaRoot, absolutePath);
    migratedCount += 1;
    migratedBytes += updatedAsset.sizeBytes;
    console.info(`Migrated asset ${asset.id}`);
  }

  console.info(
    `Storage migration completed: ${String(migratedCount)} assets, ${String(migratedBytes)} bytes`,
  );
} finally {
  await database.close();
  storage.close();
}
