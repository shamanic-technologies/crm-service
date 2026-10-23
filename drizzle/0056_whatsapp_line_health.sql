CREATE TABLE IF NOT EXISTS "whatsapp_line_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"link_id" uuid,
	"state" text NOT NULL,
	"bridge_state" text,
	"reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_line_spans_line_idx" ON "whatsapp_line_spans" USING btree ("org_id","brand_id","phone","started_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_line_days" (
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"day" date NOT NULL,
	"status" text NOT NULL,
	"connected_minutes" integer NOT NULL,
	"reconnecting_minutes" integer NOT NULL,
	"down_minutes" integer NOT NULL,
	"unknown_minutes" integer NOT NULL,
	"recovered_on_its_own" integer NOT NULL,
	"last_state" text,
	"last_reason" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_line_days_uq" ON "whatsapp_line_days" USING btree ("org_id","brand_id","phone","day");
