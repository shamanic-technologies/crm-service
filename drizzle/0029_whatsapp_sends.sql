CREATE TABLE IF NOT EXISTS "matrix_ghost_phones" (
	"ghost_mxid" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"email" text,
	"phone" text,
	"phone_source" text,
	"connection_id" uuid,
	"from_account" text,
	"room_id" text,
	"ghost_mxid" text,
	"event_id" text,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error" text,
	"run_id" text,
	"campaign_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_sends_idem_uq" ON "whatsapp_sends" USING btree ("org_id","brand_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_sends_brand_email_idx" ON "whatsapp_sends" USING btree ("brand_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_sends_brand_phone_idx" ON "whatsapp_sends" USING btree ("brand_id","phone");