import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { collections, type Database } from '@media-scraper/database';
import { extractMedia } from '@media-scraper/extractors';
import {
  INSTAGRAM_CREDENTIAL_FILE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import {
  prepareMedia,
  removeUntrackedFiles,
  safeMediaPath,
} from './collection-files.js';
import { persistCollection } from './persist-collection.js';

const MAX_ERROR_LENGTH = 4_000;

interface ProcessOptions {
  credentialsRoot: string;
  db: Database;
  extractionTimeoutMs: number;
  isFinalAttempt: boolean;
  maxAssetBytes: number;
  maxCollectionBytes: number;
  mediaRoot: string;
  metadataConcurrency: number;
  signal: AbortSignal;
}

export async function processCollection(
  job: CollectionJobPayload,
  {
    credentialsRoot,
    db,
    extractionTimeoutMs,
    isFinalAttempt,
    maxAssetBytes,
    maxCollectionBytes,
    mediaRoot,
    metadataConcurrency,
    signal,
  }: ProcessOptions,
) {
  const root = resolve(mediaRoot);
  const outputDirectory = resolve(
    root,
    'collections',
    job.collectionId,
    randomUUID(),
  );
  if (!outputDirectory.startsWith(`${root}${sep}`)) {
    throw new Error('Invalid collection output directory');
  }

  const [claimedCollection] = await db
    .update(collections)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
    .where(
      and(
        eq(collections.id, job.collectionId),
        inArray(collections.status, ['queued', 'failed']),
      ),
    )
    .returning({ id: collections.id });
  if (!claimedCollection) {
    throw new Error('Collection is already processing or no longer available');
  }

  let retainedPaths = new Set<string>();
  let obsoletePaths: string[] = [];
  try {
    await mkdir(outputDirectory, { recursive: true });
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
    const extractedItems = await extractMedia(job.url, outputDirectory, {
      maxAssetBytes,
      maxCollectionBytes,
      timeoutMs: extractionTimeoutMs,
      ...(hasCredential ? { cookiesPath: credentialPath } : {}),
      preferredExtractor,
      signal,
    });
    if (extractedItems.length === 0) {
      throw new Error('Extractor did not return any media items');
    }

    const preparedItems = await prepareMedia(extractedItems, {
      maxAssetBytes,
      maxCollectionBytes,
      metadataConcurrency,
    });
    ({ retainedPaths, obsoletePaths } = await persistCollection(
      db,
      job,
      preparedItems,
      root,
    ));
  } catch (error) {
    await rm(outputDirectory, { force: true, recursive: true });
    const message = (
      error instanceof Error ? error.message : 'Unknown extraction failure'
    ).slice(0, MAX_ERROR_LENGTH);
    await db
      .update(collections)
      .set({
        status: isFinalAttempt ? 'failed' : 'queued',
        errorMessage: isFinalAttempt ? message : null,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, job.collectionId));
    throw error;
  }

  await removeUntrackedFiles(outputDirectory, root, retainedPaths).catch(
    (error) => console.warn('Could not clean extraction sidecars', error),
  );
  await Promise.all(
    obsoletePaths.map(async (obsoletePath) => {
      const absolutePath = safeMediaPath(root, obsoletePath);
      if (absolutePath) await rm(absolutePath, { force: true });
    }),
  ).catch((error) => console.warn('Could not remove obsolete media', error));
}
