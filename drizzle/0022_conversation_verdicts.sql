CREATE TABLE IF NOT EXISTS "conversation_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_key" text NOT NULL,
	"source" text NOT NULL,
	"topic" text NOT NULL,
	"confidence" double precision NOT NULL,
	"probabilities" jsonb NOT NULL,
	"brand_probability" double precision NOT NULL,
	"offer_scores" jsonb NOT NULL,
	"offer_ids" jsonb NOT NULL,
	"context_hash" text NOT NULL,
	"judged_through" text NOT NULL,
	"input" jsonb NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "not_business" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "relevance" jsonb;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "offer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_verdicts_org_brand_key_uq" ON "conversation_verdicts" USING btree ("org_id","brand_id","conversation_key");