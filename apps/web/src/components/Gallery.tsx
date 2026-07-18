import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MEDIA_LIBRARY_PAGE_SIZE,
  SUPPORTED_PLATFORMS,
  type MediaGroupMode,
  type MediaItem,
  type MediaItemGroup,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';
import { MediaCard } from './MediaCard';
import { MediaPreview } from './MediaPreview';

const SEARCH_DEBOUNCE_MS = 350;
interface LoadedGroupPage {
  items: MediaItem[];
  nextOffset: number | null;
}

interface LoadedGroupPages {
  dataUpdatedAt: number;
  groups: Record<string, LoadedGroupPage>;
  requestKey: string;
}

export function Gallery() {
  const [platform, setPlatform] = useState<Platform | undefined>();
  const [groupMode, setGroupMode] = useState<MediaGroupMode>('none');
  const [previewItemId, setPreviewItemId] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loadedPages, setLoadedPages] = useState<LoadedGroupPages>();
  const queryClient = useQueryClient();

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [search]);

  const requestKey = JSON.stringify([
    groupMode,
    platform ?? null,
    debouncedSearch,
  ]);
  const media = useQuery({
    queryKey: queryKeys.media(groupMode, platform, debouncedSearch),
    queryFn: () =>
      api.listMedia({
        groupBy: groupMode,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        platform,
        search: debouncedSearch || undefined,
      }),
  });
  const activeRequest = useRef({
    dataUpdatedAt: media.dataUpdatedAt,
    requestKey,
  });
  activeRequest.current = { dataUpdatedAt: media.dataUpdatedAt, requestKey };

  const loadMore = useMutation({
    mutationFn: ({
      groupKey,
      offset,
    }: {
      dataUpdatedAt: number;
      groupKey: string;
      offset: number;
      requestKey: string;
    }) =>
      api.listMedia({
        groupBy: groupMode,
        ...(groupMode === 'none' ? {} : { groupKey }),
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset,
        platform,
        search: debouncedSearch || undefined,
      }),
    onSuccess: (page, request) => {
      if (
        request.requestKey !== activeRequest.current.requestKey ||
        request.dataUpdatedAt !== activeRequest.current.dataUpdatedAt
      ) {
        return;
      }
      const nextGroup = page.groups[0];
      if (!nextGroup) return;

      setLoadedPages((current) => {
        const currentGroups =
          current?.requestKey === request.requestKey &&
          current.dataUpdatedAt === request.dataUpdatedAt
            ? current.groups
            : {};
        const previousGroup = currentGroups[request.groupKey];
        const itemsById = new Map(
          previousGroup?.items.map((item) => [item.id, item]),
        );
        for (const item of nextGroup.items) itemsById.set(item.id, item);
        return {
          dataUpdatedAt: request.dataUpdatedAt,
          requestKey: request.requestKey,
          groups: {
            ...currentGroups,
            [request.groupKey]: {
              items: [...itemsById.values()],
              nextOffset: nextGroup.nextOffset,
            },
          },
        };
      });
    },
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

  function loadGroup(group: MediaItemGroup) {
    if (group.nextOffset === null) return;
    loadMore.mutate({
      dataUpdatedAt: media.dataUpdatedAt,
      groupKey: group.key,
      offset: group.nextOffset,
      requestKey,
    });
  }

  const currentLoadedPages =
    loadedPages?.requestKey === requestKey &&
    loadedPages.dataUpdatedAt === media.dataUpdatedAt
      ? loadedPages.groups
      : {};
  const groups = (media.data?.groups ?? []).map((group) => {
    const loadedGroup = currentLoadedPages[group.key];
    if (!loadedGroup) return group;

    const itemsById = new Map(group.items.map((item) => [item.id, item]));
    for (const item of loadedGroup.items) itemsById.set(item.id, item);
    return {
      ...group,
      items: [...itemsById.values()],
      nextOffset: loadedGroup.nextOffset,
    };
  });
  const items = groups.flatMap((group) => group.items);

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
            placeholder="Search usernames or captions"
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
            onChange={(event) =>
              setGroupMode(event.target.value as MediaGroupMode)
            }
            value={groupMode}
          >
            <option value="none">No grouping</option>
            <option value="username">Group by username</option>
            <option value="platform">Group by platform</option>
          </select>
        </div>
        {media.isLoading && (
          <p className="empty-state">Loading your library…</p>
        )}
        {(media.error || remove.error || loadMore.error) && (
          <p className="error">
            {(media.error ?? remove.error ?? loadMore.error)?.message}
          </p>
        )}
        {!media.isLoading && items.length === 0 && (
          <p className="empty-state">Your collected media will appear here.</p>
        )}
        <div className="media-groups">
          {groups.map((group) => {
            const isLoadingGroup =
              loadMore.isPending && loadMore.variables?.groupKey === group.key;
            return (
              <section className="media-group" key={group.key}>
                {groupMode !== 'none' && (
                  <div className="group-heading">
                    <h3>{group.label}</h3>
                    <span>{group.items.length}</span>
                  </div>
                )}
                <div className="media-grid">
                  {group.items.map((item) => (
                    <MediaCard
                      deleteDisabled={remove.isPending}
                      isDeleting={
                        remove.isPending && remove.variables === item.id
                      }
                      item={item}
                      key={item.id}
                      onDelete={() => deleteItem(item)}
                      onPreview={() => setPreviewItemId(item.id)}
                      previewOpen={Boolean(previewItemId)}
                    />
                  ))}
                </div>
                {group.nextOffset !== null && (
                  <button
                    className="load-more-button"
                    disabled={loadMore.isPending}
                    onClick={() => loadGroup(group)}
                    type="button"
                  >
                    {isLoadingGroup ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      </section>
      {previewItemId && (
        <MediaPreview
          initialItemId={previewItemId}
          items={items}
          onClose={() => setPreviewItemId(undefined)}
        />
      )}
    </>
  );
}
