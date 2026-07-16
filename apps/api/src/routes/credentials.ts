import type { FastifyInstance } from 'fastify';
import { instagramCredentialInputSchema } from '@media-scraper/shared';
import {
  deleteInstagramCredential,
  hasInstagramCredential,
  saveInstagramCredential,
} from '../instagram-cookies.js';

export async function credentialRoutes(
  app: FastifyInstance,
  { credentialsRoot }: { credentialsRoot: string },
) {
  app.get('/instagram', async () => ({
    configured: await hasInstagramCredential(credentialsRoot),
  }));

  app.put('/instagram', async (request, reply) => {
    const { cookies } = instagramCredentialInputSchema.parse(request.body);
    await saveInstagramCredential(credentialsRoot, cookies);
    return reply.send({ configured: true });
  });

  app.delete('/instagram', async (_request, reply) => {
    await deleteInstagramCredential(credentialsRoot);
    return reply.code(204).send();
  });
}
