import { loadApiConfig } from '@media-scraper/config';
import { buildApp } from './app.js';

const config = loadApiConfig();
const app = await buildApp({
  credentialsRoot: config.CREDENTIALS_ROOT,
  databaseUrl: config.DATABASE_URL,
  mediaRoot: config.MEDIA_ROOT,
  redisUrl: config.REDIS_URL,
  webOrigin: config.WEB_ORIGIN,
});

await app.listen({ host: config.API_HOST, port: config.API_PORT });
