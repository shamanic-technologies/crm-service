-- CONTACT-REDIRECT-1101: a person says "reach me on this other number / address": the handle joins the person
-- (stated_handle evidence) and, when preferred, the brand's sends go there from now on.
CREATE TABLE IF NOT EXISTS "person_contact_handles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "person_keys" jsonb NOT NULL,
  "handle_kind" text NOT NULL,
  "handle" text NOT NULL,
  "handle_key" text NOT NULL,
  "preferred" boolean DEFAULT true NOT NULL,
  "channel" text,
  "reason" text,
  "evidence" jsonb,
  "stated_by_user_id" text NOT NULL,
  "run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "undone_at" timestamp with time zone,
  "undone_by_user_id" text,
  "undo_run_id" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_contact_handles_org_brand_idx" ON "person_contact_handles" ("org_id", "brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_contact_handles_handle_key_idx" ON "person_contact_handles" ("org_id", "brand_id", "handle_key");
