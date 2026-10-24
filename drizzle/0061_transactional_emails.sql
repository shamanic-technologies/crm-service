-- TX-EMAIL-IN-UNIBOX-1024: bronze mirror of transactional-email-service's sent-emails feed. New table, additive.
CREATE TABLE IF NOT EXISTS "transactional_emails" (
  "id" uuid PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "recipient_email" text NOT NULL,
  "billed_org_id" uuid,
  "brand_ids" jsonb,
  "from_address" text,
  "subject" text,
  "text" text,
  "text_body" text,
  "html_body" text,
  "message_source" text NOT NULL,
  "sent_at" timestamp with time zone NOT NULL,
  "mirrored_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactional_emails_recipient_idx" ON "transactional_emails" USING btree ("recipient_email","sent_at");
