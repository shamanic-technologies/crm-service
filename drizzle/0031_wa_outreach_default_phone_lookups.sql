CREATE TABLE IF NOT EXISTS "whatsapp_phone_lookups" (
	"phone" text PRIMARY KEY NOT NULL,
	"ghost_mxid" text,
	"outcome" text NOT NULL,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matrix_links" ADD COLUMN "outreach_default" boolean DEFAULT false NOT NULL;