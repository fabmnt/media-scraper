import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORTED_PLATFORMS,
  type MediaItem,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

function MediaCard({
  item,
  onDelete,
}: {
  item: MediaItem;
  onDelete: () => void;
}) {
  const [assetIndex, setAssetIndex] = useState(0);
  const selectedAsset = item.assets[assetIndex] ?? item.assets[0];
  const hasMultipleAssets = item.assets.length > 1;

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
      {hasMultipleAssets && (
        <div className="asset-strip">
          {item.assets.map((asset, index) => (
            <button
              aria-label={`Show ${asset.type} ${index + 1}`}
              className={index === assetIndex ? 'selected' : ''}
              key={asset.id}
              onClick={() => setAssetIndex(index)}
              type="button"
            >
              {asset.type === 'image' ? (
                <img alt="" loading="lazy" src={api.mediaUrl(asset.url)} />
              ) : (
                <span>VIDEO</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="card-body">
        <strong>{item.authorName ?? 'Unknown creator'}</strong>
        <p>{item.caption ?? 'No caption available'}</p>
        <div className="card-actions">
          <a href={item.sourceUrl} rel="noreferrer" target="_blank">
            Source
          </a>
          {selectedAsset && (
            <a download href={api.mediaUrl(selectedAsset.url)}>
              Download {hasMultipleAssets ? `${assetIndex + 1}` : ''}
            </a>
          )}
          <button onClick={onDelete} type="button">
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}

export function Gallery() {
  const [platform, setPlatform] = useState<Platform | undefined>();
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();
  const media = useQuery({
    queryKey: queryKeys.media(platform, search),
    queryFn: () => api.listMedia({ platform, search: search || undefined }),
    refetchInterval: 5_000,
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

  return (
    <section className="gallery-section">
      <div className="section-heading gallery-heading">
        <div>
          <span className="eyebrow">YOUR LIBRARY</span>
          <h2>Collected media</h2>
        </div>
        <div className="filters">
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
        </div>
      </div>
      {media.isLoading && <p className="empty-state">Loading your library…</p>}
      {media.error && <p className="error">{media.error.message}</p>}
      {media.data?.length === 0 && (
        <p className="empty-state">Your collected media will appear here.</p>
      )}
      <div className="media-grid">
        {media.data?.map((item) => (
          <MediaCard
            item={item}
            key={item.id}
            onDelete={() => deleteItem(item)}
          />
        ))}
      </div>
    </section>
  );
}
