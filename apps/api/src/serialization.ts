import type { Collection, MediaAsset, MediaItem } from '@media-scraper/shared';
import type { mediaAssets, mediaItems } from '@media-scraper/database';

export type CollectionRow =
  typeof import('@media-scraper/database').collections.$inferSelect;
type MediaItemRow = typeof mediaItems.$inferSelect;
type MediaAssetRow = typeof mediaAssets.$inferSelect;

export function serializeCollection(row: CollectionRow): Collection {
  return {
    ...row,
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
    url: `/media/${asset.relativePath.split('\\').join('/')}`,
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
