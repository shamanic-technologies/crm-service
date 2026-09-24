CREATE TABLE IF NOT EXISTS "ghl_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"calendar_external_id" text,
	"calendar_name" text,
	"title" text,
	"status" text,
	"external_contact_id" text,
	"contact_id" uuid,
	"booked_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"ghl_updated_at" timestamp with time zone,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghl_opportunity_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"opportunity_external_id" text NOT NULL,
	"external_contact_id" text,
	"kind" text NOT NULL,
	"value" text,
	"pipeline_external_id" text,
	"pipeline_name" text,
	"stage_name" text,
	"changed_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ghl_stage_meanings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"pipeline_external_id" text,
	"pipeline_name" text,
	"stage_external_id" text NOT NULL,
	"stage_name" text NOT NULL,
	"meaning" text NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_appointments" ADD CONSTRAINT "ghl_appointments_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_appointments" ADD CONSTRAINT "ghl_appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_opportunity_history" ADD CONSTRAINT "ghl_opportunity_history_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ghl_stage_meanings" ADD CONSTRAINT "ghl_stage_meanings_connection_id_ghl_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ghl_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_appointments_conn_external_uq" ON "ghl_appointments" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_appointments_org_brand_idx" ON "ghl_appointments" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_opportunity_history_conn_opp_idx" ON "ghl_opportunity_history" USING btree ("connection_id","opportunity_external_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_opportunity_history_org_brand_idx" ON "ghl_opportunity_history" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ghl_stage_meanings_conn_stage_name_uq" ON "ghl_stage_meanings" USING btree ("connection_id","stage_external_id","stage_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ghl_stage_meanings_org_brand_idx" ON "ghl_stage_meanings" USING btree ("org_id","brand_id");