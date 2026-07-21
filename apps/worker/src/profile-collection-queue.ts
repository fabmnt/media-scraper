import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  collections,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import type {
  CollectionJobPayload,
  Platform,
  ProfileMedia,
} from '@media-scraper/shared';
import {
  ensureCollectionQueued,
  type QueuedCollection,
} from './collection-queue.js';

interface DiscoveredProfile {
  id: string;
  platform: Platform;
}

async function queueCollections(
  collectionQueue: Queue<CollectionJobPayload>,
  pendingCollections: QueuedCollection[],
  db: Database,
) {
  const results = await Promise.allSettled(
    pendingCollections.map((collection) =>
      ensureCollectionQueued(collectionQueue, collection),
    ),
  );
  const failedIds = results.flatMap((result, index) => {
    const collection = pendingCollections[index];
    return result.status === 'rejected' && collection ? [collection.id] : [];
  });
  if (failedIds.length === 0) return;

  await db
    .update(collections)
    .set({
      status: 'failed',
      errorMessage: 'Automatic collection could not be queued',
      updatedAt: new Date(),
    })
    .where(inArray(collections.id, failedIds));
  throw new Error(
    `${String(failedIds.length)} automatic collection jobs could not be queued`,
  );
}

export async function queueDiscoveredProfileMedia(
  profile: DiscoveredProfile,
  items: ProfileMedia[],
  {
    collectionQueue,
    db,
  }: {
    collectionQueue: Queue<CollectionJobPayload>;
    db: Database;
  },
) {
  const sourceIds = items.map((item) => item.id);
  const sourceUrls = items.map((item) => item.sourceUrl);
  const [collectedRows, collectionRows] =
    sourceIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({ sourceId: mediaItems.sourceId })
            .from(mediaItems)
            .where(
              and(
                eq(mediaItems.platform, profile.platform),
                inArray(mediaItems.sourceId, sourceIds),
              ),
            ),
          db
            .select({
              id: collections.id,
              origin: collections.origin,
              platform: sql<Platform>`${collections.platform}`,
              sourceId: collections.discoveredSourceId,
              sourceUrl: sql<string>`${collections.sourceUrl}`,
              sourceVersion: collections.discoveredSourceVersion,
              status: collections.status,
            })
            .from(collections)
            .where(
              and(
                eq(collections.platform, profile.platform),
                or(
                  inArray(collections.discoveredSourceId, sourceIds),
                  inArray(collections.sourceUrl, sourceUrls),
                ),
              ),
            ),
        ]);
  const failedAutomaticCollections = collectionRows.filter(
    (collection) =>
      collection.origin === 'automatic' && collection.status === 'failed',
  );
  if (failedAutomaticCollections.length > 0) {
    await db
      .update(collections)
      .set({ status: 'queued', errorMessage: null, updatedAt: new Date() })
      .where(
        inArray(
          collections.id,
          failedAutomaticCollections.map((collection) => collection.id),
        ),
      );
    await queueCollections(collectionQueue, failedAutomaticCollections, db);
  }

  const itemsBySourceId = new Map(items.map((item) => [item.id, item]));
  const refreshedHighlightCollections = (
    await Promise.all(
      collectionRows.flatMap((collection) => {
        const item = collection.sourceId
          ? itemsBySourceId.get(collection.sourceId)
          : undefined;
        if (
          collection.origin !== 'automatic' ||
          collection.status !== 'completed' ||
          item?.sourceKind !== 'highlights' ||
          collection.sourceVersion === item.sourceVersion
        ) {
          return [];
        }
        return db
          .update(collections)
          .set({
            discoveredSourceVersion: item.sourceVersion,
            errorMessage: null,
            status: 'queued',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(collections.id, collection.id),
              eq(collections.status, 'completed'),
            ),
          )
          .returning({
            id: collections.id,
            platform: sql<Platform>`${collections.platform}`,
            sourceUrl: sql<string>`${collections.sourceUrl}`,
          });
      }),
    )
  ).flat();
  await queueCollections(collectionQueue, refreshedHighlightCollections, db);

  const knownSourceIds = new Set([
    ...collectedRows.map((item) => item.sourceId),
    ...collectionRows.flatMap((item) => (item.sourceId ? [item.sourceId] : [])),
  ]);
  const knownSourceUrls = new Set(collectionRows.map((item) => item.sourceUrl));
  const pendingValues = items
    .filter(
      (item) =>
        !knownSourceIds.has(item.id) && !knownSourceUrls.has(item.sourceUrl),
    )
    .map((item) => ({
      id: randomUUID(),
      automaticProfileId: profile.id,
      discoveredSourceId: item.id,
      discoveredSourceVersion: item.sourceVersion,
      origin: 'automatic' as const,
      platform: profile.platform,
      sourceUrl: item.sourceUrl,
    }));
  const pendingCollections =
    pendingValues.length === 0
      ? []
      : await db
          .insert(collections)
          .values(pendingValues)
          .onConflictDoNothing()
          .returning({
            id: collections.id,
            platform: sql<Platform>`${collections.platform}`,
            sourceUrl: sql<string>`${collections.sourceUrl}`,
          });
  await queueCollections(collectionQueue, pendingCollections, db);

  return (
    failedAutomaticCollections.length +
    refreshedHighlightCollections.length +
    pendingCollections.length
  );
}
