CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "people_message_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"source" text NOT NULL,
	"unit" text NOT NULL,
	"address" text NOT NULL,
	"message_key" text NOT NULL,
	"at" timestamp with time zone,
	"direction" text,
	"subject" text,
	"body" text,
	"search_text" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "people_message_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_id" uuid NOT NULL,
	"source" text NOT NULL,
	"unit" text NOT NULL,
	"address" text NOT NULL,
	"activity_at" timestamp with time zone,
	"status" text NOT NULL,
	"error" text,
	"messages" integer DEFAULT 0 NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "people_message_texts" ADD CONSTRAINT "people_message_texts_scope_id_people_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."people_scopes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "people_message_units" ADD CONSTRAINT "people_message_units_scope_id_people_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."people_scopes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_message_texts_unit_message_uq" ON "people_message_texts" USING btree ("scope_id","source","unit","message_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_message_texts_scope_address_idx" ON "people_message_texts" USING btree ("scope_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_message_units_uq" ON "people_message_units" USING btree ("scope_id","source","unit");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_message_texts_search_trgm_idx" ON "people_message_texts" USING gin ("search_text" gin_trgm_ops);