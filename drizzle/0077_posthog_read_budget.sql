-- POSTHOG-429-1107: a PostHog read-budget refusal is a temporary state (rate_limited_*), never `error`; persons are
-- re-listed every 6 h (persons_listed_at); each person's history is read once, paced (history_read_at).
ALTER TABLE "posthog_connections" ADD COLUMN IF NOT EXISTS "rate_limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posthog_connections" ADD COLUMN IF NOT EXISTS "rate_limited_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posthog_connections" ADD COLUMN IF NOT EXISTS "rate_limit_message" text;--> statement-breakpoint
ALTER TABLE "posthog_connections" ADD COLUMN IF NOT EXISTS "persons_listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posthog_raw_records" ADD COLUMN IF NOT EXISTS "history_read_at" timestamp with time zone;--> statement-breakpoint
-- Persons mirrored before the read budget ran out (2026-11-02 16:32 UTC, last complete pass) had their history read.
-- Those mirrored since (by fast-mirror attempts refused half-way) are left NULL: the backlog reads them.
UPDATE "posthog_raw_records" SET "history_read_at" = "mirrored_at"
  WHERE "kind" = 'person' AND "history_read_at" IS NULL AND "mirrored_at" < '2026-11-02 16:00:00+00';--> statement-breakpoint
-- A connection already in error because of the read budget is not broken: it waits.
UPDATE "posthog_connections" SET "status" = 'active', "rate_limited_since" = coalesce("last_synced_at", now()),
  "rate_limit_message" = "last_error", "last_error" = NULL
  WHERE "status" = 'error' AND "last_error" LIKE '%returned 429%';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posthog_raw_records_history_backlog_idx" ON "posthog_raw_records" ("connection_id") WHERE "kind" = 'person' AND "history_read_at" IS NULL;
