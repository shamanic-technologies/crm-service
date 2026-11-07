-- AUDIENCE-PER-OFFER-1107: hand a brand's CRM contact to ONE asker (an offer audience) to judge, without burning it for the brand.
CREATE TABLE IF NOT EXISTS "contact_hand_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"asker" text NOT NULL,
	"pool" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"emails" jsonb NOT NULL,
	"status" text DEFAULT 'handed_out' NOT NULL,
	"reason" text,
	"handed_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handed_out_run_id" text NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_run_id" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_hand_outs_brand_asker_idx" ON "contact_hand_outs" ("brand_id","asker");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_hand_out_keys" (
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"asker" text NOT NULL,
	"key" text NOT NULL,
	"hand_out_id" uuid NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_hand_out_keys_uq" ON "contact_hand_out_keys" ("brand_id","asker","key");
