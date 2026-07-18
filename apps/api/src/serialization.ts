import type {
  AutomaticProfile,
  Collection,
  MediaAsset,
  MediaItem,
} from '@media-scraper/shared';
import type { mediaAssets, mediaItems } from '@media-scraper/database';

export type CollectionRow =
  typeof import('@media-scraper/database').collections.$inferSelect;
type AutomaticProfileRow =
  typeof import('@media-scraper/database').automaticProfiles.$inferSelect;
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

export function serializeMediaItem(
  item: MediaItemRow,
  assets: MediaAssetRow[],
): MediaItem {
  const serializedAssets: MediaAsset[] = assets.map((asset) => ({
    id: asset.id,
    type: asset.type,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    url: `/media-items/${asset.id}/content`,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
  }));
  const thumbnail = serializedAssets.find((asset) => asset.type === 'image');

  return {
    id: item.id,
    platform: item.platform,
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    authorName: item.authorName,
    caption: item.caption,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    collectedAt: item.collectedAt.toISOString(),
    thumbnailUrl: thumbnail?.url ?? null,
    assets: serializedAssets,
  };
}
