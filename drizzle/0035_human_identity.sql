ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "human_id" uuid;--> statement-breakpoint
ALTER TABLE "people_facts" ADD COLUMN IF NOT EXISTS "human_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_keys" (
	"org_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"human_id" uuid NOT NULL,
	"atomic_human_id" uuid,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_keys_org_id_identity_key_pk" PRIMARY KEY("org_id","identity_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_keys_human_idx" ON "human_keys" USING btree ("human_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_keys_atomic_idx" ON "human_keys" USING btree ("atomic_human_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_resolutions" (
	"org_id" uuid NOT NULL,
	"keys_hash" text NOT NULL,
	"keys" jsonb NOT NULL,
	"human_id" uuid,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_resolutions_org_id_keys_hash_pk" PRIMARY KEY("org_id","keys_hash")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_link_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"human_ids" jsonb NOT NULL,
	"link_id" uuid,
	"stated_org_id" uuid NOT NULL,
	"stated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "human_link_statements_live_uq" ON "human_link_statements" USING btree ("org_id","brand_id","kind","ref") WHERE "human_link_statements"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_fact_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"human_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"stated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "human_fact_statements_live_uq" ON "human_fact_statements" USING btree ("org_id","brand_id","subject","kind") WHERE "human_fact_statements"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_event_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"after" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
