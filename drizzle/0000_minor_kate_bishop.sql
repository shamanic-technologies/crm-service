CREATE TABLE IF NOT EXISTS "contact_rows_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_hash" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"column_headers" jsonb NOT NULL,
	"column_mapping" jsonb,
	"mapping_provenance" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"run_id" text NOT NULL,
	"parent_run_id" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"primary_email" text,
	"phone_e164" text,
	"full_name" text,
	"first_name" text,
	"last_name" text,
	"raw_attributes" jsonb NOT NULL,
	"consent_status" text DEFAULT 'unknown' NOT NULL,
	"unsubscribed" boolean DEFAULT false NOT NULL,
	"source_upload_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_rows_raw" ADD CONSTRAINT "contact_rows_raw_upload_id_contact_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."contact_uploads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_rows_raw_upload_row_uq" ON "contact_rows_raw" USING btree ("upload_id","row_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_rows_raw_org_brand_idx" ON "contact_rows_raw" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_uploads_org_brand_hash_uq" ON "contact_uploads" USING btree ("org_id","brand_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_uploads_org_brand_idx" ON "contact_uploads" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_org_brand_idx" ON "contacts" USING btree ("org_id","brand_id");