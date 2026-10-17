CREATE TABLE IF NOT EXISTS "people_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"person_keys" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"target_key" text NOT NULL,
	"reason" text,
	"stated_by_user_id" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_corrections_org_brand_idx" ON "people_corrections" USING btree ("org_id","brand_id");
