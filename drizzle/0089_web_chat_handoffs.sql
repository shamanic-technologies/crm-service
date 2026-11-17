ALTER TABLE "copilot_messages" ALTER COLUMN "chat_org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "copilot_messages" ALTER COLUMN "chat_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "copilot_messages" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "copilot_messages" ADD COLUMN IF NOT EXISTS "visitor_id" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "web_chat_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"visitor_id" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"full_name" text,
	"status" text NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"offer_id" uuid,
	"offer_basis" text,
	"offer_verdict" jsonb,
	"campaign_event_id" text,
	"run_id" text,
	"reported_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_chat_handoffs_conversation_email_uq" ON "web_chat_handoffs" USING btree ("org_id","brand_id","conversation_id","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_messages_web_received_idx" ON "copilot_messages" USING btree ("org_id","brand_id","received_at") WHERE "channel" = 'web';
