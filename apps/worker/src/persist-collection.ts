import { basename } from 'node:path';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  collections,
  enqueueAssetCleanup,
  enqueueRetention,
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import type { CollectionJobPayload } from '@media-scraper/shared';
import {
  StorageUploadError,
  type MediaStorage,
  type StoredAssetLocation,
} from '@media-scraper/storage';
import type { PreparedMedia } from './collection-files.js';

const STORE_CONCURRENCY = 4;

export async function persistCollection(
  db: Database,
  job: CollectionJobPayload,
  preparedItems: PreparedMedia[],
  storage: MediaStorage,
  claimOwner: string,
  signal: AbortSignal,
) {
  const storedLocations = new Map<string, StoredAssetLocation>();
  try {
    const acceptedItems: PreparedMedia[] = [];
    for (const extractedItem of preparedItems) {
      const contentHashes = extractedItem.files.map(
        (file) => file.metadata.contentHash,
      );
      const duplicateAssets =
        contentHashes.length === 0
          ? []
          : await db
              .select({
                contentHash: mediaAssets.contentHash,
                mediaItemId: mediaAssets.mediaItemId,
              })
              .from(mediaAssets)
              .innerJoin(mediaItems, eq(mediaAssets.mediaItemId, mediaItems.id))
              .where(
                and(
                  inArray(mediaAssets.contentHash, contentHashes),
                  or(
                    ne(mediaItems.platform, job.platform),
                    ne(mediaItems.sourceId, extractedItem.sourceId),
                  ),
                ),
              );
      const hashesByMediaItem = new Map<string, Set<string>>();
      for (const asset of duplicateAssets) {
        const hashes = hashesByMediaItem.get(asset.mediaItemId) ?? new Set();
        hashes.add(asset.contentHash);
        hashesByMediaItem.set(asset.mediaItemId, hashes);
      }
      const isDuplicate =
        contentHashes.length > 0 &&
        [...hashesByMediaItem.values()].some((hashes) =>
          contentHashes.every((hash) => hashes.has(hash)),
        );
      if (!isDuplicate) acceptedItems.push(extractedItem);
    }

    const filesByPath = new Map(
      acceptedItems
        .flatMap((item) =>
          item.files.flatMap((file) =>
            file.thumbnail ? [file, file.thumbnail] : [file],
          ),
        )
        .map((file) => [file.absolutePath, file]),
    );
    const filesToStore = [...filesByPath.values()];
    let nextFileIndex = 0;
    const storeResults = await Promise.allSettled(
      Array.from(
        { length: Math.min(STORE_CONCURRENCY, filesToStore.length) },
        async () => {
          while (nextFileIndex < filesToStore.length) {
            signal.throwIfAborted();
            const file = filesToStore[nextFileIndex];
            nextFileIndex += 1;
            if (!file) continue;
            try {
              storedLocations.set(
                file.absolutePath,
                await storage.store(
                  file.absolutePath,
                  file.metadata.contentHash,
                  file.metadata.mimeType,
                  signal,
                ),
              );
            } catch (error) {
              if (error instanceof StorageUploadError) {
                storedLocations.set(file.absolutePath, error.location);
              }
              throw error;
            }
          }
        },
      ),
    );
    const failedStore = storeResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedStore) throw failedStore.reason;

    return await db.transaction(async (transaction) => {
      const retainedPaths = new Set<string>();
      for (const extractedItem of acceptedItems) {
        const [item] = await transaction
          .insert(mediaItems)
          .values({
            collectionId: job.collectionId,
            platform: job.platform,
            sourceId: extractedItem.sourceId,
            sourceUrl: extractedItem.sourceUrl,
            authorName: extractedItem.authorName,
            caption: extractedItem.caption,
            publishedAt: extractedItem.publishedAt,
          })
          .onConflictDoUpdate({
            target: [mediaItems.platform, mediaItems.sourceId],
            set: {
              collectionId: job.collectionId,
              sourceUrl: extractedItem.sourceUrl,
              authorName: extractedItem.authorName,
              caption: extractedItem.caption,
              publishedAt: extractedItem.publishedAt,
              collectedAt: new Date(),
            },
          })
          .returning({ id: mediaItems.id });
        if (!item) throw new Error('Failed to save extracted media');

        const previousAssets = await transaction
          .select({
            relativePath: mediaAssets.relativePath,
            storageKey: mediaAssets.storageKey,
          })
          .from(mediaAssets)
          .where(eq(mediaAssets.mediaItemId, item.id));
        await transaction
          .delete(mediaAssets)
          .where(eq(mediaAssets.mediaItemId, item.id));
        if (extractedItem.files.length > 0) {
          const originals = await transaction
            .insert(mediaAssets)
            .values(
              extractedItem.files.map((file, position) => {
                const location = storedLocations.get(file.absolutePath);
                if (!location) throw new Error('Media file was not stored');
                if (location.relativePath)
                  retainedPaths.add(location.relativePath);
                return {
                  mediaItemId: item.id,
                  type: file.type,
                  fileName: basename(file.absolutePath),
                  position,
                  ...location,
                  ...file.metadata,
                };
              }),
            )
            .returning({ id: mediaAssets.id });
          const thumbnails = extractedItem.files.flatMap((file, position) => {
            const thumbnail = file.thumbnail;
            const original = originals[position];
            if (!thumbnail || !original) return [];
            const location = storedLocations.get(thumbnail.absolutePath);
            if (!location) throw new Error('Thumbnail was not stored');
            if (location.relativePath) retainedPaths.add(location.relativePath);
            return [
              {
                mediaItemId: item.id,
                thumbnailForAssetId: original.id,
                type: thumbnail.type,
                fileName: basename(thumbnail.absolutePath),
                position: extractedItem.files.length + position,
                ...location,
                ...thumbnail.metadata,
              },
            ];
          });
          if (thumbnails.length > 0) {
            await transaction.insert(mediaAssets).values(thumbnails);
          }
        }
        await enqueueAssetCleanup(transaction, previousAssets);
      }
      await enqueueRetention(transaction);
      const [completedCollection] = await transaction
        .update(collections)
        .set({
          status: 'completed',
          errorMessage: null,
          claimOwner: null,
          claimExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(collections.id, job.collectionId),
            eq(collections.claimOwner, claimOwner),
          ),
        )
        .returning({ id: collections.id });
      if (!completedCollection) throw new Error('Collection claim was lost');
      return { retainedPaths };
    });
  } catch (error) {
    const uploadedObjects = [...storedLocations.values()].filter(
      (location) => location.storageKey,
    );
    if (uploadedObjects.length === 0) throw error;
    try {
      await enqueueAssetCleanup(db, uploadedObjects);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Could not persist media or queue uploaded object cleanup',
      );
    }
    throw error;
  }
}
