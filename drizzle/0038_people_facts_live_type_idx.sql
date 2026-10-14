-- DASH-LATENCY-1014: the outcomes read (GET /orgs/people/outcomes) scanned every fact of
-- the brand (99,821 on distribute.you) to keep ~2,750 live step facts. Partial index on
-- exactly its predicate (live, owned), keyed by type.
CREATE INDEX IF NOT EXISTS "people_facts_live_type_idx" ON "people_facts" USING btree ("org_id","brand_id","type") WHERE "live" AND "owner_person_key" IS NOT NULL;
