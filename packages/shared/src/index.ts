import { z } from 'zod';

export const SUPPORTED_PLATFORMS = ['instagram', 'facebook', 'tiktok'] as const;
export const COLLECTION_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
] as const;
export const COLLECTION_ORIGINS = ['manual', 'automatic'] as const;
export const PROFILE_BACKFILL_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
] as const;
export const MEDIA_TYPES = ['image', 'video'] as const;
export const MEDIA_GROUP_MODES = ['none', 'username', 'platform'] as const;
export const MEDIA_SORT_OPTIONS = ['collectedAt', 'publishedAt'] as const;
export const MEDIA_MAINTENANCE_TYPES = [
  'delete_local',
  'delete_object',
  'enforce_retention',
] as const;
export const COLLECTION_QUEUE_NAME = 'media-collections';
export const AUTOMATIC_PROFILE_QUEUE_NAME = 'automatic-profile-polls';
export const AUTOMATIC_PROFILE_JOB_NAME = 'check-profile';
export const AUTOMATIC_PROFILE_SCHEDULER_PREFIX = 'automatic-profile:';
export const PROFILE_BACKFILL_QUEUE_NAME = 'profile-backfills';
export const PROFILE_BACKFILL_JOB_NAME = 'backfill-profile';
export const MIN_AUTOMATIC_COLLECTION_INTERVAL_MINUTES = 15;
export const MAX_AUTOMATIC_COLLECTION_INTERVAL_MINUTES = 7 * 24 * 60;
export const AUTOMATIC_COLLECTION_INTERVAL_OPTIONS = [
  { label: '15 minutes', minutes: 15 },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 3 * 60 },
  { label: '6 hours', minutes: 6 * 60 },
  { label: '12 hours', minutes: 12 * 60 },
  { label: '1 day', minutes: 24 * 60 },
  { label: '7 days', minutes: 7 * 24 * 60 },
] as const;
export const MAX_CREDENTIAL_LENGTH = 1_000_000;
export const DEFAULT_PAGE_SIZE = 24;
export const MEDIA_LIBRARY_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_PROFILE_MEDIA = 24;
export const PROFILE_DISCOVERY_CACHE_ITEMS = MAX_PROFILE_MEDIA;
export const MAX_PROFILE_CURSOR_LENGTH = 8_192;
export const MAX_PROFILE_SOURCE_CURSOR_LENGTH = MAX_PROFILE_CURSOR_LENGTH * 4;
export const MAX_COLLECTION_BATCH_SIZE = 100;
export const COLLECTION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 1_000 },
};
export const AUTOMATIC_PROFILE_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 1_000 },
};
export const PROFILE_BACKFILL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 1_000 },
};

export function automaticProfileSchedulerId(profileId: string) {
  return `${AUTOMATIC_PROFILE_SCHEDULER_PREFIX}${profileId}`;
}

export const platformSchema = z.enum(SUPPORTED_PLATFORMS);
export const collectionStatusSchema = z.enum(COLLECTION_STATUSES);
export const collectionOriginSchema = z.enum(COLLECTION_ORIGINS);
export const profileBackfillStatusSchema = z.enum(PROFILE_BACKFILL_STATUSES);
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export const mediaGroupModeSchema = z.enum(MEDIA_GROUP_MODES);
export const mediaSortSchema = z.enum(MEDIA_SORT_OPTIONS);
export const mediaMaintenanceTypeSchema = z.enum(MEDIA_MAINTENANCE_TYPES);

export type Platform = z.infer<typeof platformSchema>;
export const STORY_SUPPORTED_PLATFORMS: readonly Platform[] = [
  'instagram',
  'tiktok',
];
export type CollectionStatus = z.infer<typeof collectionStatusSchema>;
export type CollectionOrigin = z.infer<typeof collectionOriginSchema>;
export type MediaType = z.infer<typeof mediaTypeSchema>;
export type MediaGroupMode = z.infer<typeof mediaGroupModeSchema>;
export type MediaSort = z.infer<typeof mediaSortSchema>;
export type MediaMaintenanceType = z.infer<typeof mediaMaintenanceTypeSchema>;

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

interface PlatformCredentialConfig {
  domain: string;
  fileName: string;
  loginUrl: string;
  requiredCookies: readonly string[];
}

export const PLATFORM_CREDENTIALS = {
  instagram: {
    domain: 'instagram.com',
    fileName: 'instagram.cookies.txt',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    requiredCookies: ['sessionid'],
  },
  facebook: {
    domain: 'facebook.com',
    fileName: 'facebook.cookies.txt',
    loginUrl: 'https://www.facebook.com/login',
    requiredCookies: ['c_user', 'xs'],
  },
  tiktok: {
    domain: 'tiktok.com',
    fileName: 'tiktok.cookies.txt',
    loginUrl: 'https://www.tiktok.com/login/',
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
  .transform((username) => username.replace(/^@/, '').toLowerCase());

const automaticCollectionIntervalSchema = z.coerce
  .number()
  .int()
  .min(MIN_AUTOMATIC_COLLECTION_INTERVAL_MINUTES)
  .max(MAX_AUTOMATIC_COLLECTION_INTERVAL_MINUTES);

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

export const createAutomaticProfileSchema = z
  .object({
    platform: platformSchema,
    username: profileUsernameSchema,
    intervalMinutes: automaticCollectionIntervalSchema,
    includeStories: z.boolean().default(false),
  })
  .refine(
    (input) =>
      !input.includeStories ||
      STORY_SUPPORTED_PLATFORMS.includes(input.platform),
    {
      message: 'Stories are only supported for Instagram and TikTok profiles',
      path: ['includeStories'],
    },
  );

export const createProfileArchiveSchema = createAutomaticProfileSchema;

export const updateAutomaticProfileSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: automaticCollectionIntervalSchema.optional(),
    includeStories: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.enabled !== undefined ||
      input.intervalMinutes !== undefined ||
      input.includeStories !== undefined,
    'At least one automatic profile setting is required',
  );

export const automaticProfileSchema = z.object({
  id: z.uuid(),
  platform: platformSchema,
  username: z.string(),
  intervalMinutes: automaticCollectionIntervalSchema,
  includeStories: z.boolean(),
  enabled: z.boolean(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type CreateAutomaticProfileInput = z.input<
  typeof createAutomaticProfileSchema
>;
export type CreateProfileArchiveInput = z.input<
  typeof createProfileArchiveSchema
>;
export type UpdateAutomaticProfileInput = z.input<
  typeof updateAutomaticProfileSchema
>;
export type AutomaticProfile = z.infer<typeof automaticProfileSchema>;
export interface AutomaticProfileJobPayload {
  profileId: string;
  force?: boolean;
}

export const profileBackfillSchema = z.object({
  id: z.uuid(),
  automaticProfileId: z.uuid(),
  status: profileBackfillStatusSchema,
  includeStories: z.boolean(),
  pageNumber: z.number().int().nonnegative(),
  itemsDiscovered: z.number().int().nonnegative(),
  collectionsQueued: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const profileArchiveSchema = z.object({
  profile: automaticProfileSchema,
  backfill: profileBackfillSchema,
});

export type ProfileBackfillStatus = z.infer<typeof profileBackfillStatusSchema>;
export type ProfileBackfill = z.infer<typeof profileBackfillSchema>;
export type ProfileArchive = z.infer<typeof profileArchiveSchema>;
export interface ProfileBackfillJobPayload {
  backfillId: string;
  pageNumber: number;
}

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
  origin: collectionOriginSchema,
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaItem = z.infer<typeof mediaItemSchema>;

export interface MediaItemGroup {
  key: string;
  label: string;
  items: MediaItem[];
  nextOffset: number | null;
}

export interface MediaItemGroups {
  groups: MediaItemGroup[];
  nextGroupOffset: number | null;
}

export const CREDENTIAL_SESSION_STATUSES = ['valid', 'expired'] as const;
export const credentialSessionStatusSchema = z.enum(
  CREDENTIAL_SESSION_STATUSES,
);

export const credentialSessionSchema = z.object({
  status: credentialSessionStatusSchema,
  message: z.string().nullable(),
  detectedAt: z.iso.datetime(),
});

export const credentialInputSchema = z.object({
  cookies: z
    .string()
    .trim()
    .min(1, 'Cookie content is required')
    .max(MAX_CREDENTIAL_LENGTH, 'Cookie content is too large'),
});

export const credentialStatusSchema = z.object({
  configured: z.boolean(),
  interactiveLogin: z.boolean(),
  session: credentialSessionSchema.nullable(),
});

export const CREDENTIAL_LOGIN_SESSION_STATUSES = [
  'pending',
  'completed',
  'expired',
] as const;

export const credentialLoginSessionSchema = z.object({
  id: z.uuid(),
  platform: platformSchema,
  liveUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const credentialLoginSessionStateSchema = z.object({
  status: z.enum(CREDENTIAL_LOGIN_SESSION_STATUSES),
});

export function credentialSessionExpiredMessage(platform: Platform) {
  return `The ${PLATFORM_LABELS[platform]} session has expired or been revoked. Replace the stored cookies to continue collecting media.`;
}

export type CredentialSessionStatus = z.infer<
  typeof credentialSessionStatusSchema
>;
export type CredentialSession = z.infer<typeof credentialSessionSchema>;
export type CredentialInput = z.infer<typeof credentialInputSchema>;
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export type CredentialLoginSession = z.infer<
  typeof credentialLoginSessionSchema
>;
export type CredentialLoginSessionState = z.infer<
  typeof credentialLoginSessionStateSchema
>;
export type Collection = z.infer<typeof collectionSchema>;

export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}
