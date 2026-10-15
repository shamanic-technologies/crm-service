-- GMAIL-REPLY-ANY-LEAD-1015: a person writing to the brand's connected Gmail is reported like a WhatsApp answer.
ALTER TABLE "reply_trigger_reports" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ALTER COLUMN "room_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_trigger_reports_scope_address_idx" ON "reply_trigger_reports" ("scope_id","address");--> statement-breakpoint
ALTER TABLE "people_scopes" ADD COLUMN IF NOT EXISTS "gmail_reply_watch_since" timestamp with time zone;
