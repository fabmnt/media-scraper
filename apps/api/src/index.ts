import { loadApiConfig, mediaStorageOptions } from '@media-scraper/config';
import { buildApp } from './app.js';

const config = loadApiConfig();
const app = await buildApp({
  accessToken: config.API_ACCESS_TOKEN,
  credentialsRoot: config.CREDENTIALS_ROOT,
  databaseUrl: config.DATABASE_URL,
  mediaRoot: config.MEDIA_ROOT,
  mediaStorage: mediaStorageOptions(config),
  redisUrl: config.REDIS_URL,
  secureCookie: config.COOKIE_SECURE,
  webOrigin: config.WEB_ORIGIN,
});

await app.listen({ host: config.API_HOST, port: config.API_PORT });
