ALTER TYPE "public"."collection_origin" ADD VALUE 'upload';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'manual';--> statement-breakpoint
ALTER TABLE "collections" ALTER COLUMN "source_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_items" ALTER COLUMN "source_url" DROP NOT NULL;