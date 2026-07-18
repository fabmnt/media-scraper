import { z } from 'zod';

export const SUPPORTED_PLATFORMS = ['instagram', 'facebook', 'tiktok'] as const;
export const COLLECTION_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
] as const;
export const MEDIA_TYPES = ['image', 'video'] as const;
export const MEDIA_MAINTENANCE_TYPES = [
  'delete_local',
  'delete_object',
  'enforce_retention',
] as const;
export const COLLECTION_QUEUE_NAME = 'media-collections';
export const MAX_CREDENTIAL_LENGTH = 1_000_000;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;
export const MAX_PROFILE_MEDIA = 24;
export const PROFILE_DISCOVERY_CACHE_ITEMS = MAX_PROFILE_MEDIA * 4;
export const MAX_PROFILE_CURSOR_LENGTH = 8_192;
export const MAX_PROFILE_SOURCE_CURSOR_LENGTH = MAX_PROFILE_CURSOR_LENGTH * 4;
export const MAX_COLLECTION_BATCH_SIZE = 100;

export const platformSchema = z.enum(SUPPORTED_PLATFORMS);
export const collectionStatusSchema = z.enum(COLLECTION_STATUSES);
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export const mediaMaintenanceTypeSchema = z.enum(MEDIA_MAINTENANCE_TYPES);

export type Platform = z.infer<typeof platformSchema>;
export type CollectionStatus = z.infer<typeof collectionStatusSchema>;
export type MediaType = z.infer<typeof mediaTypeSchema>;
export type MediaMaintenanceType = z.infer<typeof mediaMaintenanceTypeSchema>;

interface PlatformCredentialConfig {
  domain: string;
  fileName: string;
  requiredCookies: readonly string[];
}

export const PLATFORM_CREDENTIALS = {
  instagram: {
    domain: 'instagram.com',
    fileName: 'instagram.cookies.txt',
    requiredCookies: ['sessionid'],
  },
  facebook: {
    domain: 'facebook.com',
    fileName: 'facebook.cookies.txt',
    requiredCookies: ['c_user', 'xs'],
  },
  tiktok: {
    domain: 'tiktok.com',
    fileName: 'tiktok.cookies.txt',
    requiredCookies: ['sid_tt'],
  },
} as const satisfies Record<Platform, PlatformCredentialConfig>;

const SUPPORTED_URL_PROTOCOLS = new Set(['http:', 'https:']);
const PLATFORM_HOSTS: Record<Platform, readonly string[]> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.watch'],
  tiktok: ['tiktok.com'],
};

export function detectPlatform(url: URL): Platform | undefined {
  return SUPPORTED_PLATFORMS.find((platform) =>
    PLATFORM_HOSTS[platform].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    ),
  );
}

export const createCollectionSchema = z
  .object({
    url: z.url().refine((value) => {
      const parsedUrl = new URL(value);
      return (
        SUPPORTED_URL_PROTOCOLS.has(parsedUrl.protocol) &&
        !parsedUrl.username &&
        !parsedUrl.password
      );
    }, 'URL must use HTTP or HTTPS and must not contain credentials'),
  })
  .transform(({ url }) => ({ url, platform: detectPlatform(new URL(url)) }))
  .pipe(
    z.object({
      url: z.url(),
      platform: platformSchema,
    }),
  );

export const createCollectionBatchSchema = z.object({
  items: z.array(createCollectionSchema).min(1).max(MAX_COLLECTION_BATCH_SIZE),
});

export type CreateCollectionInput = z.input<typeof createCollectionSchema>;
export type CreateCollectionBatchInput = z.input<
  typeof createCollectionBatchSchema
>;
export type CollectionJobPayload = z.output<typeof createCollectionSchema> & {
  collectionId: string;
};

const profileUsernameSchema = z
  .string()
  .trim()
  .regex(
    /^@?[A-Za-z0-9._-]{1,100}$/,
    'Enter a username using letters, numbers, dots, underscores, or hyphens',
  )
  .transform((username) => username.replace(/^@/, ''));

export const profileLookupSchema = z.object({
  platform: platformSchema,
  username: profileUsernameSchema,
  cursor: z.string().max(MAX_PROFILE_CURSOR_LENGTH).optional(),
});

export const profileMediaSchema = z.object({
  id: z.string().min(1),
  platform: platformSchema,
  sourceUrl: z.url(),
  thumbnailUrl: z.url().nullable(),
  caption: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  type: mediaTypeSchema,
  assetCount: z.number().int().positive(),
});

export const profileMediaResultsSchema = z.object({
  items: z.array(profileMediaSchema).max(MAX_PROFILE_MEDIA),
  nextCursor: z.string().max(MAX_PROFILE_CURSOR_LENGTH).nullable(),
});

export type ProfileLookupInput = z.input<typeof profileLookupSchema>;
export type ProfileLookup = z.output<typeof profileLookupSchema>;
export type ProfileMedia = z.infer<typeof profileMediaSchema>;
export type ProfileMediaResults = z.infer<typeof profileMediaResultsSchema>;

export const mediaAssetSchema = z.object({
  id: z.uuid(),
  type: mediaTypeSchema,
  fileName: z.string(),
  mimeType: z.string(),
  url: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
});

export const mediaItemSchema = z.object({
  id: z.uuid(),
  platform: platformSchema,
  sourceId: z.string(),
  sourceUrl: z.url(),
  authorName: z.string().nullable(),
  caption: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  collectedAt: z.iso.datetime(),
  thumbnailUrl: z.string().nullable(),
  assets: z.array(mediaAssetSchema),
});

export const collectionSchema = z.object({
  id: z.uuid(),
  sourceUrl: z.url(),
  platform: platformSchema,
  status: collectionStatusSchema,
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaItem = z.infer<typeof mediaItemSchema>;
export const credentialInputSchema = z.object({
  cookies: z
    .string()
    .trim()
    .min(1, 'Cookie content is required')
    .max(MAX_CREDENTIAL_LENGTH, 'Cookie content is too large'),
});

export const credentialStatusSchema = z.object({
  configured: z.boolean(),
});

export type CredentialInput = z.infer<typeof credentialInputSchema>;
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export type Collection = z.infer<typeof collectionSchema>;

export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}
