import type { FastifyInstance } from 'fastify';
import { credentialInputSchema, platformSchema } from '@media-scraper/shared';
import {
  deletePlatformCredential,
  platformCredentialFile,
  savePlatformCredential,
} from '../platform-cookies.js';

interface CredentialRouteParams {
  platform: string;
}

export async function credentialRoutes(
  app: FastifyInstance,
  { credentialsRoot }: { credentialsRoot: string },
) {
  app.get<{ Params: CredentialRouteParams }>('/:platform', async (request) => {
    const platform = platformSchema.parse(request.params.platform);
    return {
      configured: Boolean(
        await platformCredentialFile(credentialsRoot, platform),
      ),
    };
  });

  app.put<{ Params: CredentialRouteParams }>(
    '/:platform',
    async (request, reply) => {
      const platform = platformSchema.parse(request.params.platform);
      const { cookies } = credentialInputSchema.parse(request.body);
      await savePlatformCredential(credentialsRoot, platform, cookies);
      return reply.send({ configured: true });
    },
  );

  app.delete<{ Params: CredentialRouteParams }>(
    '/:platform',
    async (request, reply) => {
      const platform = platformSchema.parse(request.params.platform);
      await deletePlatformCredential(credentialsRoot, platform);
      return reply.code(204).send();
    },
  );
}
