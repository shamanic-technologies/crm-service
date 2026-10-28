-- UNIBOX-FACT-LAG-1028: the fact emitter states each scope's facts within a minute of the record, not after a whole build.
ALTER TABLE "people_scopes" ADD COLUMN IF NOT EXISTS "facts_stated_through" timestamp with time zone;
--> statement-breakpoint
-- The emitter's change check (lib/people/fact-emitter.ts inputsMark): latest write per scope, index-only.
CREATE INDEX IF NOT EXISTS "contacts_org_brand_rebuilt_idx" ON "contacts" ("org_id", "brand_id", "last_rebuilt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posthog_activities_org_brand_rebuilt_idx" ON "posthog_activities" ("org_id", "brand_id", "last_rebuilt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_transactions_org_brand_rebuilt_idx" ON "stripe_transactions" ("org_id", "brand_id", "last_rebuilt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matrix_raw_events_org_brand_ingested_idx" ON "matrix_raw_events" ("org_id", "brand_id", "ingested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_message_texts_scope_at_idx" ON "people_message_texts" ("scope_id", "at");
