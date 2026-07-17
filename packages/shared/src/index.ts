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

export type CreateCollectionInput = z.input<typeof createCollectionSchema>;
export type CollectionJobPayload = z.output<typeof createCollectionSchema> & {
  collectionId: string;
};

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
