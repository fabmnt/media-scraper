import { loadApiConfig, mediaStorageOptions } from '@media-scraper/config';
import { buildApp } from './app.js';

const config = loadApiConfig();
const app = await buildApp({
  accessToken: config.API_ACCESS_TOKEN,
  browserLogin:
    config.BROWSERLESS_URL && config.BROWSERLESS_PUBLIC_URL
      ? {
          publicUrl: config.BROWSERLESS_PUBLIC_URL,
          token: config.BROWSERLESS_TOKEN,
          url: config.BROWSERLESS_URL,
        }
      : undefined,
  credentialsRoot: config.CREDENTIALS_ROOT,
  databaseUrl: config.DATABASE_URL,
  mediaRoot: config.MEDIA_ROOT,
  mediaStorage: mediaStorageOptions(config),
  profileDiscoveryCacheTtlSeconds: config.PROFILE_DISCOVERY_CACHE_TTL_SECONDS,
  profileDiscoveryTimeoutMs: config.PROFILE_DISCOVERY_TIMEOUT_MS,
  redisUrl: config.REDIS_URL,
  secureCookie: config.COOKIE_SECURE,
  webOrigin: config.WEB_ORIGIN,
});

await app.listen({ host: config.API_HOST, port: config.API_PORT });
