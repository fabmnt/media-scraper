import type { FastifyInstance } from 'fastify';
import { discoverProfileMedia } from '@media-scraper/extractors';
import { profileLookupSchema } from '@media-scraper/shared';
import {
  hasPlatformCredential,
  platformCredentialPath,
} from '../platform-cookies.js';

interface ProfileRoutesOptions {
  credentialsRoot: string;
}

export async function profileRoutes(
  app: FastifyInstance,
  { credentialsRoot }: ProfileRoutesOptions,
) {
  app.post(
    '/lookup',
    { schema: { tags: ['profiles'] } },
    async (request, reply) => {
      const input = profileLookupSchema.parse(request.body);
      const hasCredential = await hasPlatformCredential(
        credentialsRoot,
        input.platform,
      );
      const abortController = new AbortController();
      const abortDiscovery = () => {
        if (!reply.raw.writableFinished) abortController.abort();
      };
      reply.raw.once('close', abortDiscovery);

      try {
        return await discoverProfileMedia(
          input,
          hasCredential
            ? platformCredentialPath(credentialsRoot, input.platform)
            : undefined,
          abortController.signal,
        );
      } catch (error) {
        request.log.warn(error, 'Profile discovery failed');
        return reply.code(502).send({
          message:
            error instanceof Error
              ? error.message
              : 'Could not read this profile',
        });
      } finally {
        reply.raw.off('close', abortDiscovery);
      }
    },
  );
}
