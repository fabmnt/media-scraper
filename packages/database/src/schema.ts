import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  COLLECTION_ORIGINS,
  COLLECTION_STATUSES,
  MAX_AUTOMATIC_COLLECTION_INTERVAL_MINUTES,
  MEDIA_MAINTENANCE_TYPES,
  MEDIA_PLATFORMS,
  MEDIA_TYPES,
  PROFILE_BACKFILL_STATUSES,
  MIN_AUTOMATIC_COLLECTION_INTERVAL_MINUTES,
  type Platform,
} from '@media-scraper/shared';

export const platformEnum = pgEnum('platform', MEDIA_PLATFORMS);
export const collectionStatusEnum = pgEnum(
  'collection_status',
  COLLECTION_STATUSES,
);
export const collectionOriginEnum = pgEnum(
  'collection_origin',
  COLLECTION_ORIGINS,
);
export const mediaTypeEnum = pgEnum('media_type', MEDIA_TYPES);
export const profileBackfillStatusEnum = pgEnum(
  'profile_backfill_status',
  PROFILE_BACKFILL_STATUSES,
);
export const mediaMaintenanceTypeEnum = pgEnum(
  'media_maintenance_type',
  MEDIA_MAINTENANCE_TYPES,
);

export const automaticProfiles = pgTable(
  'automatic_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    platform: platformEnum('platform').$type<Platform>().notNull(),
    username: text('username').notNull(),
    intervalMinutes: integer('interval_minutes').notNull(),
    includeStories: boolean('include_stories').notNull().default(false),
    includeHighlights: boolean('include_highlights').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'automatic_profiles_interval_check',
      sql`${table.intervalMinutes} between ${sql.raw(String(MIN_AUTOMATIC_COLLECTION_INTERVAL_MINUTES))} and ${sql.raw(String(MAX_AUTOMATIC_COLLECTION_INTERVAL_MINUTES))}`,
    ),
    uniqueIndex('automatic_profiles_platform_username_idx').on(
      table.platform,
      table.username,
    ),
    index('automatic_profiles_enabled_idx').on(table.enabled),
  ],
);

export const profileBackfills = pgTable(
  'profile_backfills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    automaticProfileId: uuid('automatic_profile_id')
      .notNull()
      .references(() => automaticProfiles.id, { onDelete: 'cascade' }),
    status: profileBackfillStatusEnum('status').notNull().default('queued'),
    includeStories: boolean('include_stories').notNull().default(false),
    includeHighlights: boolean('include_highlights').notNull().default(false),
    cursor: text('cursor'),
    pageNumber: integer('page_number').notNull().default(0),
    itemsDiscovered: integer('items_discovered').notNull().default(0),
    collectionsQueued: integer('collections_queued').notNull().default(0),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('profile_backfills_automatic_profile_idx').on(
      table.automaticProfileId,
    ),
    index('profile_backfills_status_idx').on(table.status),
  ],
);

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceUrl: text('source_url'),
    platform: platformEnum('platform').notNull(),
    status: collectionStatusEnum('status').notNull().default('queued'),
    origin: collectionOriginEnum('origin').notNull().default('manual'),
    automaticProfileId: uuid('automatic_profile_id').references(
      () => automaticProfiles.id,
      { onDelete: 'set null' },
    ),
    discoveredSourceId: text('discovered_source_id'),
    discoveredSourceVersion: text('discovered_source_version'),
    errorMessage: text('error_message'),
    claimOwner: uuid('claim_owner'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('collections_status_idx').on(table.status),
    index('collections_claim_expires_at_idx').on(table.claimExpiresAt),
    index('collections_automatic_profile_idx').on(table.automaticProfileId),
    uniqueIndex('collections_discovered_source_idx')
      .on(table.platform, table.discoveredSourceId)
      .where(sql`${table.discoveredSourceId} is not null`),
  ],
);

export const mediaMaintenanceTasks = pgTable(
  'media_maintenance_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: mediaMaintenanceTypeEnum('type').notNull(),
    target: text('target').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    version: integer('version').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('media_maintenance_tasks_target_idx').on(
      table.type,
      table.target,
    ),
    index('media_maintenance_tasks_available_idx').on(table.availableAt),
  ],
);

export const mediaItems = pgTable(
  'media_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    platform: platformEnum('platform').notNull(),
    sourceId: text('source_id').notNull(),
    sourceUrl: text('source_url'),
    authorName: text('author_name'),
    caption: text('caption'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('media_items_source_idx').on(table.platform, table.sourceId),
    index('media_items_collected_at_idx').on(table.collectedAt),
    index('media_items_published_at_idx').on(
      table.publishedAt.desc().nullsLast(),
      table.collectedAt.desc(),
      table.id.asc(),
    ),
    index('media_items_caption_trgm_idx').using(
      'gin',
      table.caption.op('gin_trgm_ops'),
    ),
    index('media_items_author_name_trgm_idx').using(
      'gin',
      table.authorName.op('gin_trgm_ops'),
    ),
    index('media_items_author_group_pagination_idx').on(
      sql`nullif(btrim(${table.authorName}), '')`,
      table.collectedAt.desc(),
      table.id.asc(),
    ),
    index('media_items_platform_group_pagination_idx').on(
      table.platform,
      table.collectedAt.desc(),
      table.id.asc(),
    ),
    index('media_items_author_published_group_pagination_idx').on(
      sql`nullif(btrim(${table.authorName}), '')`,
      table.publishedAt.desc().nullsLast(),
      table.collectedAt.desc(),
      table.id.asc(),
    ),
    index('media_items_platform_published_group_pagination_idx').on(
      table.platform,
      table.publishedAt.desc().nullsLast(),
      table.collectedAt.desc(),
      table.id.asc(),
    ),
  ],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    thumbnailForAssetId: uuid('thumbnail_for_asset_id'),
    type: mediaTypeEnum('type').notNull(),
    fileName: text('file_name').notNull(),
    position: integer('position').notNull(),
    relativePath: text('relative_path'),
    storageKey: text('storage_key'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentHash: text('content_hash').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: real('duration_seconds'),
  },
  (table) => [
    check(
      'media_assets_storage_location_check',
      sql`num_nonnulls(${table.relativePath}, ${table.storageKey}) = 1`,
    ),
    uniqueIndex('media_assets_item_hash_idx').on(
      table.mediaItemId,
      table.contentHash,
    ),
    index('media_assets_hash_idx').on(table.contentHash),
    uniqueIndex('media_assets_relative_path_idx').on(table.relativePath),
    uniqueIndex('media_assets_storage_key_idx').on(table.storageKey),
    uniqueIndex('media_assets_item_position_idx').on(
      table.mediaItemId,
      table.position,
    ),
    uniqueIndex('media_assets_thumbnail_for_asset_idx').on(
      table.thumbnailForAssetId,
    ),
    foreignKey({
      columns: [table.thumbnailForAssetId],
      foreignColumns: [table.id],
      name: 'media_assets_thumbnail_for_asset_id_media_assets_id_fk',
    }).onDelete('cascade'),
    index('media_assets_media_item_idx').on(table.mediaItemId),
  ],
);
