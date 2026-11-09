-- EVERY-PERSON-ON-THE-THREAD-1109: our sending mailboxes are a CRM source; every address on a message is a person.
CREATE TABLE IF NOT EXISTS "mailbox_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "version" text NOT NULL,
  "mailbox" text NOT NULL,
  "direction" text NOT NULL,
  "kind" text NOT NULL,
  "message_id" text,
  "in_reply_to" text,
  "references" jsonb NOT NULL,
  "thread_key" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "subject" text,
  "from_address" text,
  "from_name" text,
  "recipients" jsonb NOT NULL,
  "participants" jsonb NOT NULL,
  "text" text,
  "text_kept" boolean DEFAULT false NOT NULL,
  "text_unavailable_reason" text,
  "sent_by" text,
  "org_id" uuid,
  "brand_ids" jsonb NOT NULL,
  "campaign_id" text,
  "instantly_campaign_id" text,
  "lead_email" text,
  "mirrored_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_messages_thread_idx" ON "mailbox_messages" ("thread_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_messages_org_idx" ON "mailbox_messages" ("org_id","occurred_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_message_people" (
  "message_id" text NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "address" text NOT NULL,
  "name" text,
  "role" text NOT NULL,
  "sequence_lead" boolean NOT NULL,
  "thread_key" text,
  "occurred_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_message_people_uq" ON "mailbox_message_people" ("message_id","brand_id","address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_message_people_scope_idx" ON "mailbox_message_people" ("org_id","brand_id","address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_message_people_thread_idx" ON "mailbox_message_people" ("thread_key");
