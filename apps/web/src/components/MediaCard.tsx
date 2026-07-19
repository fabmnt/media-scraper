import { useEffect, useRef, useState } from 'react';
import type { MediaItem } from '@media-scraper/shared';
import { api } from '../api';

const MIN_SWIPE_DISTANCE_PX = 50;
const UNKNOWN_CREATOR_LABEL = 'Unknown creator';

export function MediaCard({
  deleteDisabled,
  isDeleting,
  isSelected,
  item,
  onDelete,
  onPreview,
  onSelect,
  previewOpen,
}: {
  deleteDisabled: boolean;
  isDeleting: boolean;
  isSelected: boolean;
  item: MediaItem;
  onDelete: () => void;
  onPreview: () => void;
  onSelect: () => void;
  previewOpen: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const swipeStartX = useRef<number | undefined>(undefined);
  const didSwipe = useRef(false);
  const [assetIndex, setAssetIndex] = useState(0);
  const selectedAsset = item.assets[assetIndex] ?? item.assets[0];
  const hasMultipleAssets = item.assets.length > 1;

  useEffect(() => {
    if (assetIndex >= item.assets.length) setAssetIndex(0);
  }, [assetIndex, item.assets.length]);

  useEffect(() => {
    if (previewOpen) videoRef.current?.pause();
  }, [previewOpen]);

  function selectAdjacentAsset(direction: -1 | 1) {
    setAssetIndex(
      (currentIndex) =>
        (currentIndex + direction + item.assets.length) % item.assets.length,
    );
  }

  function handleSwipeEnd(touchX: number) {
    if (swipeStartX.current === undefined) return;
    const swipeDistance = touchX - swipeStartX.current;
    swipeStartX.current = undefined;
    if (Math.abs(swipeDistance) < MIN_SWIPE_DISTANCE_PX) return;

    didSwipe.current = true;
    selectAdjacentAsset(swipeDistance > 0 ? -1 : 1);
  }

  return (
    <article
      aria-label={`Open media by ${item.authorName ?? UNKNOWN_CREATOR_LABEL}`}
      className={`media-card${isSelected ? ' selected' : ''}`}
      onClick={() => {
        if (didSwipe.current) {
          didSwipe.current = false;
          return;
        }
        onPreview();
      }}
    >
      <div
        className="preview"
        onTouchEnd={(event) => {
          if (selectedAsset?.type === 'image') {
            handleSwipeEnd(event.changedTouches[0]?.clientX ?? 0);
          }
        }}
        onTouchStart={(event) => {
          if (selectedAsset?.type === 'image') {
            swipeStartX.current = event.touches[0]?.clientX;
          }
        }}
      >
        {selectedAsset?.type === 'image' ? (
          <img
            alt={item.caption ?? `${item.platform} media`}
            loading="lazy"
            src={api.mediaUrl(selectedAsset.url)}
          />
        ) : selectedAsset ? (
          <video
            autoPlay
            controls
            key={selectedAsset.id}
            loop
            muted
            playsInline
            preload="metadata"
            ref={videoRef}
            src={api.mediaUrl(selectedAsset.url)}
          />
        ) : (
          <div className="empty-preview">No preview</div>
        )}
        <span className="platform">{item.platform}</span>
        <label
          aria-label={`Select media by ${item.authorName ?? UNKNOWN_CREATOR_LABEL}`}
          className="media-selection-control"
          onClick={(event) => event.stopPropagation()}
        >
          <input checked={isSelected} onChange={onSelect} type="checkbox" />
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
            onClick={onPreview}
            title="Preview"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          </button>
          <a href={item.sourceUrl} rel="noreferrer" target="_blank">
            Source ↗
          </a>
          {selectedAsset && (
            <a download href={api.downloadUrl(selectedAsset.id)}>
              Download{hasMultipleAssets ? ` ${assetIndex + 1}` : ''}
            </a>
          )}
          <button disabled={deleteDisabled} onClick={onDelete} type="button">
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </article>
  );
}
