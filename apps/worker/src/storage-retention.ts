import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import type { MediaStorage } from '@media-scraper/storage';
import type { ObsoleteAsset } from './persist-collection.js';

interface RetentionOptions {
  maxStorageBytes: number;
  storage: MediaStorage;
  targetPercent: number;
  triggerPercent: number;
}

async function deleteUnreferencedObjects(
  db: Database,
  storage: MediaStorage,
  storageKeys: readonly string[],
) {
  const uniqueKeys = [...new Set(storageKeys)];
  if (uniqueKeys.length === 0) return;
  const referenced = await db
    .select({ storageKey: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(inArray(mediaAssets.storageKey, uniqueKeys));
  const referencedKeys = new Set(referenced.map((asset) => asset.storageKey));
  await storage.deleteObjects(
    uniqueKeys.filter((storageKey) => !referencedKeys.has(storageKey)),
  );
}

async function deleteMediaItems(
  db: Database,
  storage: MediaStorage,
  itemIds: readonly string[],
) {
  if (itemIds.length === 0) return;
  const assets = await db
    .select({
      fileName: mediaAssets.fileName,
      relativePath: mediaAssets.relativePath,
      storageKey: mediaAssets.storageKey,
    })
    .from(mediaAssets)
    .where(inArray(mediaAssets.mediaItemId, itemIds));
  const trashDirectory = resolve(
    storage.mediaRoot,
    '.trash',
    `retention-${randomUUID()}`,
  );
  const stagedFiles: Array<{ original: string; staged: string }> = [];

  try {
    await mkdir(trashDirectory, { recursive: true });
    for (const [index, asset] of assets.entries()) {
      if (!asset.relativePath) continue;
      const original = storage.localPath(asset.relativePath);
      if (!original) continue;
      const staged = resolve(
        trashDirectory,
        `${String(index)}-${basename(asset.fileName)}`,
      );
      try {
        await rename(original, staged);
        stagedFiles.push({ original, staged });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await db.transaction(async (transaction) => {
      await transaction
        .delete(mediaItems)
        .where(inArray(mediaItems.id, itemIds));
    });
  } catch (error) {
    await Promise.all(
      stagedFiles.map(async ({ original, staged }) => {
        await mkdir(dirname(original), { recursive: true });
        await rename(staged, original);
      }),
    );
    await rm(trashDirectory, { force: true, recursive: true });
    throw error;
  }

  await rm(trashDirectory, { force: true, recursive: true });
  await deleteUnreferencedObjects(
    db,
    storage,
    assets.flatMap((asset) => (asset.storageKey ? [asset.storageKey] : [])),
  );
}

export async function enforceStorageRetention(
  db: Database,
  options: RetentionOptions,
) {
  const [{ totalBytes: rawTotalBytes } = { totalBytes: 0 }] = await db
    .select({
      totalBytes: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)`,
    })
    .from(mediaAssets);
  const totalBytes = Number(rawTotalBytes);
  const triggerBytes = options.maxStorageBytes * (options.triggerPercent / 100);
  if (totalBytes <= triggerBytes) return;

  const targetBytes = options.maxStorageBytes * (options.targetPercent / 100);
  const bytesToRemove = totalBytes - targetBytes;
  const oldestItems = await db
    .select({
      id: mediaItems.id,
      sizeBytes: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)`,
    })
    .from(mediaItems)
    .leftJoin(mediaAssets, eq(mediaAssets.mediaItemId, mediaItems.id))
    .groupBy(mediaItems.id, mediaItems.collectedAt)
    .orderBy(asc(mediaItems.collectedAt), asc(mediaItems.id));

  const itemIds: string[] = [];
  let removableBytes = 0;
  for (const item of oldestItems) {
    itemIds.push(item.id);
    removableBytes += Number(item.sizeBytes);
    if (removableBytes >= bytesToRemove) break;
  }
  if (removableBytes < bytesToRemove) {
    throw new Error('The incoming collection exceeds the media storage quota');
  }

  await deleteMediaItems(db, options.storage, itemIds);
  console.info(
    `Retention removed ${String(itemIds.length)} media items (${String(removableBytes)} bytes)`,
  );
}

export async function removeObsoleteAssets(
  db: Database,
  storage: MediaStorage,
  obsoleteAssets: readonly ObsoleteAsset[],
) {
  await Promise.all(
    obsoleteAssets.map(async (asset) => {
      if (!asset.relativePath) return;
      const absolutePath = storage.localPath(asset.relativePath);
      if (absolutePath) await rm(absolutePath, { force: true });
    }),
  );
  await deleteUnreferencedObjects(
    db,
    storage,
    obsoleteAssets.flatMap((asset) =>
      asset.storageKey ? [asset.storageKey] : [],
    ),
  );
}
