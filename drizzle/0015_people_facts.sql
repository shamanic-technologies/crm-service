CREATE TABLE IF NOT EXISTS "people_facts" (
	"feed_seq" bigserial PRIMARY KEY NOT NULL,
	"fact_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"person_key" text NOT NULL,
	"emails" jsonb NOT NULL,
	"phones" jsonb NOT NULL,
	"full_name" text,
	"source_contact_id" text,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"date_basis" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"withdrawn_of" uuid,
	"natural_key" text,
	"family" text,
	"content_hash" text,
	"live" boolean DEFAULT true NOT NULL,
	"owner_person_key" text,
	"subject_presence" text,
	"subject_keys" jsonb,
	"subject_standalone" boolean DEFAULT false NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_facts_fact_id_uq" ON "people_facts" USING btree ("fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_facts_live_natural_key_uq" ON "people_facts" USING btree ("org_id","brand_id","natural_key") WHERE "people_facts"."live" AND "people_facts"."natural_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_facts_org_brand_seq_idx" ON "people_facts" USING btree ("org_id","brand_id","feed_seq");