import {
  bigint,
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
  COLLECTION_STATUSES,
  MEDIA_TYPES,
  SUPPORTED_PLATFORMS,
} from '@media-scraper/shared';

export const platformEnum = pgEnum('platform', SUPPORTED_PLATFORMS);
export const collectionStatusEnum = pgEnum(
  'collection_status',
  COLLECTION_STATUSES,
);
export const mediaTypeEnum = pgEnum('media_type', MEDIA_TYPES);

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceUrl: text('source_url').notNull(),
    platform: platformEnum('platform').notNull(),
    status: collectionStatusEnum('status').notNull().default('queued'),
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
    sourceUrl: text('source_url').notNull(),
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
    index('media_items_caption_trgm_idx').using(
      'gin',
      table.caption.op('gin_trgm_ops'),
    ),
    index('media_items_author_name_trgm_idx').using(
      'gin',
      table.authorName.op('gin_trgm_ops'),
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
    type: mediaTypeEnum('type').notNull(),
    fileName: text('file_name').notNull(),
    position: integer('position').notNull(),
    relativePath: text('relative_path').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentHash: text('content_hash').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: real('duration_seconds'),
  },
  (table) => [
    uniqueIndex('media_assets_item_hash_idx').on(
      table.mediaItemId,
      table.contentHash,
    ),
    index('media_assets_hash_idx').on(table.contentHash),
    uniqueIndex('media_assets_item_position_idx').on(
      table.mediaItemId,
      table.position,
    ),
    index('media_assets_media_item_idx').on(table.mediaItemId),
  ],
);
