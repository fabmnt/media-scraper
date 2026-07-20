import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { MediaStorageOptions } from '@media-scraper/storage';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';
const DEFAULT_MAX_ASSET_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_COLLECTION_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_MEDIA_STORAGE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_COLLECTION_CONCURRENCY = 8;
const DEFAULT_OPTIMIZATION_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_PROFILE_DISCOVERY_CACHE_TTL_SECONDS = 10 * 60;
const DEFAULT_PROFILE_DISCOVERY_TIMEOUT_MS = 45_000;
const MAX_PRESIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_PROFILE_DISCOVERY_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_PROFILE_DISCOVERY_TIMEOUT_MS = 90_000;
const DEFAULT_RETENTION_TARGET_PERCENT = 70;
const DEFAULT_RETENTION_TRIGGER_PERCENT = 80;
const DEFAULT_VIDEO_MAX_DIMENSION = 1_280;

function findWorkspaceRoot(startDirectory: string) {
  let directory = resolve(startDirectory);
  while (true) {
    if (existsSync(join(directory, WORKSPACE_MARKER))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(startDirectory);
    directory = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());
const environmentPath = join(workspaceRoot, '.env');
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

const positiveInteger = z.coerce.number().int().positive();
const percentage = z.coerce.number().int().min(1).max(100);
const optionalPositiveInteger = z.preprocess(
  (value) => (value === '' ? undefined : value),
  positiveInteger.optional(),
);
const optionalEnvironmentString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);
const optionalEnvironmentUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().optional(),
);
const storageEnvironmentFields = {
  MEDIA_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_ACCESS_KEY_ID: optionalEnvironmentString,
  S3_BUCKET: optionalEnvironmentString,
  S3_ENDPOINT: optionalEnvironmentUrl,
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  S3_PRESIGNED_URL_TTL_SECONDS: positiveInteger
    .max(MAX_PRESIGNED_URL_TTL_SECONDS)
    .default(DEFAULT_PRESIGNED_URL_TTL_SECONDS),
  S3_REGION: z.string().min(1).default('auto'),
  S3_SECRET_ACCESS_KEY: optionalEnvironmentString,
};
const commonEnvironmentSchema = z.object({
  DATABASE_URL: z
    .url()
    .default(
      'postgresql://media_scraper:media_scraper@localhost:5432/media_scraper',
    ),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  MEDIA_ROOT: z.string().min(1).default('./data/media'),
  CREDENTIALS_ROOT: z.string().min(1).default('./data/credentials'),
  ...storageEnvironmentFields,
});

function validateStorageEnvironment(
  config: z.infer<typeof commonEnvironmentSchema>,
  context: z.core.$RefinementCtx,
) {
  if (config.MEDIA_STORAGE_DRIVER !== 's3') return;
  for (const field of [
    'S3_ACCESS_KEY_ID',
    'S3_BUCKET',
    'S3_ENDPOINT',
    'S3_SECRET_ACCESS_KEY',
  ] as const) {
    if (!config[field]) {
      context.addIssue({
        code: 'custom',
        message: `${field} is required when MEDIA_STORAGE_DRIVER is s3`,
        path: [field],
      });
    }
  }
}

const apiEnvironmentSchema = commonEnvironmentSchema
  .extend({
    API_ACCESS_TOKEN: z.string().min(1),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    // Railway injects PORT at runtime. Keep API_PORT available for local Docker
    // development, but prefer PORT when API_PORT is not explicitly configured.
    API_PORT: positiveInteger.optional(),
    BROWSERLESS_PUBLIC_URL: optionalEnvironmentUrl,
    BROWSERLESS_TOKEN: optionalEnvironmentString,
    BROWSERLESS_URL: optionalEnvironmentUrl,
    COOKIE_SECURE: z.stringbool().default(false),
    PROFILE_DISCOVERY_CACHE_TTL_SECONDS: positiveInteger
      .max(MAX_PROFILE_DISCOVERY_CACHE_TTL_SECONDS)
      .default(DEFAULT_PROFILE_DISCOVERY_CACHE_TTL_SECONDS),
    PROFILE_DISCOVERY_TIMEOUT_MS: positiveInteger
      .max(MAX_PROFILE_DISCOVERY_TIMEOUT_MS)
      .default(DEFAULT_PROFILE_DISCOVERY_TIMEOUT_MS),
    WEB_ORIGIN: z.url().default('http://localhost:5173'),
  })
  .superRefine((config, context) => {
    validateStorageEnvironment(config, context);
    if (config.BROWSERLESS_PUBLIC_URL && !config.BROWSERLESS_URL) {
      context.addIssue({
        code: 'custom',
        message:
          'BROWSERLESS_URL is required when BROWSERLESS_PUBLIC_URL is set',
        path: ['BROWSERLESS_URL'],
      });
    }
  });

const workerEnvironmentSchema = commonEnvironmentSchema
  .extend({
    COLLECTION_CONCURRENCY: optionalPositiveInteger.refine(
      (value) => value === undefined || value <= MAX_COLLECTION_CONCURRENCY,
      `Collection concurrency cannot exceed ${String(MAX_COLLECTION_CONCURRENCY)}`,
    ),
    EXTRACTION_TIMEOUT_MS: positiveInteger.default(1_800_000),
    MAX_ASSET_BYTES: positiveInteger.default(DEFAULT_MAX_ASSET_BYTES),
    MAX_COLLECTION_BYTES: positiveInteger.default(DEFAULT_MAX_COLLECTION_BYTES),
    MAX_MEDIA_STORAGE_BYTES: positiveInteger.default(
      DEFAULT_MAX_MEDIA_STORAGE_BYTES,
    ),
    MEDIA_RETENTION_TARGET_PERCENT: percentage.default(
      DEFAULT_RETENTION_TARGET_PERCENT,
    ),
    MEDIA_RETENTION_TRIGGER_PERCENT: percentage.default(
      DEFAULT_RETENTION_TRIGGER_PERCENT,
    ),
    METADATA_CONCURRENCY: positiveInteger.default(4),
    OPTIMIZATION_TIMEOUT_MS: positiveInteger.default(
      DEFAULT_OPTIMIZATION_TIMEOUT_MS,
    ),
    VIDEO_MAX_DIMENSION: positiveInteger.default(DEFAULT_VIDEO_MAX_DIMENSION),
  })
  .superRefine((config, context) => {
    validateStorageEnvironment(config, context);
    if (
      config.MEDIA_RETENTION_TARGET_PERCENT >=
      config.MEDIA_RETENTION_TRIGGER_PERCENT
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Retention target must be lower than its trigger',
        path: ['MEDIA_RETENTION_TARGET_PERCENT'],
      });
    }
    if (config.MAX_COLLECTION_BYTES >= config.MAX_MEDIA_STORAGE_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'Collection limit must be lower than the media storage limit',
        path: ['MAX_COLLECTION_BYTES'],
      });
    }
  });

function resolveCommonPaths<
  T extends { CREDENTIALS_ROOT: string; MEDIA_ROOT: string },
>(config: T): T {
  return {
    ...config,
    CREDENTIALS_ROOT: isAbsolute(config.CREDENTIALS_ROOT)
      ? config.CREDENTIALS_ROOT
      : resolve(workspaceRoot, config.CREDENTIALS_ROOT),
    MEDIA_ROOT: isAbsolute(config.MEDIA_ROOT)
      ? config.MEDIA_ROOT
      : resolve(workspaceRoot, config.MEDIA_ROOT),
  };
}

export function mediaStorageOptions(
  config: z.infer<typeof commonEnvironmentSchema>,
): MediaStorageOptions {
  if (config.MEDIA_STORAGE_DRIVER === 'local') {
    return { driver: 'local', mediaRoot: config.MEDIA_ROOT };
  }
  if (
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_BUCKET ||
    !config.S3_ENDPOINT ||
    !config.S3_SECRET_ACCESS_KEY
  ) {
    throw new Error('S3 storage configuration is incomplete');
  }
  return {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    bucket: config.S3_BUCKET,
    driver: 's3',
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    mediaRoot: config.MEDIA_ROOT,
    presignedUrlTtlSeconds: config.S3_PRESIGNED_URL_TTL_SECONDS,
    region: config.S3_REGION,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  };
}

export const loadApiConfig = () => {
  const config = apiEnvironmentSchema.parse(process.env);
  return resolveCommonPaths({
    ...config,
    API_PORT: config.API_PORT ?? Number(process.env.PORT ?? 3000),
  });
};
export const loadWorkerConfig = () =>
  resolveCommonPaths(workerEnvironmentSchema.parse(process.env));
