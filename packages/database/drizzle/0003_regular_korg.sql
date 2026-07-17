ALTER TABLE "collections" ADD COLUMN "claim_owner" uuid;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "collections_claim_expires_at_idx" ON "collections" USING btree ("claim_expires_at");