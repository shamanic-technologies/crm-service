CREATE TABLE IF NOT EXISTS "copilot_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"chat_org_id" uuid NOT NULL,
	"chat_user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_messages_message_uq" ON "copilot_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_messages_scope_email_idx" ON "copilot_messages" USING btree ("org_id","brand_id","email","sent_at");