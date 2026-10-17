ALTER TABLE "crm_label_verdicts" ADD COLUMN IF NOT EXISTS "criteria_version" integer DEFAULT 1 NOT NULL;
