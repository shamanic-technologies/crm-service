-- CRM-WARM-NURTURE-1015: what each CRM label (stage, tag) says about the person: client | disqualified | none, judged once by Jev.
CREATE TABLE IF NOT EXISTS "crm_label_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "ghl_connections"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "label_ref" text NOT NULL,
  "label" text NOT NULL,
  "pipeline_name" text,
  "verdict" text NOT NULL,
  "confidence" double precision NOT NULL,
  "probabilities" jsonb NOT NULL,
  "model" text NOT NULL,
  "run_id" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_label_verdicts_conn_label_uq" ON "crm_label_verdicts" USING btree ("connection_id","kind","label_ref","label");
CREATE INDEX IF NOT EXISTS "crm_label_verdicts_org_brand_idx" ON "crm_label_verdicts" USING btree ("org_id","brand_id");
