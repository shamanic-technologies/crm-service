-- COST-BACKFILL-1023-CRM: a positive reply judged before the forward declaration shipped is declared on the run
-- that judged it with runs-service `occurredAt` = 'run_started_at'. Additive, nullable: NULL = declared on time.
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "outcome_occurred_at" text;
