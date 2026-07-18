import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  discoverProfileMedia,
  InvalidProfileCursorError,
} from '@media-scraper/extractors';
import {
  PROFILE_DISCOVERY_CACHE_ITEMS,
  profileLookupSchema,
} from '@media-scraper/shared';
import {
  hasPlatformCredential,
  platformCredentialPath,
} from '../platform-cookies.js';
import { ProfileDiscoveryCache } from '../profile-discovery-cache.js';

interface ProfileRoutesOptions {
  cacheTtlSeconds: number;
  credentialsRoot: string;
  redis: Redis;
}

export async function profileRoutes(
  app: FastifyInstance,
  { cacheTtlSeconds, credentialsRoot, redis }: ProfileRoutesOptions,
) {
  const cache = new ProfileDiscoveryCache(redis, cacheTtlSeconds);
  app.addHook('onClose', () => cache.close());

  app.post(
    '/lookup',
    { schema: { tags: ['profiles'] } },
    async (request, reply) => {
      const input = profileLookupSchema.parse(request.body);

      try {
        const hasCredential = await hasPlatformCredential(
          credentialsRoot,
          input.platform,
        );
        const credentialPath = hasCredential
          ? platformCredentialPath(credentialsRoot, input.platform)
          : undefined;
        const credentialVersion = credentialPath
          ? await stat(credentialPath).then(
              ({ mtimeMs, size }) => `${String(mtimeMs)}:${String(size)}`,
            )
          : 'public';

        return await cache.page(input, credentialVersion, (cursor, signal) =>
          discoverProfileMedia(
            { ...input, cursor },
            credentialPath,
            signal,
            PROFILE_DISCOVERY_CACHE_ITEMS,
          ),
        );
      } catch (error) {
        if (error instanceof InvalidProfileCursorError) {
          return reply.code(400).send({ message: error.message });
        }
        request.log.warn(error, 'Profile discovery failed');
        return reply.code(502).send({
          message:
            error instanceof Error
              ? error.message
              : 'Could not read this profile',
        });
      }
    },
  );
}
