import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem } from '@media-scraper/shared';
import { api } from '../api';
import { VideoFrameCapture } from './VideoFrameCapture';

export function MediaPreview({
  initialItemId,
  items,
  onClose,
}: {
  initialItemId: string;
  items: MediaItem[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialItemIndex = Math.max(
    items.findIndex((item) => item.id === initialItemId),
    0,
  );
  const [itemIndex, setItemIndex] = useState(initialItemIndex);
  const [assetIndex, setAssetIndex] = useState(0);
  const item = items[itemIndex];
  const asset = item?.assets[assetIndex];
  const canGoPrevious = itemIndex > 0 || assetIndex > 0;
  const canGoNext = item
    ? itemIndex < items.length - 1 || assetIndex < item.assets.length - 1
    : false;

  const showPrevious = useCallback(() => {
    if (!item || !canGoPrevious) return;
    if (assetIndex > 0) {
      setAssetIndex((current) => current - 1);
      return;
    }
    const previousItemIndex = itemIndex - 1;
    const previousAssetCount = items[previousItemIndex]?.assets.length ?? 0;
    setItemIndex(previousItemIndex);
    setAssetIndex(Math.max(previousAssetCount - 1, 0));
  }, [assetIndex, canGoPrevious, item, itemIndex, items]);

  const showNext = useCallback(() => {
    if (!item || !canGoNext) return;
    if (assetIndex < item.assets.length - 1) {
      setAssetIndex((current) => current + 1);
      return;
    }
    setItemIndex((current) => current + 1);
    setAssetIndex(0);
  }, [assetIndex, canGoNext, item]);

  const closePreview = useCallback(() => {
    dialogRef.current?.close();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        target instanceof HTMLElement &&
        target.matches('video, input, select, textarea, button, a[href]')
      ) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPrevious();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        showNext();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closePreview, showNext, showPrevious]);

  if (!item) return null;

  return (
    <dialog
      aria-label="Media preview"
      className="media-preview-modal"
      onCancel={(event) => {
        event.preventDefault();
        closePreview();
      }}
      onClick={(event) => {
        if (event.currentTarget === event.target) closePreview();
      }}
      ref={dialogRef}
    >
      <div className="media-preview-dialog">
        <header className="media-preview-header">
          <div>
            <span className="eyebrow">{item.platform}</span>
            <strong>{item.authorName ?? 'Unknown creator'}</strong>
          </div>
          <span className="preview-position">
            {itemIndex + 1} / {items.length}
            {item.assets.length > 1 &&
              ` · FILE ${assetIndex + 1} / ${item.assets.length}`}
          </span>
          <button
            aria-label="Close preview"
            className="preview-close"
            onClick={closePreview}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="media-preview-stage">
          {asset?.type === 'image' ? (
            <img
              alt={item.caption ?? `${item.platform} media`}
              src={api.mediaUrl(asset.url)}
            />
          ) : asset ? (
            <VideoFrameCapture
              fileName={asset.fileName}
              key={asset.id}
              src={api.mediaUrl(asset.url)}
            />
          ) : (
            <p className="empty-state">No media file available.</p>
          )}
          <button
            aria-label="Previous media file"
            className="preview-navigation preview-navigation-previous"
            disabled={!canGoPrevious}
            onClick={showPrevious}
            type="button"
          >
            ←
          </button>
          <button
            aria-label="Next media file"
            className="preview-navigation preview-navigation-next"
            disabled={!canGoNext}
            onClick={showNext}
            type="button"
          >
            →
          </button>
        </div>

        <div className="media-preview-footer">
          <p>{item.caption ?? 'No caption available'}</p>
          <div>
            <a href={item.sourceUrl} rel="noreferrer" target="_blank">
              View source ↗
            </a>
            {asset && (
              <a download href={api.downloadUrl(asset.id)}>
                Download file
              </a>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
