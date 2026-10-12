CREATE TABLE IF NOT EXISTS "form_offer_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"form_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"stated_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_trigger_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"source" text NOT NULL,
	"submission_id" text NOT NULL,
	"form_id" text,
	"form_name" text,
	"source_contact_id" text,
	"crm_contact_id" uuid,
	"full_name" text,
	"email" text,
	"phone" text,
	"answers" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
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
);
--> statement-breakpoint
ALTER TABLE "ghl_connections" ADD COLUMN IF NOT EXISTS "form_watch_since" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_offer_mappings_uq" ON "form_offer_mappings" USING btree ("org_id","brand_id","form_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_trigger_reports_submission_uq" ON "form_trigger_reports" USING btree ("org_id","brand_id","source","submission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_trigger_reports_status_idx" ON "form_trigger_reports" USING btree ("status");