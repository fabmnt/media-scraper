import type { Platform } from '@media-scraper/shared';

const ALL_MEDIA_QUERY_KEY = ['media'] as const;

export const queryKeys = {
  session: ['session'] as const,
  collections: ['collections'] as const,
  recentCollections: ['collections', 'recent'] as const,
  failedCollections: ['collections', 'failed'] as const,
  activeCollections: (status: 'queued' | 'processing') =>
    ['collections', 'active', status] as const,
  credential: (platform: Platform) => ['credentials', platform] as const,
  allMedia: ALL_MEDIA_QUERY_KEY,
  media: (platform?: string, search?: string) =>
    [...ALL_MEDIA_QUERY_KEY, platform, search] as const,
};
