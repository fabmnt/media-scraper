import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MANUAL_UPLOAD_LABEL,
  type MediaItem,
  type MediaItemGroup,
} from '@media-scraper/shared';
import { api } from '../api';
import { VideoFrameCapture } from './VideoFrameCapture';
import { useHorizontalSwipe } from '../hooks/useHorizontalSwipe';
import { useVirtualList } from '../hooks/useVirtualList';

const MEDIA_SELECTOR_ITEM_HEIGHT = 88;

interface PreviewLoadMore {
  isLoading: boolean;
  onLoad: () => void;
}

type MediaSelectorItem =
  | {
      asset: MediaItem['assets'][number];
      assetIndex: number;
      item: MediaItem;
      itemIndex: number;
      kind: 'asset';
    }
  | { groupKey: string; kind: 'load-more' };

export function MediaPreview({
  getLoadMore,
  groups,
  initialItemId,
  onClose,
}: {
  getLoadMore: (groupKey: string) => PreviewLoadMore | undefined;
  groups: MediaItemGroup[];
  initialItemId: string;
  onClose: () => void;
}) {
  const items = groups.flatMap((group) => group.items);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialItemIndex = Math.max(
    items.findIndex((item) => item.id === initialItemId),
    0,
  );
  const [itemIndex, setItemIndex] = useState(initialItemIndex);
  const [assetIndex, setAssetIndex] = useState(0);
  const item = items[itemIndex];
  const asset = item?.assets[assetIndex];
  const mediaSelectorItems = useMemo(() => {
    const selectorItems: MediaSelectorItem[] = [];
    let itemIndex = 0;

    for (const group of groups) {
      for (const item of group.items) {
        for (const [assetIndex, asset] of item.assets.entries()) {
          selectorItems.push({
            asset,
            assetIndex,
            item,
            itemIndex,
            kind: 'asset',
          });
        }
        itemIndex += 1;
      }
      if (group.nextOffset !== null) {
        selectorItems.push({ groupKey: group.key, kind: 'load-more' });
      }
    }
    return selectorItems;
  }, [groups]);
  const mediaFileCount = items.reduce(
    (count, mediaItem) => count + mediaItem.assets.length,
    0,
  );
  const selectedSelectorItemIndex = mediaSelectorItems.findIndex(
    (selectorItem) =>
      selectorItem.kind === 'asset' &&
      selectorItem.itemIndex === itemIndex &&
      selectorItem.assetIndex === assetIndex,
  );
  const {
    endIndex: selectorEndIndex,
    listRef: selectorListRef,
    onScroll: handleSelectorScroll,
    scrollToIndex: scrollSelectorToIndex,
    startIndex: selectorStartIndex,
    totalHeight: selectorTotalHeight,
  } = useVirtualList({
    itemCount: mediaSelectorItems.length,
    itemHeight: MEDIA_SELECTOR_ITEM_HEIGHT,
  });
  const visibleSelectorItems = mediaSelectorItems.slice(
    selectorStartIndex,
    selectorEndIndex,
  );
  const platformLabel =
    item?.platform === 'manual' ? MANUAL_UPLOAD_LABEL : item?.platform;
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

  const { handleTouchEnd, handleTouchStart } = useHorizontalSwipe({
    onSwipeLeft: showNext,
    onSwipeRight: showPrevious,
  });

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
    if (selectedSelectorItemIndex >= 0) {
      scrollSelectorToIndex(selectedSelectorItemIndex);
    }
  }, [scrollSelectorToIndex, selectedSelectorItemIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        target instanceof Element &&
        target.closest('video, input, select, textarea, button, a[href]')
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
            <span className="eyebrow">{platformLabel}</span>
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

        <div className="media-preview-content">
          <div className="media-preview-stage">
            {asset?.type === 'image' ? (
              <img
                alt={item.caption ?? `${platformLabel} media`}
                onTouchEnd={(event) => {
                  handleTouchEnd(event.changedTouches[0]);
                }}
                onTouchStart={(event) => {
                  handleTouchStart(event.touches[0]);
                }}
                src={api.mediaUrl(asset.url)}
              />
            ) : asset ? (
              <VideoFrameCapture
                fileName={asset.fileName}
                key={asset.id}
                onTouchEnd={(event) => {
                  handleTouchEnd(event.changedTouches[0]);
                }}
                onTouchStart={(event) => {
                  handleTouchStart(event.touches[0]);
                }}
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

          <aside aria-label="Media selector" className="media-selector">
            <header className="media-selector-header">
              <span>Media</span>
              <span>{mediaFileCount}</span>
            </header>
            <div
              className="media-selector-list"
              onScroll={handleSelectorScroll}
              ref={selectorListRef}
            >
              <div
                className="media-selector-virtual-list"
                style={{ height: selectorTotalHeight }}
              >
                <div
                  className="media-selector-virtual-items"
                  style={{
                    transform: `translateY(${selectorStartIndex * MEDIA_SELECTOR_ITEM_HEIGHT}px)`,
                  }}
                >
                  {visibleSelectorItems.map((selectorItem) => {
                    if (selectorItem.kind === 'load-more') {
                      const loadMore = getLoadMore(selectorItem.groupKey);
                      if (!loadMore) return null;
                      return (
                        <button
                          aria-label="Load more files in this group"
                          className="media-selector-load-more"
                          disabled={loadMore.isLoading}
                          key={`load-more-${selectorItem.groupKey}`}
                          onClick={loadMore.onLoad}
                          type="button"
                        >
                          {loadMore.isLoading ? 'Loading…' : 'Load more'}
                        </button>
                      );
                    }

                    const isSelected =
                      itemIndex === selectorItem.itemIndex &&
                      assetIndex === selectorItem.assetIndex;
                    const selectorPlatformLabel =
                      selectorItem.item.platform === 'manual'
                        ? MANUAL_UPLOAD_LABEL
                        : selectorItem.item.platform;

                    return (
                      <button
                        aria-current={isSelected ? 'true' : undefined}
                        aria-label={`Show ${selectorItem.asset.type} ${selectorItem.assetIndex + 1} from ${selectorItem.item.authorName ?? 'Unknown creator'}`}
                        className={`media-selector-item${isSelected ? ' selected' : ''}`}
                        key={selectorItem.asset.id}
                        onClick={() => {
                          setItemIndex(selectorItem.itemIndex);
                          setAssetIndex(selectorItem.assetIndex);
                        }}
                        type="button"
                      >
                        <span className="media-selector-thumbnail">
                          <img
                            alt=""
                            decoding="async"
                            loading="lazy"
                            src={api.mediaUrl(
                              selectorItem.asset.thumbnailUrl ??
                                selectorItem.asset.url,
                            )}
                          />
                        </span>
                        <span className="media-selector-details">
                          <strong>
                            {selectorItem.item.authorName ?? 'Unknown creator'}
                          </strong>
                          <span>
                            {selectorPlatformLabel} · {selectorItem.asset.type}{' '}
                            {selectorItem.assetIndex + 1}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </aside>
        </div>

        <div className="media-preview-footer">
          <p>{item.caption ?? 'No caption available'}</p>
          <div>
            {item.sourceUrl && (
              <a href={item.sourceUrl} rel="noreferrer" target="_blank">
                View source ↗
              </a>
            )}
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
