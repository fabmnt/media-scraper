import { memo, useEffect, useState } from 'react';
import { MANUAL_UPLOAD_LABEL, type MediaItem } from '@media-scraper/shared';
import { api } from '../api';
import { useHorizontalSwipe } from '../hooks/useHorizontalSwipe';
import { useViewportVisibility } from '../hooks/useViewportVisibility';

const UNKNOWN_CREATOR_LABEL = 'Unknown creator';

export const MediaCard = memo(function MediaCard({
  deleteDisabled,
  isDeleting,
  isSelected,
  item,
  onDelete,
  onPreview,
  onSelect,
}: {
  deleteDisabled: boolean;
  isDeleting: boolean;
  isSelected: boolean;
  item: MediaItem;
  onDelete: (item: MediaItem) => void;
  onPreview: (itemId: string, assetId: string | undefined) => void;
  onSelect: (itemId: string) => void;
}) {
  const { isVisible, targetRef } = useViewportVisibility<HTMLDivElement>();
  const [assetIndex, setAssetIndex] = useState(0);
  const [loadedAssetIds, setLoadedAssetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selectedAsset = item.assets[assetIndex] ?? item.assets[0];
  const hasMultipleAssets = item.assets.length > 1;
  const isSelectedAssetLoading =
    selectedAsset !== undefined &&
    (selectedAsset.type === 'image' || isVisible) &&
    !loadedAssetIds.has(selectedAsset.id);
  const platformLabel =
    item.platform === 'manual' ? MANUAL_UPLOAD_LABEL : item.platform;
  const previewUrl = selectedAsset
    ? api.mediaUrl(selectedAsset.thumbnailUrl ?? selectedAsset.url)
    : undefined;

  useEffect(() => {
    if (assetIndex >= item.assets.length) setAssetIndex(0);
  }, [assetIndex, item.assets.length]);

  function selectAdjacentAsset(direction: -1 | 1) {
    setAssetIndex(
      (currentIndex) =>
        (currentIndex + direction + item.assets.length) % item.assets.length,
    );
  }

  function markAssetAsLoaded(assetId: string) {
    setLoadedAssetIds((currentAssetIds) => {
      if (currentAssetIds.has(assetId)) return currentAssetIds;
      return new Set(currentAssetIds).add(assetId);
    });
  }

  const { consumeSwipe, handleTouchEnd, handleTouchStart } = useHorizontalSwipe(
    {
      onSwipeLeft: () => selectAdjacentAsset(1),
      onSwipeRight: () => selectAdjacentAsset(-1),
    },
  );

  return (
    <article
      aria-label={`Open media by ${item.authorName ?? UNKNOWN_CREATOR_LABEL}`}
      className={`media-card${isSelected ? ' selected' : ''}`}
      onClick={() => {
        if (consumeSwipe()) return;
        onPreview(item.id, selectedAsset?.id);
      }}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          (event.key !== 'Enter' && event.key !== ' ')
        ) {
          return;
        }
        event.preventDefault();
        onPreview(item.id, selectedAsset?.id);
      }}
      tabIndex={0}
    >
      <div
        className="preview"
        onClick={(event) => {
          if (consumeSwipe()) event.stopPropagation();
        }}
        onTouchEnd={(event) => {
          handleTouchEnd(event.changedTouches[0]);
        }}
        onTouchStart={(event) => {
          handleTouchStart(event.touches[0]);
        }}
        ref={targetRef}
      >
        {selectedAsset &&
        previewUrl &&
        (selectedAsset.type === 'image' || isVisible) ? (
          <img
            alt={item.caption ?? `${platformLabel} media`}
            decoding="async"
            loading="lazy"
            onError={() => markAssetAsLoaded(selectedAsset.id)}
            onLoad={() => markAssetAsLoaded(selectedAsset.id)}
            src={previewUrl}
          />
        ) : selectedAsset ? null : (
          <div className="empty-preview">No preview</div>
        )}
        {isSelectedAssetLoading && (
          <div
            aria-label="Loading media"
            className="media-loading-skeleton"
            role="status"
          />
        )}
        <span className="platform">{platformLabel}</span>
        <label
          aria-label={`Select media by ${item.authorName ?? UNKNOWN_CREATOR_LABEL}`}
          className="media-selection-control"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            checked={isSelected}
            onChange={() => onSelect(item.id)}
            type="checkbox"
          />
        </label>
        {hasMultipleAssets && (
          <>
            <span className="asset-count">
              {assetIndex + 1} / {item.assets.length}
            </span>
            <button
              aria-label="Previous asset"
              className="carousel-control carousel-previous"
              onClick={(event) => {
                event.stopPropagation();
                selectAdjacentAsset(-1);
              }}
              type="button"
            >
              ‹
            </button>
            <button
              aria-label="Next asset"
              className="carousel-control carousel-next"
              onClick={(event) => {
                event.stopPropagation();
                selectAdjacentAsset(1);
              }}
              type="button"
            >
              ›
            </button>
          </>
        )}
      </div>
      <div className="card-body">
        <div className="card-title-row">
          <strong title={item.authorName ?? UNKNOWN_CREATOR_LABEL}>
            {item.authorName ?? UNKNOWN_CREATOR_LABEL}
          </strong>
          <span>{new Date(item.collectedAt).toLocaleDateString()}</span>
        </div>
        <p>{item.caption ?? 'No caption available'}</p>
        <div
          className="card-actions"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            aria-label={`Preview media by ${item.authorName ?? UNKNOWN_CREATOR_LABEL}`}
            className="preview-button"
            onClick={() => onPreview(item.id, selectedAsset?.id)}
            title="Preview"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          </button>
          {item.sourceUrl && (
            <a href={item.sourceUrl} rel="noreferrer" target="_blank">
              Source ↗
            </a>
          )}
          {selectedAsset && (
            <a download href={api.downloadUrl(selectedAsset.id)}>
              Download{hasMultipleAssets ? ` ${assetIndex + 1}` : ''}
            </a>
          )}
          <button
            disabled={deleteDisabled}
            onClick={() => onDelete(item)}
            type="button"
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </article>
  );
});
