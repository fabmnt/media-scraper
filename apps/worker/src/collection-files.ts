import { readdir, rm, rmdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { ExtractedFile, ExtractedMedia } from '@media-scraper/extractors';
import { readFileMetadata } from './file-metadata.js';

export type FileWithMetadata = ExtractedFile & {
  metadata: Awaited<ReturnType<typeof readFileMetadata>>;
};

export type PreparedMedia = Omit<ExtractedMedia, 'files'> & {
  files: FileWithMetadata[];
};

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}

export async function prepareMedia(
  extractedItems: ExtractedMedia[],
  {
    maxAssetBytes,
    maxCollectionBytes,
    metadataConcurrency,
  }: {
    maxAssetBytes: number;
    maxCollectionBytes: number;
    metadataConcurrency: number;
  },
): Promise<PreparedMedia[]> {
  const allFiles = extractedItems.flatMap((item) => item.files);
  const metadataByPath = new Map(
    await mapWithConcurrency(
      allFiles,
      metadataConcurrency,
      async (file) =>
        [file.absolutePath, await readFileMetadata(file.absolutePath)] as const,
    ),
  );
  let totalBytes = 0;
  const preparedItems = extractedItems.map((item) => {
    const hashes = new Set<string>();
    const files = item.files.flatMap((file): FileWithMetadata[] => {
      const metadata = metadataByPath.get(file.absolutePath);
      if (!metadata || hashes.has(metadata.contentHash)) return [];
      hashes.add(metadata.contentHash);
      totalBytes += metadata.sizeBytes;
      if (metadata.sizeBytes > maxAssetBytes) {
        throw new Error(
          `${basename(file.absolutePath)} exceeds the configured asset limit`,
        );
      }
      return [{ ...file, metadata }];
    });
    return { ...item, files };
  });
  if (totalBytes > maxCollectionBytes) {
    throw new Error('Collection exceeds the configured total size limit');
  }
  return preparedItems;
}

export function safeMediaPath(root: string, relativePath: string) {
  const absolutePath = resolve(root, relativePath);
  return absolutePath.startsWith(`${root}${sep}`) ? absolutePath : undefined;
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
