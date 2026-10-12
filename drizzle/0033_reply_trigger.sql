ALTER TABLE "matrix_connections" ADD COLUMN IF NOT EXISTS "reply_watch_since" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reply_trigger_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"source" text NOT NULL,
	"channel" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"room_id" text NOT NULL,
	"conversation_id" uuid,
	"anchor_event_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"offer_id" uuid,
	"messages" jsonb NOT NULL,
	"first_message_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"judgment" jsonb,
	"person_id" uuid,
	"full_name" text,
	"email" text,
	"phone" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"run_id" text,
	"reported_at" timestamp with time zone,
	"campaign_event_id" text,
	"campaign_recorded_at" timestamp with time zone,
	"campaign_outcome" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reply_trigger_reports_anchor_uq" ON "reply_trigger_reports" USING btree ("org_id","brand_id","source","anchor_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_trigger_reports_room_idx" ON "reply_trigger_reports" USING btree ("connection_id","room_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_trigger_reports_status_idx" ON "reply_trigger_reports" USING btree ("status");
