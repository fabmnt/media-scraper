CREATE TYPE "public"."credential_session_status" AS ENUM('valid', 'expired');--> statement-breakpoint
CREATE TABLE "platform_credential_states" (
	"platform" "platform" PRIMARY KEY NOT NULL,
	"status" "credential_session_status" NOT NULL,
	"message" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
