import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  enqueueAssetCleanup,
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import type { MediaStorage } from '@media-scraper/storage';
import { listMediaGroups } from '../media-library.js';

const idParamsSchema = z.object({ id: z.uuid() });
const assetParamsSchema = idParamsSchema.extend({
  action: z.enum(['content', 'download']),
});

export async function mediaRoutes(
  app: FastifyInstance,
  { db, storage }: { db: Database; storage: MediaStorage },
) {
  const root = storage.mediaRoot;

  app.get('/', async (request) => listMediaGroups(db, request.query));

  app.get('/:id/:action', async (request, reply) => {
    const { action, id } = assetParamsSchema.parse(request.params);
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id));
    if (!asset) return reply.code(404).send({ message: 'Asset not found' });
    if (asset.storageKey) {
      const url = await storage.createReadUrl(
        asset.storageKey,
        action === 'download' ? asset.fileName : undefined,
      );
      return reply.redirect(url);
    }
    if (!asset.relativePath || !storage.localPath(asset.relativePath)) {
      return reply.code(400).send({ message: 'Invalid asset path' });
    }
    if (action === 'download') {
      const safeFileName = basename(asset.fileName).replace(/["\r\n]/g, '_');
      reply.header(
        'content-disposition',
        `attachment; filename="${safeFileName}"`,
      );
    }
    reply.type(asset.mimeType);
    return reply.sendFile(asset.relativePath, root);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const deleted = await db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(eq(mediaItems.id, id))
        .for('update');
      if (!existing) return false;

      const assets = await transaction
        .select({
          relativePath: mediaAssets.relativePath,
          storageKey: mediaAssets.storageKey,
        })
        .from(mediaAssets)
        .where(eq(mediaAssets.mediaItemId, id));
      await enqueueAssetCleanup(transaction, assets);
      await transaction.delete(mediaItems).where(eq(mediaItems.id, id));
      return true;
    });
    return deleted
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Media item not found' });
  });
}
