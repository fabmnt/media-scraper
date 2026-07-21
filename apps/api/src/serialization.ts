import type {
  AutomaticProfile,
  Collection,
  ProfileBackfill,
  MediaAsset,
  MediaItem,
} from '@media-scraper/shared';
import type { mediaAssets, mediaItems } from '@media-scraper/database';

export type CollectionRow =
  typeof import('@media-scraper/database').collections.$inferSelect;
type AutomaticProfileRow =
  typeof import('@media-scraper/database').automaticProfiles.$inferSelect;
type ProfileBackfillRow =
  typeof import('@media-scraper/database').profileBackfills.$inferSelect;
type MediaItemRow = typeof mediaItems.$inferSelect;
type MediaAssetRow = typeof mediaAssets.$inferSelect;

export function serializeCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    platform: row.platform,
    status: row.status,
    origin: row.origin,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeAutomaticProfile(
  row: AutomaticProfileRow,
): AutomaticProfile {
  return {
    id: row.id,
    platform: row.platform,
    username: row.username,
    intervalMinutes: row.intervalMinutes,
    includeStories: row.includeStories,
    includeHighlights: row.includeHighlights,
    enabled: row.enabled,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeProfileBackfill(
  row: ProfileBackfillRow,
): ProfileBackfill {
  return {
    id: row.id,
    automaticProfileId: row.automaticProfileId,
    status: row.status,
    includeStories: row.includeStories,
    includeHighlights: row.includeHighlights,
    pageNumber: row.pageNumber,
    itemsDiscovered: row.itemsDiscovered,
    collectionsQueued: row.collectionsQueued,
    lastError: row.lastError,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeMediaItem(
  item: MediaItemRow,
  assets: MediaAssetRow[],
): MediaItem {
  const thumbnailsByAssetId = new Map(
    assets.flatMap((asset) =>
      asset.thumbnailForAssetId
        ? [[asset.thumbnailForAssetId, asset] as const]
        : [],
    ),
  );
  const serializedAssets: MediaAsset[] = assets
    .filter((asset) => !asset.thumbnailForAssetId)
    .map((asset) => {
      const thumbnail = thumbnailsByAssetId.get(asset.id);
      return {
        id: asset.id,
        type: asset.type,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        url: `/media-items/${asset.id}/content`,
        thumbnailUrl: thumbnail ? `/media-items/${thumbnail.id}/content` : null,
        sizeBytes: asset.sizeBytes,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.durationSeconds,
      };
    });
  const thumbnail = serializedAssets.find((asset) => asset.thumbnailUrl);

  return {
    id: item.id,
    platform: item.platform,
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    authorName: item.authorName,
    caption: item.caption,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    collectedAt: item.collectedAt.toISOString(),
    thumbnailUrl: thumbnail?.thumbnailUrl ?? null,
    assets: serializedAssets,
  };
}
