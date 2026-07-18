import { useEffect, useRef, useState } from 'react';
import type { MediaItem } from '@media-scraper/shared';
import { api } from '../api';

const UNKNOWN_CREATOR_LABEL = 'Unknown creator';

export function MediaCard({
  item,
  deleteDisabled,
  isDeleting,
  previewOpen,
  onDelete,
  onPreview,
}: {
  deleteDisabled: boolean;
  item: MediaItem;
  isDeleting: boolean;
  previewOpen: boolean;
  onDelete: () => void;
  onPreview: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
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

  return (
    <article className="media-card">
      <div className="preview">
        {selectedAsset?.type === 'image' ? (
          <img
            alt={item.caption ?? `${item.platform} media`}
            loading="lazy"
            src={api.mediaUrl(selectedAsset.url)}
          />
        ) : selectedAsset ? (
          <video
            controls
            key={selectedAsset.id}
            preload="metadata"
            ref={videoRef}
            src={api.mediaUrl(selectedAsset.url)}
          />
        ) : (
          <div className="empty-preview">No preview</div>
        )}
        <span className="platform">{item.platform}</span>
        {hasMultipleAssets && (
          <>
            <span className="asset-count">
              {assetIndex + 1} / {item.assets.length}
            </span>
            <button
              aria-label="Previous asset"
              className="carousel-control carousel-previous"
              onClick={() => selectAdjacentAsset(-1)}
              type="button"
            >
              ‹
            </button>
            <button
              aria-label="Next asset"
              className="carousel-control carousel-next"
              onClick={() => selectAdjacentAsset(1)}
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
        <div className="card-actions">
          <button
            aria-label={`Preview media by ${item.authorName ?? UNKNOWN_CREATOR_LABEL}`}
            onClick={onPreview}
            type="button"
          >
            Preview
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
