-- CRM-FORM-SUBMITTED-LEDGER-1025: each CRM form submission crm-service holds, declared as form_submitted on its lead.
CREATE TABLE IF NOT EXISTS "form_submitted_declarations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "source" text NOT NULL,
  "submission_external_id" text NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "run_id" text,
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
CREATE UNIQUE INDEX IF NOT EXISTS "form_submitted_declarations_submission_uq" ON "form_submitted_declarations" ("org_id", "brand_id", "source", "submission_external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submitted_declarations_due_idx" ON "form_submitted_declarations" ("next_at") WHERE "status" = 'pending';
