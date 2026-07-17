import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  enqueueAssetCleanup,
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import type { MediaStorage } from '@media-scraper/storage';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  platformSchema,
  type MediaItem,
  type Page,
} from '@media-scraper/shared';
import { serializeMediaItem } from '../serialization.js';

const mediaQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().nonnegative().default(0),
  platform: platformSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
const idParamsSchema = z.object({ id: z.uuid() });
const assetParamsSchema = idParamsSchema.extend({
  action: z.enum(['content', 'download']),
});

export async function mediaRoutes(
  app: FastifyInstance,
  { db, storage }: { db: Database; storage: MediaStorage },
) {
  const root = storage.mediaRoot;

  app.get('/', async (request): Promise<Page<MediaItem>> => {
    const query = mediaQuerySchema.parse(request.query);
    const filters: SQL[] = [];
    if (query.platform) filters.push(eq(mediaItems.platform, query.platform));
    if (query.search) {
      const escapedSearch = query.search.replace(/[\\%_]/g, '\\$&');
      const searchFilter = or(
        ilike(mediaItems.caption, `%${escapedSearch}%`),
        ilike(mediaItems.authorName, `%${escapedSearch}%`),
      );
      if (searchFilter) filters.push(searchFilter);
    }

    const rows = await db
      .select()
      .from(mediaItems)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(mediaItems.collectedAt), asc(mediaItems.id))
      .limit(query.limit + 1)
      .offset(query.offset);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
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
            )
            .orderBy(asc(mediaAssets.position));
    const assetsByItem = new Map<string, typeof assets>();
    for (const asset of assets) {
      const itemAssets = assetsByItem.get(asset.mediaItemId) ?? [];
      itemAssets.push(asset);
      assetsByItem.set(asset.mediaItemId, itemAssets);
    }

    return {
      items: items.map((item) =>
        serializeMediaItem(item, assetsByItem.get(item.id) ?? []),
      ),
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  });

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
        .where(eq(mediaItems.id, id));
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
