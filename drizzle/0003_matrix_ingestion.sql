CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"room_id" text NOT NULL,
	"first_message_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"message_count" integer NOT NULL,
	"inbound_count" integer NOT NULL,
	"outbound_count" integer NOT NULL,
	"last_event_id" text NOT NULL,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matrix_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"matrix_user_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"counterpart_prefix" text NOT NULL,
	"since_token" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matrix_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text NOT NULL,
	"next_step" text NOT NULL,
	"estimated_value_usd" integer NOT NULL,
	"summary" text NOT NULL,
	"computed_through_event_id" text NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matrix_raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"room_id" text NOT NULL,
	"sender" text NOT NULL,
	"event_type" text NOT NULL,
	"state_key" text,
	"origin_server_ts" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "source_upload_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "source_row_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source" text DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "channel_handle" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_connection_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_connection_id_matrix_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."matrix_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matrix_leads" ADD CONSTRAINT "matrix_leads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matrix_raw_events" ADD CONSTRAINT "matrix_raw_events_connection_id_matrix_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."matrix_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_contact_channel_uq" ON "conversations" USING btree ("contact_id","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_brand_idx" ON "conversations" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_connections_org_brand_channel_uq" ON "matrix_connections" USING btree ("org_id","brand_id","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_connections_status_idx" ON "matrix_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_leads_conversation_uq" ON "matrix_leads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_leads_org_brand_idx" ON "matrix_leads" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_raw_events_event_id_uq" ON "matrix_raw_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_raw_events_room_idx" ON "matrix_raw_events" USING btree ("connection_id","room_id","origin_server_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_raw_events_org_brand_idx" ON "matrix_raw_events" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_org_brand_source_idx" ON "contacts" USING btree ("org_id","brand_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_org_brand_channel_handle_uq" ON "contacts" USING btree ("org_id","brand_id","channel","channel_handle");--> statement-breakpoint
-- GOLD guard — Matrix-sourced contacts are NEVER sendable.
--
-- `ADD COLUMN "source" text DEFAULT 'csv' NOT NULL` above backfills every
-- pre-existing row to 'csv', so this guard cannot filter out a single contact
-- that was sendable before this migration: the view's behaviour is byte-identical
-- for every existing row. It is an ALLOWLIST on purpose — a new source has to opt
-- into cold outreach deliberately, because the failure mode (cold-emailing
-- someone who is already in conversation with the user) is worse than the
-- opposite one.
--
-- `CREATE OR REPLACE VIEW` keeps the existing column list and appends the four
-- new `contacts` columns at the end, which Postgres allows.
CREATE OR REPLACE VIEW "sendable_contacts" AS
SELECT *
FROM "contacts"
WHERE "primary_email" IS NOT NULL
  AND "primary_email" ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  AND "unsubscribed" = false
  AND "consent_status" <> 'denied'
  AND "source" = 'csv';
