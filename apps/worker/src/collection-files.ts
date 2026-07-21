import { readdir, rm, rmdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { ExtractedFile, ExtractedMedia } from '@media-scraper/extractors';
import { createThumbnail } from '@media-scraper/media-processing';
import { readFileMetadata } from './file-metadata.js';

type ThumbnailWithMetadata = ExtractedFile & {
  metadata: Awaited<ReturnType<typeof readFileMetadata>>;
};

export type FileWithMetadata = ExtractedFile & {
  metadata: Awaited<ReturnType<typeof readFileMetadata>>;
  thumbnail?: ThumbnailWithMetadata;
};

export type PreparedMedia = Omit<ExtractedMedia, 'files'> & {
  files: FileWithMetadata[];
};

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length && !signal.aborted && !failure) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value === undefined) continue;
        try {
          results[index] = await operation(value);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  signal.throwIfAborted();
  return results;
}

export async function prepareMedia(
  extractedItems: ExtractedMedia[],
  {
    maxAssetBytes,
    maxCollectionBytes,
    metadataConcurrency,
    outputRoot,
    signal,
  }: {
    maxAssetBytes: number;
    maxCollectionBytes: number;
    metadataConcurrency: number;
    outputRoot: string;
    signal: AbortSignal;
  },
): Promise<PreparedMedia[]> {
  const allFiles = extractedItems.flatMap((item) => item.files);
  const metadataByPath = new Map(
    await mapWithConcurrency(
      allFiles,
      metadataConcurrency,
      signal,
      async (file) =>
        [file.absolutePath, await readFileMetadata(file.absolutePath)] as const,
    ),
  );
  let totalBytes = 0;
  const preparedItems: PreparedMedia[] = [];
  for (const item of extractedItems) {
    const hashes = new Set<string>();
    const files: FileWithMetadata[] = [];
    for (const file of item.files) {
      const metadata = metadataByPath.get(file.absolutePath);
      if (!metadata || hashes.has(metadata.contentHash)) continue;
      hashes.add(metadata.contentHash);
      totalBytes += metadata.sizeBytes;
      if (metadata.sizeBytes > maxAssetBytes) {
        throw new Error(
          `${basename(file.absolutePath)} exceeds the configured asset limit`,
        );
      }
      const thumbnailFile = await createThumbnail(
        { ...file, durationSeconds: metadata.durationSeconds },
        outputRoot,
        signal,
      );
      const thumbnail = thumbnailFile
        ? {
            ...thumbnailFile,
            metadata: await readFileMetadata(thumbnailFile.absolutePath),
          }
        : undefined;
      files.push({
        ...file,
        metadata,
        ...(thumbnail ? { thumbnail } : {}),
      });
    }
    preparedItems.push({ ...item, files });
  }
  if (totalBytes > maxCollectionBytes) {
    throw new Error('Collection exceeds the configured total size limit');
  }
  return preparedItems;
}

export async function removeUntrackedFiles(
  directory: string,
  root: string,
  retainedPaths: ReadonlySet<string>,
) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const directories: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      directories.push(absolutePath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!retainedPaths.has(relative(root, absolutePath))) {
      await rm(absolutePath, { force: true });
    }
  }
  for (const path of directories.sort(
    (left, right) => right.length - left.length,
  )) {
    await rmdir(path).catch(() => undefined);
  }
  await rmdir(directory).catch(() => undefined);
}
