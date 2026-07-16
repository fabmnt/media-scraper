ALTER TABLE "media_assets" ADD COLUMN "position" integer;--> statement-breakpoint
WITH ranked_assets AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "media_item_id"
    ORDER BY "id"
  ) - 1 AS "position"
  FROM "media_assets"
)
UPDATE "media_assets"
SET "position" = ranked_assets."position"
FROM ranked_assets
WHERE "media_assets"."id" = ranked_assets."id";--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_item_position_idx" ON "media_assets" USING btree ("media_item_id","position");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
