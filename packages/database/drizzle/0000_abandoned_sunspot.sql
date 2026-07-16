CREATE TYPE "public"."collection_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('instagram', 'facebook', 'tiktok');--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_url" text NOT NULL,
	"platform" "platform" NOT NULL,
	"status" "collection_status" DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_item_id" uuid NOT NULL,
	"type" "media_type" NOT NULL,
	"file_name" text NOT NULL,
	"relative_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_seconds" real
);
--> statement-breakpoint
CREATE TABLE "media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text NOT NULL,
	"author_name" text,
	"caption" text,
	"published_at" timestamp with time zone,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collections_status_idx" ON "collections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_item_hash_idx" ON "media_assets" USING btree ("media_item_id","content_hash");--> statement-breakpoint
CREATE INDEX "media_assets_hash_idx" ON "media_assets" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "media_assets_media_item_idx" ON "media_assets" USING btree ("media_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_items_source_idx" ON "media_items" USING btree ("platform","source_id");--> statement-breakpoint
CREATE INDEX "media_items_collected_at_idx" ON "media_items" USING btree ("collected_at");