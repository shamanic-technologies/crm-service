ALTER TABLE "matrix_connections" ADD COLUMN IF NOT EXISTS "assistant_ping_since" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_message_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"message_ref" text NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"connection_id" uuid,
	"message_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"telegram_message_id" integer,
	"text" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_message_pings_message_uq" ON "assistant_message_pings" USING btree ("source","message_ref");
