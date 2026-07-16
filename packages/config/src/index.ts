import { existsSync } from 'node:fs';
import { z } from 'zod';

const ENV_FILE_PATH = '.env';
if (existsSync(ENV_FILE_PATH)) process.loadEnvFile(ENV_FILE_PATH);

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
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
});

const workerEnvironmentSchema = commonEnvironmentSchema.extend({
  MAX_ASSET_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
});

export const loadApiConfig = () => apiEnvironmentSchema.parse(process.env);
export const loadWorkerConfig = () =>
  workerEnvironmentSchema.parse(process.env);
