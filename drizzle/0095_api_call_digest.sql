-- TG-DAILY-DIGEST-1127. The owner's API / MCP pings become ONE daily Telegram digest (lib/api-calls/digest.ts); only a
-- signup call and a paying client's error stay live. One row per UTC day told (or found empty): a restart neither skips
-- nor sends a day twice. Days before `digest_since` (the deploy day) are never told: their calls were pinged one by one.
CREATE TABLE IF NOT EXISTS "api_call_digests" (
  "day" date PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "calls" integer DEFAULT 0 NOT NULL,
  "people" integer DEFAULT 0 NOT NULL,
  "telegram_message_id" integer,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_at" timestamp with time zone DEFAULT now() NOT NULL,
  "error" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_call_ping_watch" ADD COLUMN IF NOT EXISTS "digest_since" date;
--> statement-breakpoint
UPDATE "api_call_ping_watch" SET "digest_since" = (now() AT TIME ZONE 'UTC')::date WHERE "id" = 1 AND "digest_since" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_call_pings_called_idx" ON "api_call_pings" ("called_at");
