CREATE TABLE IF NOT EXISTS "platform_signup_facts" (
	"fact_id" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"type" text NOT NULL,
	"withdrawn_of" text,
	"payload" jsonb NOT NULL,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_signup_facts_seq_uq" ON "platform_signup_facts" USING btree ("seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_signup_facts_org_brand_idx" ON "platform_signup_facts" USING btree ("org_id","brand_id");
