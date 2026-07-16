import { basename, relative, resolve, sep } from 'node:path';
import { access, mkdir, rm } from 'node:fs/promises';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  collections,
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import { extractMedia } from '@media-scraper/extractors';
import {
  INSTAGRAM_CREDENTIAL_FILE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { readFileMetadata } from './file-metadata.js';

interface ProcessOptions {
  credentialsRoot: string;
  db: Database;
  mediaRoot: string;
  maxAssetBytes: number;
}

export async function processCollection(
  job: CollectionJobPayload,
  { credentialsRoot, db, mediaRoot, maxAssetBytes }: ProcessOptions,
) {
  await db
    .update(collections)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
    .where(eq(collections.id, job.collectionId));

  const root = resolve(mediaRoot);
  const outputDirectory = resolve(root, job.collectionId);
  if (!outputDirectory.startsWith(`${root}${sep}`)) {
    throw new Error('Invalid collection output directory');
  }
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  try {
    const credentialPath = resolve(
      credentialsRoot,
      INSTAGRAM_CREDENTIAL_FILE_NAME,
    );
    const hasCredential =
      job.platform === 'instagram' &&
      (await access(credentialPath)
        .then(() => true)
        .catch(() => false));
    const preferredExtractor =
      job.platform === 'instagram' ? 'gallery-dl' : 'yt-dlp';
    const extractedItems = await extractMedia(
      job.url,
      outputDirectory,
      hasCredential
        ? { cookiesPath: credentialPath, preferredExtractor }
        : { preferredExtractor },
    );
    for (const extractedItem of extractedItems) {
      const filesWithMetadata = await Promise.all(
        extractedItem.files.map(async (file) => ({
          ...file,
          metadata: await readFileMetadata(file.absolutePath),
        })),
      );
      const oversizedFile = filesWithMetadata.find(
        (file) => file.metadata.sizeBytes > maxAssetBytes,
      );
      if (oversizedFile) {
        throw new Error(
          `${basename(oversizedFile.absolutePath)} exceeds the configured asset limit`,
        );
      }

      const contentHashes = filesWithMetadata.map(
        (file) => file.metadata.contentHash,
      );
      const duplicateAssets = await db
        .select({ contentHash: mediaAssets.contentHash })
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
      const duplicateHashes = new Set(
        duplicateAssets.map((asset) => asset.contentHash),
      );
      if (
        contentHashes.length > 0 &&
        contentHashes.every((hash) => duplicateHashes.has(hash))
      ) {
        await Promise.all(
          extractedItem.files.map((file) =>
            rm(file.absolutePath, { force: true }),
          ),
        );
        continue;
      }

      const currentPaths = new Set(
        filesWithMetadata.map((file) => relative(root, file.absolutePath)),
      );
      const obsoletePaths = await db.transaction(async (transaction) => {
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
        await transaction.insert(mediaAssets).values(
          filesWithMetadata.map((file) => ({
            mediaItemId: item.id,
            type: file.type,
            fileName: basename(file.absolutePath),
            relativePath: relative(root, file.absolutePath),
            ...file.metadata,
          })),
        );
        return previousAssets.map((asset) => asset.relativePath);
      });

      await Promise.all(
        obsoletePaths.flatMap((obsoletePath) => {
          if (currentPaths.has(obsoletePath)) return [];
          const absolutePath = resolve(root, obsoletePath);
          return absolutePath.startsWith(`${root}${sep}`)
            ? [rm(absolutePath, { force: true })]
            : [];
        }),
      );
    }

    await db
      .update(collections)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(collections.id, job.collectionId));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown extraction failure';
    await db
      .update(collections)
      .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
      .where(eq(collections.id, job.collectionId));
    throw error;
  }
}
