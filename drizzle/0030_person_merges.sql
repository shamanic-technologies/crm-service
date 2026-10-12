CREATE TABLE IF NOT EXISTS "person_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"person_id_a" uuid NOT NULL,
	"person_id_b" uuid NOT NULL,
	"keys_a" jsonb NOT NULL,
	"keys_b" jsonb NOT NULL,
	"reason" text,
	"stated_by_user_id" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" text,
	"undo_run_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_merges_org_brand_idx" ON "person_merges" USING btree ("org_id","brand_id");