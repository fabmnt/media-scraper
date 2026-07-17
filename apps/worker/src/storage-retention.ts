import { rm } from 'node:fs/promises';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  enqueueAssetCleanup,
  mediaAssets,
  mediaItems,
  mediaMaintenanceTasks,
  type Database,
} from '@media-scraper/database';
import type { MediaStorage } from '@media-scraper/storage';

const CLEANUP_BATCH_SIZE = 50;
const MAX_ERROR_LENGTH = 4_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const RETRY_BASE_DELAY_MS = 30_000;

interface RetentionOptions {
  maxStorageBytes: number;
  targetPercent: number;
  triggerPercent: number;
}

interface MaintenanceOptions extends RetentionOptions {
  signal: AbortSignal;
  storage: MediaStorage;
}

async function enforceStorageRetention(
  db: Database,
  options: RetentionOptions,
) {
  await db.transaction(async (transaction) => {
    const [{ totalBytes: rawTotalBytes } = { totalBytes: 0 }] =
      await transaction
        .select({
          totalBytes: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)`,
        })
        .from(mediaAssets);
    const totalBytes = Number(rawTotalBytes);
    const triggerBytes =
      options.maxStorageBytes * (options.triggerPercent / 100);
    if (totalBytes <= triggerBytes) return;

    const targetBytes = options.maxStorageBytes * (options.targetPercent / 100);
    const bytesToRemove = totalBytes - targetBytes;
    const oldestItems = await transaction
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
      throw new Error(
        'The media storage quota cannot be reduced to its target',
      );
    }

    const assets = await transaction
      .select({
        relativePath: mediaAssets.relativePath,
        storageKey: mediaAssets.storageKey,
      })
      .from(mediaAssets)
      .where(inArray(mediaAssets.mediaItemId, itemIds));
    await enqueueAssetCleanup(transaction, assets);
    await transaction.delete(mediaItems).where(inArray(mediaItems.id, itemIds));
    console.info(
      `Retention removed ${String(itemIds.length)} media items (${String(removableBytes)} bytes)`,
    );
  });
}

export async function processMediaMaintenance(
  db: Database,
  options: MaintenanceOptions,
) {
  const tasks = await db
    .select()
    .from(mediaMaintenanceTasks)
    .where(lte(mediaMaintenanceTasks.availableAt, new Date()))
    .orderBy(asc(mediaMaintenanceTasks.availableAt))
    .limit(CLEANUP_BATCH_SIZE);

  for (const task of tasks) {
    options.signal.throwIfAborted();
    try {
      if (task.type === 'delete_local') {
        const [referencedAsset] = await db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(eq(mediaAssets.relativePath, task.target))
          .limit(1);
        if (!referencedAsset) {
          const absolutePath = options.storage.localPath(task.target);
          if (!absolutePath) {
            throw new Error('Cleanup path is outside media root');
          }
          await rm(absolutePath, { force: true });
        }
      } else if (task.type === 'delete_object') {
        const [referencedAsset] = await db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(eq(mediaAssets.storageKey, task.target))
          .limit(1);
        if (!referencedAsset) {
          await options.storage.deleteObjects([task.target], options.signal);
        }
      } else {
        await enforceStorageRetention(db, options);
      }
      await db
        .delete(mediaMaintenanceTasks)
        .where(
          and(
            eq(mediaMaintenanceTasks.id, task.id),
            eq(mediaMaintenanceTasks.version, task.version),
          ),
        );
    } catch (error) {
      if (options.signal.aborted) throw error;
      const attempts = task.attempts + 1;
      const retryDelayMs = Math.min(
        RETRY_BASE_DELAY_MS * 2 ** Math.min(attempts - 1, 10),
        MAX_RETRY_DELAY_MS,
      );
      const message = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, MAX_ERROR_LENGTH);
      await db
        .update(mediaMaintenanceTasks)
        .set({
          attempts,
          availableAt: new Date(Date.now() + retryDelayMs),
          lastError: message,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mediaMaintenanceTasks.id, task.id),
            eq(mediaMaintenanceTasks.version, task.version),
          ),
        );
      console.warn(`Media maintenance task ${task.id} failed: ${message}`);
    }
  }
}
