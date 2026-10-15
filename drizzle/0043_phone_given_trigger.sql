-- WA-GIVEN-TRIGGER-1015: a person giving the brand their phone number is reported once per (brand, number).
CREATE TABLE IF NOT EXISTS "phone_given_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"source" text NOT NULL,
	"contact_id" uuid,
	"source_contact_id" text,
	"artifact_id" uuid,
	"full_name" text,
	"first_name" text,
	"last_name" text,
	"email" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"offer_id" uuid,
	"run_id" text,
	"reported_at" timestamp with time zone,
	"campaign_event_id" text,
	"campaign_recorded_at" timestamp with time zone,
	"campaign_outcome" jsonb
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_given_reports_phone_uq" ON "phone_given_reports" ("org_id","brand_id","phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_given_reports_status_idx" ON "phone_given_reports" ("status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "phone_watch_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"source" text NOT NULL,
	"baseline_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phones_at_baseline" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_watch_artifacts_artifact_uq" ON "phone_watch_artifacts" ("org_id","brand_id","artifact_id");
