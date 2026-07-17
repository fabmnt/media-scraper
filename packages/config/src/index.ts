import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

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
const commonEnvironmentSchema = z.object({
  DATABASE_URL: z
    .url()
    .default(
      'postgresql://media_scraper:media_scraper@localhost:5432/media_scraper',
    ),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  MEDIA_ROOT: z.string().min(1).default('./data/media'),
  CREDENTIALS_ROOT: z.string().min(1).default('./data/credentials'),
});

const apiEnvironmentSchema = commonEnvironmentSchema.extend({
  API_ACCESS_TOKEN: z.string().min(32),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  // Railway injects PORT at runtime. Keep API_PORT available for local Docker
  // development, but prefer PORT when API_PORT is not explicitly configured.
  API_PORT: positiveInteger.optional(),
  COOKIE_SECURE: z.stringbool().default(false),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
});

const workerEnvironmentSchema = commonEnvironmentSchema.extend({
  EXTRACTION_TIMEOUT_MS: positiveInteger.default(1_800_000),
  MAX_ASSET_BYTES: positiveInteger.default(2_147_483_648),
  MAX_COLLECTION_BYTES: positiveInteger.default(10_737_418_240),
  METADATA_CONCURRENCY: positiveInteger.default(4),
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

export const loadApiConfig = () => {
  const config = apiEnvironmentSchema.parse(process.env);
  return resolveCommonPaths({
    ...config,
    API_PORT: config.API_PORT ?? Number(process.env.PORT ?? 3000),
  });
};
export const loadWorkerConfig = () =>
  resolveCommonPaths(workerEnvironmentSchema.parse(process.env));
