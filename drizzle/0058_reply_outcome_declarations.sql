-- COST-ACCOUNTING-1023-P1: a reply burst judged POSITIVE declares `conversation` (Positive reply) on the run that
-- judged it, at runs-service, subject = the person's lead in lead-service. Additive, nullable: every existing row
-- reads NULL (nothing to declare), so no burst judged before this ships is declared.
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "judge_run_id" text;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "wrote_before" boolean;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_status" text;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_lead_id" text;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_last_error" text;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_declared_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_trigger_reports_outcome_due_idx" ON "reply_trigger_reports" USING btree ("outcome_next_at") WHERE "outcome_status" = 'pending';
