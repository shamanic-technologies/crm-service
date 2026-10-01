CREATE TABLE IF NOT EXISTS "lead_standing_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"email" text NOT NULL,
	"found" boolean NOT NULL,
	"payload" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"person_key" text NOT NULL,
	"identity_keys" jsonb NOT NULL,
	"display_name" text,
	"company" text,
	"emails" jsonb NOT NULL,
	"phones" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"presences" jsonb NOT NULL,
	"merge_evidence" jsonb NOT NULL,
	"first_activity_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"state" text NOT NULL,
	"state_source" text NOT NULL,
	"state_detail" jsonb,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "people_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_reads" jsonb,
	"last_error" text,
	"last_built_at" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "people" ADD CONSTRAINT "people_scope_id_people_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."people_scopes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_standing_observations_org_brand_email_uq" ON "lead_standing_observations" USING btree ("org_id","brand_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_scope_person_key_uq" ON "people" USING btree ("scope_id","person_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_org_brand_activity_idx" ON "people" USING btree ("org_id","brand_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_scopes_org_brand_uq" ON "people_scopes" USING btree ("org_id","brand_id");--> statement-breakpoint
-- Any one of a person's keys opens that person (identity_keys @> '["email:a@b.com"]').
CREATE INDEX IF NOT EXISTS "people_identity_keys_gin" ON "people" USING gin ("identity_keys");
