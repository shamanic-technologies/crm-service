CREATE TABLE IF NOT EXISTS "domain_verdicts" (
	"domain" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"confidence" double precision NOT NULL,
	"probabilities" jsonb,
	"model" text,
	"run_id" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_keys" (
	"domain" text PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"company_domain" text,
	"matched_by" text,
	"unresolved_reason" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "organizations" jsonb DEFAULT '[]'::jsonb NOT NULL;
