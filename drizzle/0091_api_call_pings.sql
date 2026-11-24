-- TG-EVERY-CALL-1124. One owner Telegram line per external API / MCP call (lib/api-calls/pings.ts). A call may carry no
-- account yet (an AI agent signing up through the gateway's keyless routes): caller_user_id becomes nullable.
ALTER TABLE "api_calls" ALTER COLUMN "caller_user_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_calls_received_idx" ON "api_calls" ("received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_call_pings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_id" text NOT NULL,
  "email" text NOT NULL,
  "called_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "mode" text,
  "message_group" uuid,
  "telegram_message_id" integer,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_at" timestamp with time zone DEFAULT now() NOT NULL,
  "error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_call_pings_call_uq" ON "api_call_pings" ("call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_call_pings_sent_idx" ON "api_call_pings" ("sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_call_pings_pending_idx" ON "api_call_pings" ("next_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_call_ping_watch" (
  "id" integer PRIMARY KEY NOT NULL,
  "since" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Never history: only calls received after this migration ran are pinged.
INSERT INTO "api_call_ping_watch" ("id", "since") VALUES (1, now()) ON CONFLICT ("id") DO NOTHING;
