CREATE TABLE IF NOT EXISTS "matrix_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"matrix_user_id" text,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"bridge_process_id" text,
	"bridge_step_id" text,
	"display_type" text,
	"display_data" text,
	"instructions" text,
	"display_issued_at" timestamp with time zone,
	"remote_login_id" text,
	"remote_name" text,
	"error_code" text,
	"error_message" text,
	"connection_id" uuid,
	"run_id" text,
	"started_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matrix_connections" ADD COLUMN "access_token" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "matrix_links" ADD CONSTRAINT "matrix_links_connection_id_matrix_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."matrix_connections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_links_org_brand_channel_uq" ON "matrix_links" USING btree ("org_id","brand_id","channel");