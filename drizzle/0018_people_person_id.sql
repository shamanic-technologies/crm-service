CREATE TABLE IF NOT EXISTS "person_id_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"retired_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "person_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "person_id_aliases_org_brand_retired_uq" ON "person_id_aliases" USING btree ("org_id","brand_id","retired_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "person_ids_org_brand_key_uq" ON "person_ids" USING btree ("org_id","brand_id","identity_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_ids_org_brand_person_idx" ON "person_ids" USING btree ("org_id","brand_id","person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_org_brand_person_id_idx" ON "people" USING btree ("org_id","brand_id","person_id");