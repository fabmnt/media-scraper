import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_COLLECTION_BATCH_SIZE,
  SUPPORTED_PLATFORMS,
  type Platform,
  type ProfileLookupInput,
  type ProfileMedia,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function ProfileCollectionForm() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [username, setUsername] = useState('');
  const [media, setMedia] = useState<ProfileMedia[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeLookup, setActiveLookup] = useState<
    Omit<ProfileLookupInput, 'cursor'> | undefined
  >();
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  const [queueMessage, setQueueMessage] = useState('');
  const queryClient = useQueryClient();
  const discovery = useMutation({
    mutationFn: api.discoverProfile,
    onMutate: (input) => {
      if (input.cursor) return;
      setMedia([]);
      setNextCursor(null);
      setActiveLookup({ platform: input.platform, username: input.username });
      setSelectedUrls([]);
      setQueueMessage('');
    },
    onSuccess: (result, input) => {
      setMedia((current) => {
        if (!input.cursor) return result.items;
        const mediaByUrl = new Map(
          current.map((item) => [item.sourceUrl, item]),
        );
        for (const item of result.items) mediaByUrl.set(item.sourceUrl, item);
        return [...mediaByUrl.values()];
      });
      setNextCursor(result.nextCursor);
    },
  });
  const queue = useMutation({
    mutationFn: (media: ProfileMedia[]) =>
      api.createCollectionBatch({
        items: media.map((item) => ({ url: item.sourceUrl })),
      }),
    onMutate: () => setQueueMessage(''),
    onSuccess: (collections) => {
      const queuedCollections = collections.filter(
        (collection) => collection.status === 'queued',
      );
      const queuedUrlSet = new Set(
        queuedCollections.map((collection) => collection.sourceUrl),
      );
      setSelectedUrls((current) =>
        current.filter((url) => !queuedUrlSet.has(url)),
      );
      const failedCount = collections.length - queuedCollections.length;
      setQueueMessage(
        failedCount > 0
          ? `${String(queuedCollections.length)} queued; ${String(failedCount)} could not be queued.`
          : `${String(queuedCollections.length)} media item${queuedCollections.length === 1 ? '' : 's'} queued.`,
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
    },
  });

  const selectedUrlSet = new Set(selectedUrls);
  const selectedMedia = media.filter((item) =>
    selectedUrlSet.has(item.sourceUrl),
  );
  const selectionLimitReached =
    selectedUrls.length >= MAX_COLLECTION_BATCH_SIZE;

  function findProfile(event: FormEvent) {
    event.preventDefault();
    discovery.mutate({ platform, username });
  }

  function loadMore() {
    if (!activeLookup || !nextCursor) return;
    discovery.mutate({ ...activeLookup, cursor: nextCursor });
  }

  function toggleSelection(sourceUrl: string) {
    setSelectedUrls((current) => {
      if (current.includes(sourceUrl)) {
        return current.filter((url) => url !== sourceUrl);
      }
      return current.length < MAX_COLLECTION_BATCH_SIZE
        ? [...current, sourceUrl]
        : current;
    });
    setQueueMessage('');
  }

  return (
    <section className="profile-collector">
      <div className="profile-collector-heading">
        <div>
          <span className="eyebrow">FIND A PROFILE</span>
          <h2>Choose media by username</h2>
          <p>
            Load recent public media, select only what you want, then add it to
            the download queue.
          </p>
        </div>
        <form onSubmit={findProfile}>
          <select
            aria-label="Profile platform"
            onChange={(event) => setPlatform(event.target.value as Platform)}
            value={platform}
          >
            {SUPPORTED_PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {item[0]?.toUpperCase()}
                {item.slice(1)}
              </option>
            ))}
          </select>
          <input
            aria-label="Profile username"
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
            placeholder="@username"
            required
            value={username}
          />
          <button disabled={discovery.isPending} type="submit">
            {discovery.isPending ? 'Loading…' : 'Find media'}
          </button>
        </form>
      </div>

      {discovery.error && (
        <p className="error" role="alert">
          {discovery.error.message}
        </p>
      )}

      {activeLookup &&
        !discovery.isPending &&
        !discovery.error &&
        media.length === 0 &&
        !nextCursor && (
          <div className="empty-state">
            No public media was found for this profile.
          </div>
        )}

      {media.length > 0 && (
        <>
          <div className="profile-selection-toolbar">
            <span>
              {selectedUrls.length} of {media.length} selected ·{' '}
              {MAX_COLLECTION_BATCH_SIZE} maximum
            </span>
            <div>
              <button
                className="text-button"
                onClick={() =>
                  setSelectedUrls(
                    media
                      .slice(0, MAX_COLLECTION_BATCH_SIZE)
                      .map((item) => item.sourceUrl),
                  )
                }
                type="button"
              >
                Select all
              </button>
              <button
                className="text-button"
                onClick={() => setSelectedUrls([])}
                type="button"
              >
                Clear
              </button>
              <button
                disabled={selectedMedia.length === 0 || queue.isPending}
                onClick={() => queue.mutate(selectedMedia)}
                type="button"
              >
                {queue.isPending
                  ? 'Queuing…'
                  : `Collect selected (${String(selectedMedia.length)})`}
              </button>
            </div>
          </div>

          {selectionLimitReached && media.length > selectedUrls.length && (
            <p className="profile-selection-limit" role="status">
              Selection limit reached. Deselect an item to choose another.
            </p>
          )}

          <div className="profile-media-grid">
            {media.map((item) => {
              const isSelected = selectedUrlSet.has(item.sourceUrl);
              const isSelectionDisabled = !isSelected && selectionLimitReached;
              return (
                <label
                  className={`profile-media-option${isSelected ? ' selected' : ''}${isSelectionDisabled ? ' disabled' : ''}`}
                  key={item.sourceUrl}
                >
                  <input
                    checked={isSelected}
                    disabled={isSelectionDisabled}
                    onChange={() => toggleSelection(item.sourceUrl)}
                    type="checkbox"
                  />
                  <div className="profile-media-thumbnail">
                    {item.thumbnailUrl ? (
                      <img
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        src={item.thumbnailUrl}
                      />
                    ) : (
                      <span>No preview</span>
                    )}
                    <span className="profile-media-kind">
                      {item.type}
                      {item.assetCount > 1
                        ? ` · ${String(item.assetCount)}`
                        : ''}
                    </span>
                  </div>
                  <div className="profile-media-details">
                    <strong>{isSelected ? 'Selected' : 'Select media'}</strong>
                    <span>
                      {item.publishedAt
                        ? new Date(item.publishedAt).toLocaleDateString()
                        : 'Date unavailable'}
                    </span>
                    <p>{item.caption || 'No caption'}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </>
      )}

      {nextCursor && (
        <div className="profile-load-more">
          <button
            disabled={discovery.isPending}
            onClick={loadMore}
            type="button"
          >
            {discovery.isPending ? 'Loading more…' : 'Load more'}
          </button>
        </div>
      )}

      {queue.error && (
        <p className="error" role="alert">
          Could not queue the selected media. {queue.error.message}
        </p>
      )}
      {queueMessage && (
        <p className="queue-success" role="status">
          {queueMessage}
        </p>
      )}
    </section>
  );
}
