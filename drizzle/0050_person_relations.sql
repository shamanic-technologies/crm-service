ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "relations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_point_org_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"contact_point" text NOT NULL,
	"choice" text NOT NULL,
	"confidence" double precision NOT NULL,
	"probabilities" jsonb NOT NULL,
	"options_hash" text NOT NULL,
	"judged_through" text NOT NULL,
	"criteria_version" integer NOT NULL,
	"input" jsonb NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_point_org_verdicts_uq" ON "contact_point_org_verdicts" USING btree ("org_id","brand_id","contact_point");
