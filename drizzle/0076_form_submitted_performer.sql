-- OUTCOME-PERFORMER-1106: who performed each declared form_submitted occurrence is stated once at runs-service.
-- performer_status: NULL = not stated yet (declared before the performer existed), 'stated', 'conflict' (runs-service holds another), 'refused'.
ALTER TABLE "form_submitted_declarations" ADD COLUMN IF NOT EXISTS "performer_status" text;--> statement-breakpoint
ALTER TABLE "form_submitted_declarations" ADD COLUMN IF NOT EXISTS "performer_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submitted_declarations_performer_due_idx" ON "form_submitted_declarations" ("submitted_at") WHERE "status" = 'declared' AND "performer_status" IS NULL;
