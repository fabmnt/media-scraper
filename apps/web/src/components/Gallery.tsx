import { useEffect, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  SUPPORTED_PLATFORMS,
  type MediaItem,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';
import { MediaPreview } from './MediaPreview';

const MEDIA_PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 350;
const UNGROUPED_LABEL = 'All media';
const UNKNOWN_CREATOR_LABEL = 'Unknown creator';
type GroupMode = 'none' | 'creator' | 'platform';

function MediaCard({
  item,
  deleteDisabled,
  isDeleting,
  onDelete,
  onPreview,
}: {
  deleteDisabled: boolean;
  item: MediaItem;
  isDeleting: boolean;
  onDelete: () => void;
  onPreview: () => void;
}) {
  const [assetIndex, setAssetIndex] = useState(0);
  const selectedAsset = item.assets[assetIndex] ?? item.assets[0];
  const hasMultipleAssets = item.assets.length > 1;

  useEffect(() => {
    if (assetIndex >= item.assets.length) setAssetIndex(0);
  }, [assetIndex, item.assets.length]);

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

export function Gallery() {
  const [platform, setPlatform] = useState<Platform | undefined>();
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [previewItemId, setPreviewItemId] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const queryClient = useQueryClient();

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [search]);

  const media = useInfiniteQuery({
    queryKey: queryKeys.media(platform, debouncedSearch),
    queryFn: ({ pageParam }) =>
      api.listMedia({
        limit: MEDIA_PAGE_SIZE,
        offset: pageParam,
        platform,
        search: debouncedSearch || undefined,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
  const remove = useMutation({
    mutationFn: api.deleteMedia,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.allMedia });
    },
  });

  function deleteItem(item: MediaItem) {
    if (window.confirm('Delete this item and its downloaded files?')) {
      remove.mutate(item.id);
    }
  }

  const items = media.data?.pages.flatMap((page) => page.items) ?? [];
  const groupedItems = new Map<string, MediaItem[]>();
  for (const item of items) {
    let group = UNGROUPED_LABEL;
    if (groupMode === 'creator') {
      group = item.authorName?.trim() || UNKNOWN_CREATOR_LABEL;
    } else if (groupMode === 'platform') {
      group = item.platform;
    }
    const groupItems = groupedItems.get(group) ?? [];
    groupItems.push(item);
    groupedItems.set(group, groupItems);
  }
  const groups = [...groupedItems.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const previewItems = groups.flatMap(([, groupItems]) => groupItems);

  return (
    <>
      <section className="gallery-section">
        <div className="section-heading gallery-heading">
          <div>
            <span className="eyebrow">YOUR LIBRARY</span>
            <h2>Collected media</h2>
          </div>
          <span className="library-count">
            {items.length} item{items.length === 1 ? '' : 's'} loaded
          </span>
        </div>
        <div className="library-toolbar">
          <input
            aria-label="Search media"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search captions or creators"
            type="search"
            value={search}
          />
          <select
            aria-label="Filter platform"
            onChange={(event) =>
              setPlatform(
                (event.target.value || undefined) as Platform | undefined,
              )
            }
            value={platform ?? ''}
          >
            <option value="">All platforms</option>
            {SUPPORTED_PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            aria-label="Group media"
            onChange={(event) => setGroupMode(event.target.value as GroupMode)}
            value={groupMode}
          >
            <option value="none">No grouping</option>
            <option value="creator">Group by username</option>
            <option value="platform">Group by platform</option>
          </select>
        </div>
        {media.isLoading && (
          <p className="empty-state">Loading your library…</p>
        )}
        {(media.error || remove.error) && (
          <p className="error">{(media.error ?? remove.error)?.message}</p>
        )}
        {!media.isLoading && items.length === 0 && (
          <p className="empty-state">Your collected media will appear here.</p>
        )}
        <div className="media-groups">
          {groups.map(([group, groupItems]) => (
            <section className="media-group" key={group}>
              {groupMode !== 'none' && (
                <div className="group-heading">
                  <h3>{group}</h3>
                  <span>{groupItems.length}</span>
                </div>
              )}
              <div className="media-grid">
                {groupItems.map((item) => (
                  <MediaCard
                    deleteDisabled={remove.isPending}
                    isDeleting={
                      remove.isPending && remove.variables === item.id
                    }
                    item={item}
                    key={item.id}
                    onDelete={() => deleteItem(item)}
                    onPreview={() => setPreviewItemId(item.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        {media.hasNextPage && (
          <button
            className="load-more-button"
            disabled={media.isFetchingNextPage}
            onClick={() => void media.fetchNextPage()}
            type="button"
          >
            {media.isFetchingNextPage ? 'Loading…' : 'Load more media'}
          </button>
        )}
      </section>
      {previewItemId && (
        <MediaPreview
          initialItemId={previewItemId}
          items={previewItems}
          onClose={() => setPreviewItemId(undefined)}
        />
      )}
    </>
  );
}
