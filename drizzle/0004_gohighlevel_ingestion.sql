CREATE TABLE IF NOT EXISTS "ghl_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"location_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghl_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"pipeline_external_id" text,
	"pipeline_name" text,
	"stage_external_id" text,
	"stage_name" text,
	"status" text,
	"monetary_value" numeric,
	"assigned_to" text,
	"external_contact_id" text,
	"contact_id" uuid,
	"ghl_created_at" timestamp with time zone,
	"ghl_updated_at" timestamp with time zone,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghl_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"stages" jsonb NOT NULL,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghl_raw_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"mirrored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "external_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_opportunities" ADD CONSTRAINT "ghl_opportunities_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_opportunities" ADD CONSTRAINT "ghl_opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_pipelines" ADD CONSTRAINT "ghl_pipelines_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_raw_records" ADD CONSTRAINT "ghl_raw_records_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_connections_org_brand_uq" ON "ghl_connections" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_connections_status_idx" ON "ghl_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_opportunities_conn_external_uq" ON "ghl_opportunities" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_opportunities_org_brand_idx" ON "ghl_opportunities" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_opportunities_pipeline_idx" ON "ghl_opportunities" USING btree ("connection_id","pipeline_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_pipelines_conn_external_uq" ON "ghl_pipelines" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_pipelines_org_brand_idx" ON "ghl_pipelines" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_raw_records_conn_kind_external_uq" ON "ghl_raw_records" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_raw_records_org_brand_kind_idx" ON "ghl_raw_records" USING btree ("org_id","brand_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_org_brand_source_external_uq" ON "contacts" USING btree ("org_id","brand_id","source","external_id");--> statement-breakpoint
-- The email dedup key becomes a CSV-ONLY rule.
--
-- It exists because one CRM export lists a person once and two exports of the
-- same CRM are the same person — a statement about the CSV source, not about
-- contacts in general. A GoHighLevel contact is keyed on GoHighLevel's own id,
-- and left under the unconditional index it would collide with a CSV contact who
-- happens to share an email, letting one source silently overwrite the other.
--
-- Behaviour is UNCHANGED for every row that exists today: every pre-existing row
-- is source='csv' (backfilled by 0003) or source='matrix' with a null email,
-- which Postgres already treated as distinct. Partial index, hand-written —
-- drizzle-kit emits neither expression nor partial indexes.
DROP INDEX IF EXISTS "contacts_org_brand_lower_email_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_org_brand_lower_email_csv_uq"
  ON "contacts" USING btree ("org_id", "brand_id", lower("primary_email"))
  WHERE "source" = 'csv';
