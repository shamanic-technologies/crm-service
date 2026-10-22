-- SAME-HUMAN-TWO-LEADS-1022: two people of a brand sharing a full name (a work address and a personal Gmail) are asked
-- to Jev once: same human or not. A `same` verdict is stated to human-service as an org-scoped link, like a stated
-- merge; a user saying "not the same person" rejects it for good.
CREATE TABLE IF NOT EXISTS "same_person_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"key_a" text NOT NULL,
	"key_b" text NOT NULL,
	"name" text NOT NULL,
	"keys_a" jsonb NOT NULL,
	"keys_b" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"probability_same" double precision NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rejected_at" timestamp with time zone,
	"rejected_by_user_id" text,
	"rejected_reason" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "same_person_verdicts_pair_uq" ON "same_person_verdicts" USING btree ("org_id","brand_id","key_a","key_b");
