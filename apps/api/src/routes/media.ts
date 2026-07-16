import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import { platformSchema } from '@media-scraper/shared';
import { serializeMediaItem } from '../serialization.js';

const mediaQuerySchema = z.object({
  platform: platformSchema.optional(),
  search: z.string().trim().min(1).optional(),
});

export async function mediaRoutes(
  app: FastifyInstance,
  { db, mediaRoot }: { db: Database; mediaRoot: string },
) {
  app.get('/', async (request) => {
    const query = mediaQuerySchema.parse(request.query);
    const filters: SQL[] = [];
    if (query.platform) filters.push(eq(mediaItems.platform, query.platform));
    if (query.search) {
      const searchFilter = or(
        ilike(mediaItems.caption, `%${query.search}%`),
        ilike(mediaItems.authorName, `%${query.search}%`),
      );
      if (searchFilter) filters.push(searchFilter);
    }

    const items = await db
      .select()
      .from(mediaItems)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(mediaItems.collectedAt));
    const assets =
      items.length === 0
        ? []
        : await db
            .select()
            .from(mediaAssets)
            .where(
              inArray(
                mediaAssets.mediaItemId,
                items.map((item) => item.id),
              ),
            );

    return items.map((item) =>
      serializeMediaItem(
        item,
        assets.filter((asset) => asset.mediaItemId === item.id),
      ),
    );
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const assets = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.mediaItemId, id));
    const [deleted] = await db
      .delete(mediaItems)
      .where(eq(mediaItems.id, id))
      .returning({ id: mediaItems.id });
    if (!deleted)
      return reply.code(404).send({ message: 'Media item not found' });

    const root = resolve(mediaRoot);
    await Promise.all(
      assets.map(async (asset) => {
        const assetPath = resolve(root, asset.relativePath);
        if (assetPath.startsWith(`${root}${sep}`)) {
          await rm(assetPath, { force: true });
        }
      }),
    );
    return reply.code(204).send();
  });
}
