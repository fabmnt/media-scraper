import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTOMATIC_COLLECTION_INTERVAL_OPTIONS,
  MAX_AUTOMATIC_COLLECTION_INTERVAL_MINUTES,
  MIN_AUTOMATIC_COLLECTION_INTERVAL_MINUTES,
  SUPPORTED_PLATFORMS,
  type Platform,
  type UpdateAutomaticProfileInput,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

const AUTOMATIC_PROFILE_STATUS_REFETCH_MS = 15_000;

export function AutomaticCollectionsPanel() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [username, setUsername] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: queryKeys.automaticProfiles,
    queryFn: api.listAutomaticProfiles,
    refetchInterval: AUTOMATIC_PROFILE_STATUS_REFETCH_MS,
  });
  const createProfile = useMutation({
    mutationFn: api.createAutomaticProfile,
    onMutate: () => setMessage(''),
    onSuccess: () => {
      setUsername('');
      setMessage('Automatic collection enabled. The first check was queued.');
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automaticProfiles,
      });
    },
  });
  const updateProfile = useMutation({
    onMutate: () => setMessage(''),
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: UpdateAutomaticProfileInput;
    }) => api.updateAutomaticProfile(id, input),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automaticProfiles,
      });
    },
  });
  const deleteProfile = useMutation({
    onMutate: () => setMessage(''),
    mutationFn: api.deleteAutomaticProfile,
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automaticProfiles,
      });
    },
  });
  const runProfile = useMutation({
    onMutate: () => setMessage(''),
    mutationFn: api.runAutomaticProfile,
    onSuccess: () => setMessage('Profile check queued.'),
  });

  function submitProfile(event: FormEvent) {
    event.preventDefault();
    createProfile.mutate({ platform, username, intervalMinutes });
  }

  const mutationError =
    createProfile.error ??
    updateProfile.error ??
    deleteProfile.error ??
    runProfile.error;
  const isMutating =
    createProfile.isPending ||
    updateProfile.isPending ||
    deleteProfile.isPending ||
    runProfile.isPending;

  return (
    <section className="automatic-collections">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AUTOMATIC COLLECTION</span>
          <h2>Watch profiles for new media</h2>
          <p>
            Check a profile on a bounded schedule and collect media that is not
            already in your archive.
          </p>
        </div>
      </div>

      <form className="automatic-profile-form" onSubmit={submitProfile}>
        <select
          aria-label="Automatic collection platform"
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
          aria-label="Automatic collection username"
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
          placeholder="@username"
          required
          value={username}
        />
        <select
          aria-label="Automatic collection interval"
          onChange={(event) => setIntervalMinutes(Number(event.target.value))}
          value={intervalMinutes}
        >
          {AUTOMATIC_COLLECTION_INTERVAL_OPTIONS.map((interval) => (
            <option key={interval.minutes} value={interval.minutes}>
              Every {interval.label}
            </option>
          ))}
        </select>
        <button disabled={createProfile.isPending} type="submit">
          {createProfile.isPending
            ? 'Enabling…'
            : 'Enable automatic collection'}
        </button>
      </form>
      <small className="automatic-interval-note">
        Intervals are limited to {MIN_AUTOMATIC_COLLECTION_INTERVAL_MINUTES}{' '}
        minutes through {MAX_AUTOMATIC_COLLECTION_INTERVAL_MINUTES / 1_440} days
        to protect extraction capacity.
      </small>

      {profiles.isLoading && (
        <p className="empty-state">Loading watched profiles…</p>
      )}
      {profiles.error && <p className="error">{profiles.error.message}</p>}
      {profiles.data?.length === 0 && (
        <p className="empty-state">No profiles are being watched yet.</p>
      )}
      {profiles.data && profiles.data.length > 0 && (
        <div className="automatic-profile-list">
          {profiles.data.map((profile) => (
            <article className="automatic-profile" key={profile.id}>
              <div>
                <span
                  className={`status ${profile.enabled ? 'status-completed' : 'status-failed'}`}
                >
                  {profile.enabled ? 'active' : 'paused'}
                </span>
                <strong>
                  {profile.platform} · @{profile.username}
                </strong>
                <small>
                  {profile.lastSuccessAt
                    ? `Last successful check ${new Date(profile.lastSuccessAt).toLocaleString()}`
                    : 'Waiting for the first successful check'}
                </small>
                {profile.enabled && profile.nextCheckAt && (
                  <small>
                    Next check around{' '}
                    {new Date(profile.nextCheckAt).toLocaleString()}
                  </small>
                )}
                {profile.lastError && (
                  <small className="error">{profile.lastError}</small>
                )}
              </div>
              <select
                aria-label={`Collection interval for ${profile.username}`}
                disabled={isMutating}
                onChange={(event) =>
                  updateProfile.mutate({
                    id: profile.id,
                    input: { intervalMinutes: Number(event.target.value) },
                  })
                }
                value={profile.intervalMinutes}
              >
                {AUTOMATIC_COLLECTION_INTERVAL_OPTIONS.map((interval) => (
                  <option key={interval.minutes} value={interval.minutes}>
                    Every {interval.label}
                  </option>
                ))}
              </select>
              <div className="automatic-profile-actions">
                <button
                  disabled={isMutating || !profile.enabled}
                  onClick={() => runProfile.mutate(profile.id)}
                  type="button"
                >
                  Check now
                </button>
                <button
                  className="text-button"
                  disabled={isMutating}
                  onClick={() =>
                    updateProfile.mutate({
                      id: profile.id,
                      input: { enabled: !profile.enabled },
                    })
                  }
                  type="button"
                >
                  {profile.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="text-button"
                  disabled={isMutating}
                  onClick={() => deleteProfile.mutate(profile.id)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {mutationError && <p className="error">{mutationError.message}</p>}
      {message && <p className="queue-success">{message}</p>}
    </section>
  );
}
