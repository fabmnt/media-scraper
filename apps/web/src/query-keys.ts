const ALL_MEDIA_QUERY_KEY = ['media'] as const;

export const queryKeys = {
  collections: ['collections'] as const,
  instagramCredential: ['credentials', 'instagram'] as const,
  allMedia: ALL_MEDIA_QUERY_KEY,
  media: (platform?: string, search?: string) =>
    [...ALL_MEDIA_QUERY_KEY, platform, search] as const,
};
