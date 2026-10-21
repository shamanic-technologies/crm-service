-- CRM-ADD-ONE-CONTACT-1021: a client adds ONE person to the brand's CRM (JSON, no file), and a contact
-- whose email is not known yet can be handed out for an email lookup at serve time.
-- Structured fields a CSV can carry too (company, title, LinkedIn) + the client's own note.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "company_domain" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "job_title" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "note" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_csv_linkedin_idx" ON "contacts" ("org_id","brand_id","linkedin_url") WHERE "source" = 'csv' AND "linkedin_url" IS NOT NULL;--> statement-breakpoint
-- 'file' = an uploaded CSV (every existing row); 'manual' = the brand's ONE list of contacts added one by one.
ALTER TABLE "contact_uploads" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_uploads_manual_uq" ON "contact_uploads" ("org_id","brand_id") WHERE "kind" = 'manual';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_email_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text NOT NULL,
	"email" text,
	"handed_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handed_out_run_id" text NOT NULL,
	"hand_out_count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_run_id" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_email_lookups_brand_row_uq" ON "contact_email_lookups" ("brand_id","source_row_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_email_lookups_org_brand_idx" ON "contact_email_lookups" ("org_id","brand_id");--> statement-breakpoint
-- The gold view is `SELECT *` frozen at its creation: re-state it so it carries the four new columns
-- (appended at the end, which CREATE OR REPLACE allows). Same filter, byte for byte.
CREATE OR REPLACE VIEW "sendable_contacts" AS
SELECT *
FROM "contacts"
WHERE "primary_email" IS NOT NULL
  AND "primary_email" ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  AND "unsubscribed" = false
  AND "consent_status" <> 'denied'
  AND "source" = 'csv';
