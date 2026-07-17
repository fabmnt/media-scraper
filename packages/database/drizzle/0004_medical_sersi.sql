ALTER TABLE "media_assets" ALTER COLUMN "relative_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "storage_key" text;--> statement-breakpoint
CREATE INDEX "media_assets_storage_key_idx" ON "media_assets" USING btree ("storage_key");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_storage_location_check" CHECK (num_nonnulls("media_assets"."relative_path", "media_assets"."storage_key") = 1);