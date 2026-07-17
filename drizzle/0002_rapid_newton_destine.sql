CREATE TABLE IF NOT EXISTS "contact_serves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"served_run_id" text NOT NULL,
	"served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_serves_brand_email_uq" ON "contact_serves" USING btree ("brand_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_serves_org_brand_idx" ON "contact_serves" USING btree ("org_id","brand_id");