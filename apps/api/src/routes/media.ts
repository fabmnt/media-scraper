import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
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

function pathWithinRoot(root: string, relativePath: string) {
  const absolutePath = resolve(root, relativePath);
  return absolutePath.startsWith(`${root}${sep}`) ? absolutePath : undefined;
}

async function removeEmptyParents(root: string, path: string) {
  let directory = dirname(path);
  while (directory.startsWith(`${root}${sep}`)) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

export async function mediaRoutes(
  app: FastifyInstance,
  { db, mediaRoot }: { db: Database; mediaRoot: string },
) {
  const root = resolve(mediaRoot);

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
      .orderBy(desc(mediaItems.collectedAt))
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

  app.get('/:id/download', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const [asset] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id));
    if (!asset) return reply.code(404).send({ message: 'Asset not found' });
    if (!pathWithinRoot(root, asset.relativePath)) {
      return reply.code(400).send({ message: 'Invalid asset path' });
    }
    const safeFileName = basename(asset.fileName).replace(/["\r\n]/g, '_');
    reply.header(
      'content-disposition',
      `attachment; filename="${safeFileName}"`,
    );
    return reply.sendFile(asset.relativePath, root);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const assets = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.mediaItemId, id));
    const [existing] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, id));
    if (!existing)
      return reply.code(404).send({ message: 'Media item not found' });

    const trashDirectory = resolve(root, '.trash', randomUUID());
    await mkdir(trashDirectory, { recursive: true });
    const stagedFiles: Array<{ original: string; staged: string }> = [];
    try {
      for (const [index, asset] of assets.entries()) {
        const original = pathWithinRoot(root, asset.relativePath);
        if (!original) continue;
        const staged = resolve(
          trashDirectory,
          `${String(index)}-${basename(original)}`,
        );
        try {
          await rename(original, staged);
          stagedFiles.push({ original, staged });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await db.delete(mediaItems).where(eq(mediaItems.id, id));
    } catch (error) {
      await Promise.all(
        stagedFiles.map(async ({ original, staged }) => {
          await mkdir(dirname(original), { recursive: true });
          await rename(staged, original);
        }),
      );
      await rm(trashDirectory, { force: true, recursive: true });
      throw error;
    }

    await rm(trashDirectory, { force: true, recursive: true }).catch((error) =>
      request.log.warn(error, 'Could not remove staged media files'),
    );
    await Promise.all(
      stagedFiles.map(({ original }) => removeEmptyParents(root, original)),
    );
    return reply.code(204).send();
  });
}
