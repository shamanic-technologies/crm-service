CREATE TABLE IF NOT EXISTS "auth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"provider_user_count" integer,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_raw_records" (
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
DO $$ BEGIN
 ALTER TABLE "auth_raw_records" ADD CONSTRAINT "auth_raw_records_connection_id_auth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."auth_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_connections_org_brand_provider_uq" ON "auth_connections" USING btree ("org_id","brand_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_connections_status_idx" ON "auth_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_raw_records_conn_kind_external_uq" ON "auth_raw_records" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_raw_records_org_brand_kind_idx" ON "auth_raw_records" USING btree ("org_id","brand_id","kind");