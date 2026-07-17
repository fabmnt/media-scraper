import { randomUUID } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { collections, type Database } from '@media-scraper/database';
import { extractMedia } from '@media-scraper/extractors';
import type { MediaStorage } from '@media-scraper/storage';
import {
  PLATFORM_CREDENTIALS,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { prepareMedia, removeUntrackedFiles } from './collection-files.js';
import { optimizeMedia } from './optimize-media.js';
import { persistCollection } from './persist-collection.js';
import {
  enforceStorageRetention,
  removeObsoleteAssets,
} from './storage-retention.js';

const MAX_ERROR_LENGTH = 4_000;
const CLAIM_LEASE_MS = 60_000;
const CLAIM_RENEWAL_INTERVAL_MS = 20_000;

interface ProcessOptions {
  credentialsRoot: string;
  db: Database;
  extractionTimeoutMs: number;
  imageMaxDimension: number;
  isFinalAttempt: boolean;
  maxAssetBytes: number;
  maxCollectionBytes: number;
  maxMediaStorageBytes: number;
  mediaRoot: string;
  metadataConcurrency: number;
  optimizationTimeoutMs: number;
  retentionTargetPercent: number;
  retentionTriggerPercent: number;
  signal: AbortSignal;
  storage: MediaStorage;
  videoMaxDimension: number;
}

export async function processCollection(
  job: CollectionJobPayload,
  {
    credentialsRoot,
    db,
    extractionTimeoutMs,
    imageMaxDimension,
    isFinalAttempt,
    maxAssetBytes,
    maxCollectionBytes,
    maxMediaStorageBytes,
    mediaRoot,
    metadataConcurrency,
    optimizationTimeoutMs,
    retentionTargetPercent,
    retentionTriggerPercent,
    signal,
    storage,
    videoMaxDimension,
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

  const claimOwner = randomUUID();
  const claimedAt = new Date();
  const claimExpiresAt = new Date(claimedAt.getTime() + CLAIM_LEASE_MS);
  const [claimedCollection] = await db
    .update(collections)
    .set({
      status: 'processing',
      errorMessage: null,
      claimOwner,
      claimExpiresAt,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(collections.id, job.collectionId),
        or(
          inArray(collections.status, ['queued', 'failed']),
          and(
            eq(collections.status, 'processing'),
            or(
              isNull(collections.claimExpiresAt),
              lt(collections.claimExpiresAt, claimedAt),
            ),
          ),
        ),
      ),
    )
    .returning({ id: collections.id });
  if (!claimedCollection) {
    throw new Error('Collection is already processing or no longer available');
  }

  const renewClaim = async () => {
    const [renewedCollection] = await db
      .update(collections)
      .set({
        claimExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(collections.id, job.collectionId),
          eq(collections.claimOwner, claimOwner),
          eq(collections.status, 'processing'),
        ),
      )
      .returning({ id: collections.id });
    if (!renewedCollection) throw new Error('Collection claim was lost');
  };
  const claimRenewal = setInterval(() => {
    void renewClaim().catch((error) =>
      console.warn('Could not renew collection claim', error),
    );
  }, CLAIM_RENEWAL_INTERVAL_MS);
  claimRenewal.unref();

  let retainedPaths = new Set<string>();
  let obsoleteAssets: Awaited<
    ReturnType<typeof persistCollection>
  >['obsoleteAssets'] = [];
  try {
    await mkdir(outputDirectory, { recursive: true });
    const credentialPath = resolve(
      credentialsRoot,
      PLATFORM_CREDENTIALS[job.platform].fileName,
    );
    const hasCredential = await access(credentialPath)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
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

    const optimizedItems = await optimizeMedia(extractedItems, {
      imageMaxDimension,
      outputRoot: outputDirectory,
      signal,
      timeoutMs: optimizationTimeoutMs,
      videoMaxDimension,
    });
    const preparedItems = await prepareMedia(optimizedItems, {
      maxAssetBytes,
      maxCollectionBytes,
      metadataConcurrency,
      signal,
    });
    signal.throwIfAborted();
    await renewClaim();
    ({ retainedPaths, obsoleteAssets } = await persistCollection(
      db,
      job,
      preparedItems,
      storage,
      claimOwner,
    ));
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : 'Unknown extraction failure'
    ).slice(0, MAX_ERROR_LENGTH);
    await db
      .update(collections)
      .set({
        status: isFinalAttempt ? 'failed' : 'queued',
        errorMessage: isFinalAttempt ? message : null,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(collections.id, job.collectionId),
          eq(collections.claimOwner, claimOwner),
        ),
      );
    await rm(outputDirectory, { force: true, recursive: true }).catch(
      (cleanupError) =>
        console.warn('Could not clean failed extraction output', cleanupError),
    );
    throw error;
  } finally {
    clearInterval(claimRenewal);
  }

  await removeUntrackedFiles(outputDirectory, root, retainedPaths).catch(
    (error) => console.warn('Could not clean extraction sidecars', error),
  );
  await removeObsoleteAssets(db, storage, obsoleteAssets).catch((error) =>
    console.warn('Could not remove obsolete media', error),
  );
  await enforceStorageRetention(db, {
    maxStorageBytes: maxMediaStorageBytes,
    storage,
    targetPercent: retentionTargetPercent,
    triggerPercent: retentionTriggerPercent,
  }).catch((error) => console.warn('Could not enforce media retention', error));
}
