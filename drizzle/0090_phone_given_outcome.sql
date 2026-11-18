-- TRIGGER-OUTCOME-1118. A number reported as « WhatsApp number given » is also declared as a Unit of that outcome on the
-- person's lead, on the run that reported it (lib/phone-trigger/outcome.ts). NULL status = reported before this shipped:
-- never declared (no backfill).
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "outcome_status" text;
--> statement-breakpoint
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "outcome_reason" text;
--> statement-breakpoint
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "outcome_lead_id" text;
--> statement-breakpoint
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "outcome_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "outcome_next_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "outcome_declared_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phone_given_reports_outcome_due_idx" ON "phone_given_reports" ("outcome_next_at") WHERE "outcome_status" = 'pending';
