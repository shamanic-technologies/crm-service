-- GOOGLE-CALENDAR-MEETING-FACTS-1021: meetings booked in a connected Google Calendar (google-service's changes feed),
-- who among the brand's leads each attendee is (Jev), and whether that lead joined the Meet call (Jev).
CREATE TABLE IF NOT EXISTS "calendar_feed_cursors" (
	"feed" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"caught_up_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"calendar_email" text NOT NULL,
	"google_event_id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"mirrored_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_org_idx" ON "calendar_events" USING btree ("org_id","google_event_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_attendee_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"attendee_email" text NOT NULL,
	"input_hash" text NOT NULL,
	"person_id" text,
	"basis" text NOT NULL,
	"confidence" double precision,
	"probabilities" jsonb,
	"candidates" jsonb NOT NULL,
	"model" text,
	"run_id" text,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_attendee_matches_uq" ON "calendar_attendee_matches" USING btree ("org_id","brand_id","attendee_email","input_hash");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_attendance_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"google_event_id" text NOT NULL,
	"person_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"participant_index" integer,
	"confidence" double precision NOT NULL,
	"probabilities" jsonb NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_attendance_verdicts_uq" ON "calendar_attendance_verdicts" USING btree ("org_id","brand_id","google_event_id","person_id","input_hash");
