CREATE TYPE "public"."collection_origin" AS ENUM('manual', 'automatic');--> statement-breakpoint
CREATE TABLE "automatic_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "platform" NOT NULL,
	"username" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automatic_profiles_interval_check" CHECK ("automatic_profiles"."interval_minutes" between 15 and 10080)
);
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "origin" "collection_origin" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "automatic_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "discovered_source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_profiles_platform_username_idx" ON "automatic_profiles" USING btree ("platform","username");--> statement-breakpoint
CREATE INDEX "automatic_profiles_enabled_idx" ON "automatic_profiles" USING btree ("enabled");--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_automatic_profile_id_automatic_profiles_id_fk" FOREIGN KEY ("automatic_profile_id") REFERENCES "public"."automatic_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collections_automatic_profile_idx" ON "collections" USING btree ("automatic_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_discovered_source_idx" ON "collections" USING btree ("platform","discovered_source_id") WHERE "collections"."discovered_source_id" is not null;