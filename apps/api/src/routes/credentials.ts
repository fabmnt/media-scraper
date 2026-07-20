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
import {
  cancelLoginSession,
  pollLoginSession,
  startLoginSession,
  type BrowserLoginConfig,
} from '../platform-login-sessions.js';

interface CredentialRouteParams {
  platform: string;
}

interface LoginSessionRouteParams {
  platform: string;
  sessionId: string;
}

interface CredentialRoutesOptions {
  browserLogin?: BrowserLoginConfig | undefined;
  credentialsRoot: string;
  db: Database;
}

class InteractiveLoginUnavailableError extends Error {
  readonly statusCode = 501;
  constructor() {
    super('Interactive sign-in is not configured on this server');
  }
}

export async function credentialRoutes(
  app: FastifyInstance,
  { browserLogin, credentialsRoot, db }: CredentialRoutesOptions,
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
      interactiveLogin: Boolean(browserLogin),
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
      return reply.send({
        configured: true,
        interactiveLogin: Boolean(browserLogin),
        session: null,
      });
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

  app.post<{ Params: CredentialRouteParams }>(
    '/:platform/login-sessions',
    async (request) => {
      const platform = platformSchema.parse(request.params.platform);
      if (!browserLogin) throw new InteractiveLoginUnavailableError();
      const session = await startLoginSession(browserLogin, platform);
      return {
        id: session.id,
        platform: session.platform,
        liveUrl: session.liveUrl,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  app.get<{ Params: LoginSessionRouteParams }>(
    '/:platform/login-sessions/:sessionId',
    async (request) => {
      platformSchema.parse(request.params.platform);
      if (!browserLogin) throw new InteractiveLoginUnavailableError();
      const result = await pollLoginSession(
        browserLogin,
        credentialsRoot,
        request.params.sessionId,
      );
      if (result.status === 'completed' && result.platform) {
        await resetCredentialSession(db, result.platform);
      }
      return { status: result.status };
    },
  );

  app.delete<{ Params: LoginSessionRouteParams }>(
    '/:platform/login-sessions/:sessionId',
    async (request, reply) => {
      platformSchema.parse(request.params.platform);
      if (!browserLogin) throw new InteractiveLoginUnavailableError();
      await cancelLoginSession(browserLogin, request.params.sessionId);
      return reply.code(204).send();
    },
  );
}
