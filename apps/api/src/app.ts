import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@media-scraper/database';
import {
  COLLECTION_QUEUE_NAME,
  type CollectionJobPayload,
} from '@media-scraper/shared';
import { MediaStorage, type MediaStorageOptions } from '@media-scraper/storage';
import { collectionRoutes } from './routes/collections.js';
import { credentialRoutes } from './routes/credentials.js';
import { mediaRoutes } from './routes/media.js';
import { profileRoutes } from './routes/profiles.js';
import { registerAuthentication } from './auth.js';

type ApiError = Error & { statusCode?: number };

const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Health check timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface ApiConfig {
  accessToken: string;
  credentialsRoot: string;
  databaseUrl: string;
  mediaRoot: string;
  mediaStorage: MediaStorageOptions;
  redisUrl: string;
  secureCookie: boolean;
  webOrigin: string;
}

export async function buildApp(config: ApiConfig) {
  const app = Fastify({ logger: true });
  const database = createDatabase(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const storage = new MediaStorage(config.mediaStorage);
  const queue = new Queue<CollectionJobPayload>(COLLECTION_QUEUE_NAME, {
    connection: redis,
  });
  queue.on('error', (error) => app.log.error(error, 'Collection queue error'));

  app.setErrorHandler<ApiError>((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        message: 'Invalid request',
        issues: error.issues,
      });
    }
    request.log.error(error);
    return reply.code(error.statusCode ?? 500).send({
      message: error.statusCode ? error.message : 'Internal server error',
    });
  });

  await app.register(cors, {
    credentials: true,
    origin: config.webOrigin,
    methods: ALLOWED_HTTP_METHODS,
  });
  await registerAuthentication(app, {
    accessToken: config.accessToken,
    secureCookie: config.secureCookie,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Media Scraper API', version: '0.1.0' },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.register(fastifyStatic, {
    root: resolve(config.mediaRoot),
    prefix: '/media/',
    decorateReply: true,
  });
  await app.register(credentialRoutes, {
    prefix: '/credentials',
    credentialsRoot: config.credentialsRoot,
  });
  await app.register(collectionRoutes, {
    prefix: '/collections',
    db: database.db,
    queue,
  });
  await app.register(profileRoutes, {
    prefix: '/profiles',
    credentialsRoot: config.credentialsRoot,
  });
  await app.register(mediaRoutes, {
    prefix: '/media-items',
    db: database.db,
    storage,
  });

  app.get('/health', async (_request, reply) => {
    try {
      await withTimeout(
        Promise.all([database.db.execute(sql`select 1`), redis.ping()]),
        HEALTH_CHECK_TIMEOUT_MS,
      );
      return { status: 'ok' };
    } catch (error) {
      app.log.error(error, 'Health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.addHook('onClose', async () => {
    await queue.close();
    await redis.quit();
    await database.close();
    storage.close();
  });

  return app;
}
