import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  platformCredentialStates,
  resetCredentialSession,
  type Database,
} from '@media-scraper/database';
import { credentialInputSchema, platformSchema } from '@media-scraper/shared';
import {
  deletePlatformCredential,
  platformCredentialFile,
  savePlatformCredential,
} from '../platform-cookies.js';

interface CredentialRouteParams {
  platform: string;
}

interface CredentialRoutesOptions {
  credentialsRoot: string;
  db: Database;
}

export async function credentialRoutes(
  app: FastifyInstance,
  { credentialsRoot, db }: CredentialRoutesOptions,
) {
  app.get<{ Params: CredentialRouteParams }>('/:platform', async (request) => {
    const platform = platformSchema.parse(request.params.platform);
    const [credential, [sessionState]] = await Promise.all([
      platformCredentialFile(credentialsRoot, platform),
      db
        .select()
        .from(platformCredentialStates)
        .where(eq(platformCredentialStates.platform, platform)),
    ]);
    return {
      configured: Boolean(credential),
      session: sessionState
        ? {
            status: sessionState.status,
            message: sessionState.message,
            detectedAt: sessionState.detectedAt.toISOString(),
          }
        : null,
    };
  });

  app.put<{ Params: CredentialRouteParams }>(
    '/:platform',
    async (request, reply) => {
      const platform = platformSchema.parse(request.params.platform);
      const { cookies } = credentialInputSchema.parse(request.body);
      await savePlatformCredential(credentialsRoot, platform, cookies);
      await resetCredentialSession(db, platform);
      return reply.send({ configured: true, session: null });
    },
  );

  app.delete<{ Params: CredentialRouteParams }>(
    '/:platform',
    async (request, reply) => {
      const platform = platformSchema.parse(request.params.platform);
      await deletePlatformCredential(credentialsRoot, platform);
      await resetCredentialSession(db, platform);
      return reply.code(204).send();
    },
  );
}
