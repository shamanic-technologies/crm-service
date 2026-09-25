CREATE TABLE IF NOT EXISTS "ghl_form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"form_external_id" text,
	"form_name" text,
	"external_contact_id" text,
	"contact_id" uuid,
	"submitted_at" timestamp with time zone,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_form_submissions" ADD CONSTRAINT "ghl_form_submissions_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_form_submissions" ADD CONSTRAINT "ghl_form_submissions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_form_submissions_conn_external_uq" ON "ghl_form_submissions" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_form_submissions_org_brand_idx" ON "ghl_form_submissions" USING btree ("org_id","brand_id");