CREATE TYPE "public"."profile_backfill_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "profile_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automatic_profile_id" uuid NOT NULL,
	"status" "profile_backfill_status" DEFAULT 'queued' NOT NULL,
	"cursor" text,
	"page_number" integer DEFAULT 0 NOT NULL,
	"items_discovered" integer DEFAULT 0 NOT NULL,
	"collections_queued" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_backfills" ADD CONSTRAINT "profile_backfills_automatic_profile_id_automatic_profiles_id_fk" FOREIGN KEY ("automatic_profile_id") REFERENCES "public"."automatic_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_backfills_automatic_profile_idx" ON "profile_backfills" USING btree ("automatic_profile_id");--> statement-breakpoint
CREATE INDEX "profile_backfills_status_idx" ON "profile_backfills" USING btree ("status");