import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  discoverProfileMedia,
  InvalidProfileCursorError,
} from '@media-scraper/extractors';
import { MAX_PROFILE_MEDIA, profileLookupSchema } from '@media-scraper/shared';
import { platformCredentialFile } from '../platform-cookies.js';
import { ProfileDiscoveryCache } from '../profile-discovery-cache.js';
import {
  ProfileDiscoveryBusyError,
  ProfileDiscoveryLimiter,
} from '../profile-discovery-limiter.js';

const MAX_ACTIVE_PROFILE_DISCOVERIES = 1;
const MAX_QUEUED_PROFILE_DISCOVERIES = 1;
const PROFILE_DISCOVERY_RETRY_AFTER_SECONDS = 5;

class ProfileDiscoveryTimeoutError extends Error {
  override readonly name = 'ProfileDiscoveryTimeoutError';
}

interface ProfileRoutesOptions {
  cacheTtlSeconds: number;
  credentialsRoot: string;
  redis: Redis;
  timeoutMs: number;
}

export async function profileRoutes(
  app: FastifyInstance,
  { cacheTtlSeconds, credentialsRoot, redis, timeoutMs }: ProfileRoutesOptions,
) {
  const cache = new ProfileDiscoveryCache(redis, cacheTtlSeconds);
  const limiter = new ProfileDiscoveryLimiter(
    MAX_ACTIVE_PROFILE_DISCOVERIES,
    MAX_QUEUED_PROFILE_DISCOVERIES,
  );
  app.addHook('onClose', () => cache.close());

  app.post(
    '/lookup',
    { schema: { tags: ['profiles'] } },
    async (request, reply) => {
      const input = profileLookupSchema.parse(request.body);
      const startedAt = performance.now();
      const requestController = new AbortController();
      const deadlineController = new AbortController();
      let deadline: NodeJS.Timeout | undefined;
      const deadlinePromise = new Promise<never>((_resolve, reject) => {
        const timeoutError = new ProfileDiscoveryTimeoutError();
        deadline = setTimeout(() => {
          deadlineController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
        deadline.unref();
      });
      const signal = AbortSignal.any([
        requestController.signal,
        deadlineController.signal,
      ]);
      const abortDiscovery = () => {
        if (!reply.raw.writableFinished) requestController.abort();
      };
      reply.raw.once('close', abortDiscovery);

      let loadedSnapshot = false;
      try {
        const credential = await platformCredentialFile(
          credentialsRoot,
          input.platform,
        );
        const lookup = cache.page(
          input,
          credential?.version ?? 'public',
          signal,
          (cursor, loadSignal) => {
            const queuedAt = performance.now();
            return limiter.run(loadSignal, async () => {
              loadedSnapshot = true;
              const discoveryStartedAt = performance.now();
              request.log.info(
                {
                  platform: input.platform,
                  queueWaitMs: Math.round(discoveryStartedAt - queuedAt),
                },
                'Profile discovery extraction started',
              );
              try {
                return await discoverProfileMedia(
                  { ...input, cursor },
                  credential?.path,
                  loadSignal,
                  MAX_PROFILE_MEDIA,
                );
              } finally {
                request.log.info(
                  {
                    durationMs: Math.round(
                      performance.now() - discoveryStartedAt,
                    ),
                    platform: input.platform,
                  },
                  'Profile discovery extraction finished',
                );
              }
            });
          },
        );
        const result = await Promise.race([lookup, deadlinePromise]);
        request.log.info(
          {
            durationMs: Math.round(performance.now() - startedAt),
            items: result.items.length,
            loadedSnapshot,
            platform: input.platform,
          },
          'Profile discovery completed',
        );
        return result;
      } catch (error) {
        if (error instanceof InvalidProfileCursorError) {
          return reply.code(400).send({ message: error.message });
        }
        if (deadlineController.signal.aborted) {
          request.log.warn(
            { durationMs: Math.round(performance.now() - startedAt) },
            'Profile discovery timed out',
          );
          return reply.code(504).send({
            message: 'Profile discovery timed out. Try again shortly.',
          });
        }
        if (error instanceof ProfileDiscoveryBusyError) {
          return reply
            .header(
              'retry-after',
              String(PROFILE_DISCOVERY_RETRY_AFTER_SECONDS),
            )
            .code(429)
            .send({ message: error.message });
        }
        request.log.warn(error, 'Profile discovery failed');
        return reply.code(502).send({
          message:
            error instanceof Error
              ? error.message
              : 'Could not read this profile',
        });
      } finally {
        if (deadline) clearTimeout(deadline);
        reply.raw.off('close', abortDiscovery);
      }
    },
  );
}
