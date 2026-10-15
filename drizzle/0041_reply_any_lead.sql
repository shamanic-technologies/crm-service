-- REPLY-ANY-LEAD-1015: every thread's answer is reported, not only campaign threads.
ALTER TABLE "matrix_connections" ADD COLUMN IF NOT EXISTS "open_reply_watch_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ALTER COLUMN "campaign_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "offer_basis" text;
