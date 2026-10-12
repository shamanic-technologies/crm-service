CREATE TABLE IF NOT EXISTS "conversation_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"channel" text NOT NULL,
	"conversation_key" text NOT NULL,
	"start_ref" text NOT NULL,
	"email" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"telegram_message_id" integer,
	"text" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_pings_start_uq" ON "conversation_pings" USING btree ("source","start_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_pings_key_started_idx" ON "conversation_pings" USING btree ("conversation_key","started_at");