CREATE TYPE "public"."media_maintenance_type" AS ENUM('delete_local', 'delete_object', 'enforce_retention');--> statement-breakpoint
CREATE TABLE "media_maintenance_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "media_maintenance_type" NOT NULL,
	"target" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "media_assets_storage_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "media_maintenance_tasks_target_idx" ON "media_maintenance_tasks" USING btree ("type","target");--> statement-breakpoint
CREATE INDEX "media_maintenance_tasks_available_idx" ON "media_maintenance_tasks" USING btree ("available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_relative_path_idx" ON "media_assets" USING btree ("relative_path");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_key_idx" ON "media_assets" USING btree ("storage_key");