import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const AUTH_COOKIE_NAME = 'media_scraper_session';
const PUBLIC_PATHS = new Set(['/auth/login', '/health']);
const loginSchema = z.object({ token: z.string().min(1) });

function tokensMatch(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function readCookie(request: FastifyRequest) {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0) continue;
    if (segment.slice(0, separator).trim() === AUTH_COOKIE_NAME) {
      try {
        return decodeURIComponent(segment.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function cookieValue(token: string, secure: boolean, maxAge: number) {
  return [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    `SameSite=${secure ? 'None' : 'Lax'}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : undefined,
  ]
    .filter(Boolean)
    .join('; ');
}

export async function registerAuthentication(
  app: FastifyInstance,
  { accessToken, secureCookie }: { accessToken: string; secureCookie: boolean },
) {
  app.post('/auth/login', async (request, reply) => {
    const { token } = loginSchema.parse(request.body);
    if (!tokensMatch(token, accessToken)) {
      return reply.code(401).send({ message: 'Invalid access token' });
    }
    reply.header('set-cookie', cookieValue(token, secureCookie, 2_592_000));
    return { authenticated: true };
  });

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (
      request.method === 'OPTIONS' ||
      PUBLIC_PATHS.has(path) ||
      path === '/docs' ||
      path.startsWith('/docs/')
    ) {
      return;
    }
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (
      !tokensMatch(bearer, accessToken) &&
      !tokensMatch(readCookie(request), accessToken)
    ) {
      return reply.code(401).send({ message: 'Authentication required' });
    }
  });

  app.get('/auth/session', async () => ({ authenticated: true }));
  app.delete('/auth/session', async (_request, reply) => {
    reply.header('set-cookie', cookieValue('', secureCookie, 0));
    return reply.code(204).send();
  });
}
