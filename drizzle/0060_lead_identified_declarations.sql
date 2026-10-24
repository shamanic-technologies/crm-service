-- COST-ACCOUNTING-1024: crm-service produces `lead_identified` (its Jev tagging a conversation professional_to_brand),
-- declared at runs-service on the run that judged it. New table, additive.
CREATE TABLE IF NOT EXISTS "lead_identified_declarations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "conversation_key" text NOT NULL,
  "relation_key" text NOT NULL,
  "run_id" text NOT NULL,
  "judged_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_at" timestamp with time zone,
  "declared_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_identified_declarations_conversation_uq" ON "lead_identified_declarations" USING btree ("org_id","brand_id","conversation_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_identified_declarations_relation_idx" ON "lead_identified_declarations" USING btree ("org_id","brand_id","relation_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_identified_declarations_due_idx" ON "lead_identified_declarations" USING btree ("next_at") WHERE "status" = 'pending';
