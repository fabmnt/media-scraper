import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { loadWorkerConfig, mediaStorageOptions } from '@media-scraper/config';
import {
  createDatabase,
  enqueueAssetCleanup,
  mediaAssets,
} from '@media-scraper/database';
import { createThumbnail } from '@media-scraper/media-processing';
import {
  MediaStorage,
  StorageUploadError,
  type StoredAssetLocation,
} from '@media-scraper/storage';
import { readFileMetadata } from './file-metadata.js';

const TEMPORARY_DIRECTORY_PREFIX = '.thumbnail-backfill-';
const THUMBNAIL_POSITION_OFFSET = 1;

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL);
const storage = new MediaStorage(mediaStorageOptions(config));
const shutdownController = new AbortController();

process.once('SIGINT', () => shutdownController.abort());
process.once('SIGTERM', () => shutdownController.abort());

const thumbnailAssets = alias(mediaAssets, 'thumbnail_assets');

async function downloadAsset(
  storageKey: string,
  destination: string,
  signal: AbortSignal,
) {
  const url = await storage.createReadUrl(storageKey);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `Unable to download source asset: HTTP ${String(response.status)}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    createWriteStream(destination),
    { signal },
  );
}

try {
  const originals = await database.db
    .select({
      durationSeconds: mediaAssets.durationSeconds,
      fileName: mediaAssets.fileName,
      id: mediaAssets.id,
      mediaItemId: mediaAssets.mediaItemId,
      position: mediaAssets.position,
      relativePath: mediaAssets.relativePath,
      storageKey: mediaAssets.storageKey,
    })
    .from(mediaAssets)
    .leftJoin(
      thumbnailAssets,
      eq(thumbnailAssets.thumbnailForAssetId, mediaAssets.id),
    )
    .where(
      and(
        eq(mediaAssets.type, 'video'),
        isNull(mediaAssets.thumbnailForAssetId),
        isNull(thumbnailAssets.id),
      ),
    );
  let createdCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const asset of originals) {
    const temporaryDirectory = await mkdtemp(
      join(storage.mediaRoot, TEMPORARY_DIRECTORY_PREFIX),
    );
    let thumbnailPath: string | undefined;
    let storedLocation: StoredAssetLocation | undefined;
    let inserted = false;

    try {
      shutdownController.signal.throwIfAborted();
      const sourcePath = asset.relativePath
        ? storage.localPath(asset.relativePath)
        : asset.storageKey
          ? join(temporaryDirectory, basename(asset.fileName))
          : undefined;
      if (!sourcePath) {
        throw new Error(`Asset ${asset.id} has an invalid storage location`);
      }
      if (asset.storageKey) {
        await downloadAsset(
          asset.storageKey,
          sourcePath,
          shutdownController.signal,
        );
      }

      const thumbnail = await createThumbnail(
        {
          absolutePath: sourcePath,
          durationSeconds: asset.durationSeconds,
          type: 'video',
        },
        asset.storageKey ? temporaryDirectory : storage.mediaRoot,
        shutdownController.signal,
        (error) => {
          console.warn(
            `Thumbnail generation failed for asset ${asset.id}`,
            error,
          );
        },
      );
      if (!thumbnail) {
        failedCount += 1;
        continue;
      }

      thumbnailPath = thumbnail.absolutePath;
      const metadata = await readFileMetadata(thumbnailPath);
      storedLocation = await storage.store(
        thumbnailPath,
        metadata.contentHash,
        metadata.mimeType,
        shutdownController.signal,
      );
      const [thumbnailAsset] = await database.db
        .insert(mediaAssets)
        .values({
          ...storedLocation,
          ...metadata,
          fileName: basename(thumbnailPath),
          mediaItemId: asset.mediaItemId,
          position: -(asset.position + THUMBNAIL_POSITION_OFFSET),
          thumbnailForAssetId: asset.id,
          type: 'image',
        })
        .onConflictDoNothing({ target: mediaAssets.thumbnailForAssetId })
        .returning({ id: mediaAssets.id });
      inserted = thumbnailAsset !== undefined;

      if (inserted) {
        createdCount += 1;
        console.info(`Created thumbnail for asset ${asset.id}`);
      } else {
        skippedCount += 1;
        if (storedLocation.storageKey) {
          await enqueueAssetCleanup(database.db, [storedLocation]);
        }
      }
    } catch (error) {
      failedCount += 1;
      if (error instanceof StorageUploadError) {
        storedLocation = error.location;
      }
      if (storedLocation?.storageKey) {
        await enqueueAssetCleanup(database.db, [storedLocation]).catch(
          (cleanupError: unknown) => {
            console.error(
              `Failed to queue cleanup for thumbnail of asset ${asset.id}`,
              cleanupError,
            );
          },
        );
      }
      console.error(`Thumbnail backfill failed for asset ${asset.id}`, error);
    } finally {
      if (!inserted && thumbnailPath && storedLocation?.relativePath) {
        await rm(thumbnailPath, { force: true }).catch(() => undefined);
      }
      await rm(temporaryDirectory, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }

  console.info(
    `Thumbnail backfill completed: ${String(createdCount)} created, ${String(skippedCount)} already completed, ${String(failedCount)} failed`,
  );
  if (failedCount > 0) process.exitCode = 1;
} finally {
  await database.close();
  storage.close();
}
