-- UNIBOX-TRANSLATE-1126. The English version of a Unibox message, translated once per (org, original words), served on
-- every later read (lib/people/translation.ts). The original is never stored here nor overwritten anywhere.
CREATE TABLE IF NOT EXISTS "message_translations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "content_hash" text NOT NULL,
  "target_language" text NOT NULL,
  "source_language" text NOT NULL,
  "already_in_target" boolean NOT NULL,
  "subject" text,
  "text" text,
  "model" text NOT NULL,
  "run_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_translations_key_uq" ON "message_translations" ("org_id", "content_hash", "target_language");
