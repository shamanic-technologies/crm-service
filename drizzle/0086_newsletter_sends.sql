-- UNIBOX-NEWSLETTER-1113: every newsletter email transactional-email-service sent a subscriber (GET /internal/sent-newsletters),
-- one row per producer recipient row id, insert-only. Filed on the subscriber's thread in the sending org's scopes.
CREATE TABLE IF NOT EXISTS "newsletter_sends" (
  "id" uuid PRIMARY KEY NOT NULL,
  "release_id" uuid NOT NULL,
  "list_slug" text NOT NULL,
  "recipient_email" text NOT NULL,
  "org_id" text,
  "brand_ids" jsonb,
  "from_address" text,
  "subject" text NOT NULL,
  "sent_at" timestamp with time zone NOT NULL,
  "mirrored_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletter_sends_recipient_idx" ON "newsletter_sends" ("recipient_email","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletter_sends_org_idx" ON "newsletter_sends" ("org_id","mirrored_at");
