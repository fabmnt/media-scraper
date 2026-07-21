import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANUAL_UPLOAD_LABEL,
  MEDIA_GROUP_MODES,
  MEDIA_LIBRARY_PAGE_SIZE,
  MEDIA_PLATFORMS,
  MEDIA_SORT_OPTIONS,
  type MediaGroupMode,
  type MediaItem,
  type MediaItemGroup,
  type MediaPlatform,
  type MediaSort,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';
import { MediaCard } from './MediaCard';
import { MediaPreview } from './MediaPreview';
import { ProfileCollectionProgress } from './ProfileCollectionProgress';

const SEARCH_DEBOUNCE_MS = 350;
const GALLERY_QUERY_PARAMETER = {
  groupMode: 'groupBy',
  platform: 'platform',
  search: 'search',
  sortBy: 'sortBy',
} as const;

interface GalleryFilters {
  groupMode: MediaGroupMode;
  platform: MediaPlatform | undefined;
  search: string;
  sortBy: MediaSort;
}

interface LoadedGroupPage {
  items: MediaItem[];
  nextOffset: number | null;
}

interface LoadedGroupPages {
  additionalGroups: MediaItemGroup[];
  dataUpdatedAt: number;
  groups: Record<string, LoadedGroupPage>;
  nextGroupOffset: number | null;
  requestKey: string;
}

function filtersFromUrl(): GalleryFilters {
  const searchParameters = new URLSearchParams(window.location.search);
  const platform = MEDIA_PLATFORMS.find(
    (item) => item === searchParameters.get(GALLERY_QUERY_PARAMETER.platform),
  );
  const groupMode = MEDIA_GROUP_MODES.find(
    (item) => item === searchParameters.get(GALLERY_QUERY_PARAMETER.groupMode),
  );
  const sortBy = MEDIA_SORT_OPTIONS.find(
    (item) => item === searchParameters.get(GALLERY_QUERY_PARAMETER.sortBy),
  );

  return {
    groupMode: groupMode ?? 'none',
    platform,
    search: searchParameters.get(GALLERY_QUERY_PARAMETER.search) ?? '',
    sortBy: sortBy ?? 'collectedAt',
  };
}

export function Gallery() {
  const [filters, setFilters] = useState(filtersFromUrl);
  const { groupMode, platform, search, sortBy } = filters;
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [previewItemId, setPreviewItemId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string>();
  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());
  const [loadedPages, setLoadedPages] = useState<LoadedGroupPages>();
  const shouldPushFilterHistory = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const searchValue = search.trim();
    if (platform) {
      url.searchParams.set(GALLERY_QUERY_PARAMETER.platform, platform);
    } else {
      url.searchParams.delete(GALLERY_QUERY_PARAMETER.platform);
    }
    if (groupMode !== 'none') {
      url.searchParams.set(GALLERY_QUERY_PARAMETER.groupMode, groupMode);
    } else {
      url.searchParams.delete(GALLERY_QUERY_PARAMETER.groupMode);
    }
    if (sortBy !== 'collectedAt') {
      url.searchParams.set(GALLERY_QUERY_PARAMETER.sortBy, sortBy);
    } else {
      url.searchParams.delete(GALLERY_QUERY_PARAMETER.sortBy);
    }
    if (searchValue) {
      url.searchParams.set(GALLERY_QUERY_PARAMETER.search, searchValue);
    } else {
      url.searchParams.delete(GALLERY_QUERY_PARAMETER.search);
    }
    const historyUpdate = shouldPushFilterHistory.current
      ? 'pushState'
      : 'replaceState';
    window.history[historyUpdate](
      null,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    shouldPushFilterHistory.current = false;
  }, [groupMode, platform, search, sortBy]);

  useEffect(() => {
    const syncFiltersWithUrl = () => setFilters(filtersFromUrl());
    window.addEventListener('popstate', syncFiltersWithUrl);
    return () => window.removeEventListener('popstate', syncFiltersWithUrl);
  }, []);

  function updateFilters(updates: Partial<GalleryFilters>) {
    shouldPushFilterHistory.current = true;
    setFilters((current) => ({ ...current, ...updates }));
  }

  const effectiveGroupMode = debouncedSearch ? 'none' : groupMode;
  const requestKey = JSON.stringify([
    effectiveGroupMode,
    platform ?? null,
    debouncedSearch,
    sortBy,
  ]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [requestKey]);
  const media = useQuery({
    queryKey: queryKeys.media(
      effectiveGroupMode,
      platform,
      debouncedSearch,
      sortBy,
    ),
    queryFn: () =>
      api.listMedia({
        groupBy: effectiveGroupMode,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        platform,
        search: debouncedSearch || undefined,
        sortBy,
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
        groupBy: effectiveGroupMode,
        ...(effectiveGroupMode === 'none' ? {} : { groupKey }),
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset,
        platform,
        search: debouncedSearch || undefined,
        sortBy,
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
        const currentPages =
          current?.requestKey === request.requestKey &&
          current.dataUpdatedAt === request.dataUpdatedAt
            ? current
            : {
                additionalGroups: [],
                dataUpdatedAt: request.dataUpdatedAt,
                groups: {},
                nextGroupOffset: media.data?.nextGroupOffset ?? null,
                requestKey: request.requestKey,
              };
        const previousGroup = currentPages.groups[request.groupKey];
        const itemsById = new Map(
          previousGroup?.items.map((item) => [item.id, item]),
        );
        for (const item of nextGroup.items) itemsById.set(item.id, item);
        return {
          dataUpdatedAt: request.dataUpdatedAt,
          requestKey: request.requestKey,
          additionalGroups: currentPages.additionalGroups,
          groups: {
            ...currentPages.groups,
            [request.groupKey]: {
              items: [...itemsById.values()],
              nextOffset: nextGroup.nextOffset,
            },
          },
          nextGroupOffset: currentPages.nextGroupOffset,
        };
      });
    },
  });
  const loadMoreGroups = useMutation({
    mutationFn: ({
      groupOffset,
    }: {
      dataUpdatedAt: number;
      groupOffset: number;
      requestKey: string;
    }) =>
      api.listMedia({
        groupBy: effectiveGroupMode,
        groupOffset,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        platform,
        sortBy,
      }),
    onSuccess: (page, request) => {
      if (
        request.requestKey !== activeRequest.current.requestKey ||
        request.dataUpdatedAt !== activeRequest.current.dataUpdatedAt
      ) {
        return;
      }

      setLoadedPages((current) => {
        const currentPages =
          current?.requestKey === request.requestKey &&
          current.dataUpdatedAt === request.dataUpdatedAt
            ? current
            : {
                additionalGroups: [],
                dataUpdatedAt: request.dataUpdatedAt,
                groups: {},
                nextGroupOffset: media.data?.nextGroupOffset ?? null,
                requestKey: request.requestKey,
              };
        const groupsByKey = new Map(
          currentPages.additionalGroups.map((group) => [group.key, group]),
        );
        for (const group of page.groups) groupsByKey.set(group.key, group);
        return {
          ...currentPages,
          additionalGroups: [...groupsByKey.values()],
          nextGroupOffset: page.nextGroupOffset,
        };
      });
    },
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) => Promise.allSettled(ids.map(api.deleteMedia)),
    onMutate: () => setDeleteError(undefined),
    onSuccess: (results, ids) => {
      const successfulIds = ids.filter(
        (_, index) => results[index]?.status === 'fulfilled',
      );
      const failedIds = ids.filter(
        (_, index) => results[index]?.status === 'rejected',
      );
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of successfulIds) next.delete(id);
        return next;
      });
      if (failedIds.length > 0) {
        setDeleteError(`Could not delete media: ${failedIds.join(', ')}`);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.allMedia }),
  });

  const deleteMedia = remove.mutate;
  const deleteItem = useCallback(
    (item: MediaItem) => {
      if (window.confirm('Delete this item and its downloaded files?')) {
        deleteMedia([item.id]);
      }
    },
    [deleteMedia],
  );
  const openPreview = useCallback((itemId: string) => {
    setPreviewItemId(itemId);
  }, []);
  const toggleItemSelection = useCallback((itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  function deleteSelectedItems() {
    const selectedItemIds = items
      .filter((item) => selectedIds.has(item.id))
      .map((item) => item.id);
    if (
      selectedItemIds.length > 0 &&
      window.confirm(
        `Delete ${selectedItemIds.length} selected item${selectedItemIds.length === 1 ? '' : 's'} and their downloaded files?`,
      )
    ) {
      remove.mutate(selectedItemIds);
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

  function loadGroups() {
    if (nextGroupOffset === null) return;
    loadMoreGroups.mutate({
      dataUpdatedAt: media.dataUpdatedAt,
      groupOffset: nextGroupOffset,
      requestKey,
    });
  }

  const currentLoadedPages =
    loadedPages?.requestKey === requestKey &&
    loadedPages.dataUpdatedAt === media.dataUpdatedAt
      ? loadedPages
      : undefined;
  const groupsByKey = new Map(
    (media.data?.groups ?? []).map((group) => [group.key, group]),
  );
  for (const group of currentLoadedPages?.additionalGroups ?? []) {
    groupsByKey.set(group.key, group);
  }
  const groups = [...groupsByKey.values()].map((group) => {
    const loadedGroup = currentLoadedPages?.groups[group.key];
    if (!loadedGroup) return group;

    const itemsById = new Map(group.items.map((item) => [item.id, item]));
    for (const item of loadedGroup.items) itemsById.set(item.id, item);
    return {
      ...group,
      items: [...itemsById.values()],
      nextOffset: loadedGroup.nextOffset,
    };
  });
  const nextGroupOffset = currentLoadedPages
    ? currentLoadedPages.nextGroupOffset
    : (media.data?.nextGroupOffset ?? null);
  const items = groups.flatMap((group) => group.items);
  const selectedItemCount = selectedIds.size;
  const errorMessage =
    (media.error ?? remove.error ?? loadMore.error ?? loadMoreGroups.error)
      ?.message ?? deleteError;

  return (
    <>
      <ProfileCollectionProgress />
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
            onChange={(event) => updateFilters({ search: event.target.value })}
            placeholder="Search usernames or captions"
            type="search"
            value={search}
          />
          <select
            aria-label="Filter platform"
            onChange={(event) =>
              updateFilters({
                platform: (event.target.value || undefined) as
                  MediaPlatform | undefined,
              })
            }
            value={platform ?? ''}
          >
            <option value="">All platforms</option>
            {MEDIA_PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {item === 'manual' ? MANUAL_UPLOAD_LABEL : item}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort media"
            onChange={(event) =>
              updateFilters({ sortBy: event.target.value as MediaSort })
            }
            value={sortBy}
          >
            <option value="collectedAt">Newest collected</option>
            <option value="publishedAt">Newest published</option>
          </select>
          <select
            aria-label="Group media"
            onChange={(event) =>
              updateFilters({ groupMode: event.target.value as MediaGroupMode })
            }
            value={groupMode}
          >
            <option value="none">No grouping</option>
            <option value="username">Group by username</option>
            <option value="platform">Group by platform</option>
          </select>
        </div>
        <div className="media-selection-toolbar">
          <span>
            {selectedItemCount} selected / {items.length} loaded
          </span>
          <div>
            <button
              className="text-button"
              disabled={items.length === 0}
              onClick={() =>
                setSelectedIds(new Set(items.map((item) => item.id)))
              }
              type="button"
            >
              Select all loaded
            </button>
            <button
              className="text-button"
              disabled={selectedItemCount === 0}
              onClick={() => setSelectedIds(new Set())}
              type="button"
            >
              Clear selection
            </button>
            <button
              className="danger-button"
              disabled={remove.isPending || selectedItemCount === 0}
              onClick={deleteSelectedItems}
              type="button"
            >
              Delete selected
            </button>
          </div>
        </div>
        {media.isLoading && (
          <p className="empty-state">Loading your library…</p>
        )}
        {errorMessage && <p className="error">{errorMessage}</p>}
        {!media.isLoading && items.length === 0 && (
          <p className="empty-state">Your collected media will appear here.</p>
        )}
        <div className="media-groups">
          {groups.map((group) => {
            const isGrouped = effectiveGroupMode !== 'none';
            const isCollapsed =
              isGrouped && Boolean(collapsedGroups[group.key]);
            const isLoadingGroup =
              loadMore.isPending && loadMore.variables?.groupKey === group.key;
            const groupContentId = `media-group-${group.key}`;
            return (
              <section className="media-group" key={group.key}>
                {isGrouped && (
                  <h3 className="group-heading">
                    <button
                      aria-controls={groupContentId}
                      aria-expanded={!isCollapsed}
                      className="group-toggle"
                      onClick={() =>
                        setCollapsedGroups((current) => ({
                          ...current,
                          [group.key]: !current[group.key],
                        }))
                      }
                      type="button"
                    >
                      <span className="group-label">{group.label}</span>
                      <span className="group-item-count">
                        {group.items.length}
                      </span>
                      <span aria-hidden="true" className="group-toggle-icon">
                        {isCollapsed ? '+' : '−'}
                      </span>
                    </button>
                  </h3>
                )}
                <div
                  hidden={isCollapsed}
                  id={isGrouped ? groupContentId : undefined}
                >
                  <div className="media-grid">
                    {group.items.map((item) => (
                      <MediaCard
                        deleteDisabled={remove.isPending}
                        isDeleting={
                          remove.isPending &&
                          Boolean(remove.variables?.includes(item.id))
                        }
                        isSelected={selectedIds.has(item.id)}
                        item={item}
                        key={item.id}
                        onDelete={deleteItem}
                        onPreview={openPreview}
                        onSelect={toggleItemSelection}
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
                </div>
              </section>
            );
          })}
        </div>
        {nextGroupOffset !== null && (
          <button
            className="load-more-button"
            disabled={loadMoreGroups.isPending}
            onClick={loadGroups}
            type="button"
          >
            {loadMoreGroups.isPending ? 'Loading…' : 'Load more groups'}
          </button>
        )}
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
