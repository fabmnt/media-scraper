import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AUTOMATIC_COLLECTION_INTERVAL_OPTIONS,
  STORY_SUPPORTED_PLATFORMS,
  SUPPORTED_PLATFORMS,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function ProfileArchiveForm() {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [username, setUsername] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [includeStories, setIncludeStories] = useState(false);
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: api.createProfileArchive,
    onMutate: () => setMessage(''),
    onSuccess: (result) => {
      setUsername('');
      setIncludeStories(false);
      setMessage(
        `Archive started and @${result.profile.username} is now being watched.`,
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automaticProfiles,
      });
    },
  });
  const supportsStories = STORY_SUPPORTED_PLATFORMS.includes(platform);

  function submitArchive(event: FormEvent) {
    event.preventDefault();
    archive.mutate({
      platform,
      username,
      intervalMinutes,
      includeStories: supportsStories && includeStories,
    });
  }

  return (
    <section className="automatic-collections">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ARCHIVE A PROFILE</span>
          <h2>Collect everything and keep watching</h2>
          <p>
            Archive all available profile media in the background, then keep
            collecting new posts on your chosen schedule.
          </p>
        </div>
      </div>
      <form className="automatic-profile-form" onSubmit={submitArchive}>
        <select
          aria-label="Profile archive platform"
          onChange={(event) => {
            const nextPlatform = event.target.value as Platform;
            setPlatform(nextPlatform);
            if (!STORY_SUPPORTED_PLATFORMS.includes(nextPlatform)) {
              setIncludeStories(false);
            }
          }}
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
          aria-label="Profile archive username"
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
          placeholder="@username"
          required
          value={username}
        />
        <select
          aria-label="Profile archive interval"
          onChange={(event) => setIntervalMinutes(Number(event.target.value))}
          value={intervalMinutes}
        >
          {AUTOMATIC_COLLECTION_INTERVAL_OPTIONS.map((interval) => (
            <option key={interval.minutes} value={interval.minutes}>
              Every {interval.label}
            </option>
          ))}
        </select>
        {supportsStories && (
          <label className="automatic-story-toggle">
            <input
              checked={includeStories}
              onChange={(event) => setIncludeStories(event.target.checked)}
              type="checkbox"
            />
            Include current stories
          </label>
        )}
        <button disabled={archive.isPending} type="submit">
          {archive.isPending ? 'Starting…' : 'Archive and watch profile'}
        </button>
      </form>
      {archive.error && <p className="error">{archive.error.message}</p>}
      {message && <p className="queue-success">{message}</p>}
    </section>
  );
}
