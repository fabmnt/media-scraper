import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import {
  MAX_PAGE_SIZE,
  MEDIA_LIBRARY_PAGE_SIZE,
  mediaGroupModeSchema,
  platformSchema,
  type MediaGroupMode,
  type MediaItem,
  type MediaItemGroup,
  type MediaItemGroups,
} from '@media-scraper/shared';
import { serializeMediaItem } from './serialization.js';

const GROUP_KEY_MAX_LENGTH = 2_048;
const UNGROUPED_LABEL = 'All media';
const UNKNOWN_USERNAME_LABEL = 'Unknown username';
const groupedKeyPayloadSchema = z.discriminatedUnion('groupBy', [
  z.object({
    groupBy: z.literal('username'),
    value: z.string().nullable(),
  }),
  z.object({
    groupBy: z.literal('platform'),
    value: platformSchema,
  }),
]);
type GroupedKeyPayload = z.infer<typeof groupedKeyPayloadSchema>;

const groupKeySchema = z
  .string()
  .max(GROUP_KEY_MAX_LENGTH)
  .transform((value, context) => {
    try {
      return groupedKeyPayloadSchema.parse(
        JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
      );
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid media group key' });
      return z.NEVER;
    }
  });

const mediaQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(MEDIA_LIBRARY_PAGE_SIZE),
    offset: z.coerce.number().int().nonnegative().default(0),
    platform: platformSchema.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    groupBy: mediaGroupModeSchema.default('none'),
    groupKey: groupKeySchema.optional(),
  })
  .superRefine((query, context) => {
    if (query.groupKey && query.groupKey.groupBy !== query.groupBy) {
      context.addIssue({
        code: 'custom',
        message: 'Media group key does not match the grouping mode',
        path: ['groupKey'],
      });
    }
  });
type MediaItemRow = typeof mediaItems.$inferSelect;
type GroupedMediaMode = Exclude<MediaGroupMode, 'none'>;

function encodeGroupKey(payload: GroupedKeyPayload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function groupDetails(
  groupBy: GroupedMediaMode,
  row: Pick<MediaItemRow, 'authorName' | 'platform'>,
): GroupedKeyPayload {
  return groupBy === 'username'
    ? { groupBy, value: row.authorName?.trim() || null }
    : { groupBy, value: row.platform };
}

async function serializeMediaRows(
  db: Database,
  items: MediaItemRow[],
): Promise<MediaItem[]> {
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

  return items.map((item) =>
    serializeMediaItem(item, assetsByItem.get(item.id) ?? []),
  );
}

function buildFilters({
  platform,
  search,
}: {
  platform?: z.infer<typeof platformSchema> | undefined;
  search?: string | undefined;
}) {
  const filters: SQL[] = [];
  if (platform) filters.push(eq(mediaItems.platform, platform));
  if (search) {
    const escapedSearch = search.replace(/[\\%_]/g, '\\$&');
    const searchFilter = or(
      ilike(mediaItems.authorName, `%${escapedSearch}%`),
      ilike(mediaItems.caption, `%${escapedSearch}%`),
    );
    if (searchFilter) filters.push(searchFilter);
  }
  return filters;
}

async function listSingleGroup({
  db,
  filters,
  groupKey,
  limit,
  offset,
}: {
  db: Database;
  filters: SQL[];
  groupKey?: GroupedKeyPayload | undefined;
  limit: number;
  offset: number;
}): Promise<MediaItemGroup> {
  if (groupKey?.groupBy === 'username') {
    const usernameExpression = sql<
      string | null
    >`nullif(btrim(${mediaItems.authorName}), '')`;
    filters.push(
      groupKey.value === null
        ? isNull(usernameExpression)
        : eq(usernameExpression, groupKey.value),
    );
  } else if (groupKey?.groupBy === 'platform') {
    filters.push(eq(mediaItems.platform, groupKey.value));
  }

  const rows = await db
    .select()
    .from(mediaItems)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(mediaItems.collectedAt), asc(mediaItems.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  return {
    key: groupKey ? encodeGroupKey(groupKey) : 'all',
    label: groupKey
      ? (groupKey.value ?? UNKNOWN_USERNAME_LABEL)
      : UNGROUPED_LABEL,
    items: await serializeMediaRows(db, items),
    nextOffset: hasMore ? offset + limit : null,
  };
}

async function listAllGroups({
  db,
  filters,
  groupBy,
  limit,
  offset,
}: {
  db: Database;
  filters: SQL[];
  groupBy: GroupedMediaMode;
  limit: number;
  offset: number;
}): Promise<MediaItemGroup[]> {
  const groupExpression =
    groupBy === 'username'
      ? sql<string | null>`nullif(btrim(${mediaItems.authorName}), '')`
      : mediaItems.platform;
  const rankedMedia = db.$with('ranked_media').as(
    db
      .select({
        ...getTableColumns(mediaItems),
        groupRank:
          sql<number>`row_number() over (partition by ${groupExpression} order by ${desc(mediaItems.collectedAt)}, ${asc(mediaItems.id)})`.as(
            'group_rank',
          ),
      })
      .from(mediaItems)
      .where(filters.length > 0 ? and(...filters) : undefined),
  );
  const rows = await db
    .with(rankedMedia)
    .select()
    .from(rankedMedia)
    .where(
      and(
        gt(rankedMedia.groupRank, offset),
        lte(rankedMedia.groupRank, offset + limit + 1),
      ),
    )
    .orderBy(desc(rankedMedia.collectedAt), asc(rankedMedia.id));
  const rowsByGroup = new Map<
    string,
    { payload: GroupedKeyPayload; rows: MediaItemRow[] }
  >();
  for (const row of rows) {
    const payload = groupDetails(groupBy, row);
    const key = encodeGroupKey(payload);
    const group = rowsByGroup.get(key) ?? { payload, rows: [] };
    group.rows.push(row);
    rowsByGroup.set(key, group);
  }

  const groupRows = [...rowsByGroup.entries()].map(([key, group]) => ({
    key,
    payload: group.payload,
    rows: group.rows.slice(0, limit),
    nextOffset: group.rows.length > limit ? offset + limit : null,
  }));
  const serializedItems = await serializeMediaRows(
    db,
    groupRows.flatMap((group) => group.rows),
  );
  const serializedItemsById = new Map(
    serializedItems.map((item) => [item.id, item]),
  );
  const groups = groupRows.map((group): MediaItemGroup => ({
    key: group.key,
    label: group.payload.value ?? UNKNOWN_USERNAME_LABEL,
    items: group.rows.flatMap((row) => {
      const item = serializedItemsById.get(row.id);
      return item ? [item] : [];
    }),
    nextOffset: group.nextOffset,
  }));
  return groups.sort((left, right) => left.label.localeCompare(right.label));
}

export async function listMediaGroups(
  db: Database,
  rawQuery: unknown,
): Promise<MediaItemGroups> {
  const query = mediaQuerySchema.parse(rawQuery);
  const filters = buildFilters(query);
  const groups =
    query.groupBy === 'none' || query.groupKey
      ? [
          await listSingleGroup({
            db,
            filters,
            groupKey: query.groupKey,
            limit: query.limit,
            offset: query.offset,
          }),
        ]
      : await listAllGroups({
          db,
          filters,
          groupBy: query.groupBy,
          limit: query.limit,
          offset: query.offset,
        });
  return { groups };
}
