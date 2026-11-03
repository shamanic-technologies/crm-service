-- REFUSED-CARD-LEAD-EVENT-1103: a refused charge on a brand's Stripe = one Lead event (account_event) for the payer.
CREATE TABLE IF NOT EXISTS "payment_refusal_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "charge_id" text NOT NULL,
  "charged_at" timestamp with time zone NOT NULL,
  "email" text,
  "phone" text,
  "full_name" text,
  "status" text NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_error" text,
  "offer_ids" jsonb,
  "campaign_events" jsonb,
  "run_id" text,
  "reported_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_refusal_reports_connection_charge_uq" ON "payment_refusal_reports" ("connection_id", "charge_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refusal_reports_status_idx" ON "payment_refusal_reports" ("status");
