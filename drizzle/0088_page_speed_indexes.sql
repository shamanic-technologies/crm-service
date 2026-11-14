-- MON-PAGE-SPEED-1114: per-person fact index for timeline settlement, client-satisfaction, segment reads.
-- Before: a per-person filter on the 1M-row distribute.you brand scanned 283k rows (285 ms); this index
-- makes it a single probe.
CREATE INDEX IF NOT EXISTS "people_facts_live_owner_idx"
  ON "people_facts" ("org_id", "brand_id", "owner_person_key")
  WHERE "live";
