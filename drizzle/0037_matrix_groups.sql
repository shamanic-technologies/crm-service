CREATE TABLE IF NOT EXISTS "matrix_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL REFERENCES "matrix_connections"("id") ON DELETE cascade,
	"channel" text NOT NULL,
	"room_id" text NOT NULL,
	"name" text,
	"member_count" integer NOT NULL,
	"message_count" integer NOT NULL,
	"last_rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_groups_brand_room_uq" ON "matrix_groups" USING btree ("org_id","brand_id","room_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matrix_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"group_id" uuid NOT NULL REFERENCES "matrix_groups"("id") ON DELETE cascade,
	"room_id" text NOT NULL,
	"contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE cascade,
	"ghost_mxid" text NOT NULL,
	"membership" text NOT NULL,
	"joined_at" timestamp with time zone,
	"authored_count" integer NOT NULL,
	"first_authored_at" timestamp with time zone,
	"last_authored_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_group_members_group_ghost_uq" ON "matrix_group_members" USING btree ("group_id","ghost_mxid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_group_members_contact_idx" ON "matrix_group_members" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_group_members_org_brand_idx" ON "matrix_group_members" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_raw_events_brand_room_idx" ON "matrix_raw_events" USING btree ("org_id","brand_id","room_id");--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "group_only" boolean DEFAULT false NOT NULL;
