CREATE TABLE IF NOT EXISTS "posthog_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"external_person_id" text NOT NULL,
	"contact_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"name" text NOT NULL,
	"url" text,
	"pageviews" integer,
	"detail" jsonb NOT NULL,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posthog_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"region" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"synced_through" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posthog_raw_records" (
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
CREATE TABLE IF NOT EXISTS "stripe_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"key_mode" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_raw_records" (
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
CREATE TABLE IF NOT EXISTS "stripe_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"external_customer_id" text,
	"contact_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"status" text,
	"description" text,
	"detail" jsonb NOT NULL,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "posthog_activities" ADD CONSTRAINT "posthog_activities_connection_id_posthog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."posthog_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "posthog_activities" ADD CONSTRAINT "posthog_activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "posthog_raw_records" ADD CONSTRAINT "posthog_raw_records_connection_id_posthog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."posthog_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stripe_raw_records" ADD CONSTRAINT "stripe_raw_records_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stripe_transactions" ADD CONSTRAINT "stripe_transactions_connection_id_stripe_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."stripe_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stripe_transactions" ADD CONSTRAINT "stripe_transactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "posthog_activities_conn_kind_external_uq" ON "posthog_activities" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posthog_activities_contact_idx" ON "posthog_activities" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "posthog_connections_org_brand_uq" ON "posthog_connections" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posthog_connections_status_idx" ON "posthog_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "posthog_raw_records_conn_kind_external_uq" ON "posthog_raw_records" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posthog_raw_records_org_brand_kind_idx" ON "posthog_raw_records" USING btree ("org_id","brand_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_connections_org_brand_uq" ON "stripe_connections" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_connections_status_idx" ON "stripe_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_raw_records_conn_kind_external_uq" ON "stripe_raw_records" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_raw_records_org_brand_kind_idx" ON "stripe_raw_records" USING btree ("org_id","brand_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_transactions_conn_kind_external_uq" ON "stripe_transactions" USING btree ("connection_id","kind","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_transactions_contact_idx" ON "stripe_transactions" USING btree ("contact_id");