-- LEDGER-HISTORY-1024: each WhatsApp message a campaign sent, declared as message_sent on its send run.
CREATE TABLE IF NOT EXISTS "message_sent_declarations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "run_id" text NOT NULL,
  "send_id" uuid NOT NULL,
  "campaign_id" text NOT NULL,
  "email" text,
  "phone" text,
  "sent_at" timestamp with time zone NOT NULL,
  "lead_id" text,
  "status" text NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_at" timestamp with time zone,
  "declared_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_sent_declarations_run_uq" ON "message_sent_declarations" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_sent_declarations_due_idx" ON "message_sent_declarations" ("next_at") WHERE "status" = 'pending';
