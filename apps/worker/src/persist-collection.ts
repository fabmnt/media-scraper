import { basename, relative } from 'node:path';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  collections,
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import type { CollectionJobPayload } from '@media-scraper/shared';
import type { PreparedMedia } from './collection-files.js';

export async function persistCollection(
  db: Database,
  job: CollectionJobPayload,
  preparedItems: PreparedMedia[],
  mediaRoot: string,
  claimOwner: string,
) {
  return db.transaction(async (transaction) => {
    const retainedPaths = new Set<string>();
    const obsoletePaths: string[] = [];
    for (const extractedItem of preparedItems) {
      const contentHashes = extractedItem.files.map(
        (file) => file.metadata.contentHash,
      );
      const duplicateAssets =
        contentHashes.length === 0
          ? []
          : await transaction
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
      if (
        contentHashes.length > 0 &&
        [...hashesByMediaItem.values()].some((hashes) =>
          contentHashes.every((hash) => hashes.has(hash)),
        )
      ) {
        continue;
      }

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
        .select({ relativePath: mediaAssets.relativePath })
        .from(mediaAssets)
        .where(eq(mediaAssets.mediaItemId, item.id));
      await transaction
        .delete(mediaAssets)
        .where(eq(mediaAssets.mediaItemId, item.id));
      if (extractedItem.files.length > 0) {
        await transaction.insert(mediaAssets).values(
          extractedItem.files.map((file, position) => {
            const relativePath = relative(mediaRoot, file.absolutePath);
            retainedPaths.add(relativePath);
            return {
              mediaItemId: item.id,
              type: file.type,
              fileName: basename(file.absolutePath),
              position,
              relativePath,
              ...file.metadata,
            };
          }),
        );
      }
      obsoletePaths.push(...previousAssets.map((asset) => asset.relativePath));
    }
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
    return { retainedPaths, obsoletePaths };
  });
}
