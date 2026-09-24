-- Stage meanings move from a completion model (anthropic/haiku) to a judgment
-- model (TypeSafe Jev), which records its CONFIDENCE and full distribution.
-- The haiku-era rows carry neither and were decided by the model being retired,
-- so they are deleted rather than back-filled with an invented confidence: the
-- next sync finds those stages undecided and records a Jev decision for each.
DELETE FROM "ghl_stage_meanings";--> statement-breakpoint
ALTER TABLE "ghl_stage_meanings" ADD COLUMN IF NOT EXISTS "confidence" double precision NOT NULL;--> statement-breakpoint
ALTER TABLE "ghl_stage_meanings" ADD COLUMN IF NOT EXISTS "probabilities" jsonb NOT NULL;
