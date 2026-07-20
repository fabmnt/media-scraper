import { useQueries } from '@tanstack/react-query';
import { PLATFORM_LABELS, SUPPORTED_PLATFORMS } from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function CredentialSessionBanner() {
  const sessions = useQueries({
    queries: SUPPORTED_PLATFORMS.map((platform) => ({
      queryKey: queryKeys.credential(platform),
      queryFn: () => api.getCredential(platform),
    })),
  });
  const expiredPlatforms = SUPPORTED_PLATFORMS.filter(
    (_platform, index) => sessions[index]?.data?.session?.status === 'expired',
  );
  if (expiredPlatforms.length === 0) return null;

  const labels = expiredPlatforms
    .map((platform) => PLATFORM_LABELS[platform])
    .join(', ');
  return (
    <div className="session-banner" role="alert">
      <span>
        <strong>{labels}</strong>{' '}
        {expiredPlatforms.length > 1 ? 'sessions have' : 'session has'} expired.
        Media collection will fail until the stored{' '}
        {expiredPlatforms.length > 1 ? 'cookies are' : 'cookies is'} replaced.
      </span>
      <a href="#authentication">Update credentials</a>
    </div>
  );
}
