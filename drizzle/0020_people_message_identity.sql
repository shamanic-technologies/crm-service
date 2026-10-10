-- A cold email is ONE message however many campaign units read it: instantly-service answers a
-- campaign's whole family (campaign-service mints a row per workflow change), so two units of one
-- lead stored the same thread twice. Re-key every stored cold email on its own identity
-- (direction | at | from | to, the key search.ts instantlyMessageKey computes), keep one copy per
-- (scope, address, identity), recount the units, then forbid a second copy.
DELETE FROM "people_message_texts" t USING (
  SELECT id, row_number() OVER (
    PARTITION BY scope_id, address, coalesce(item->>'direction','') || '|' || coalesce(item->>'at','') || '|' || coalesce(item->>'from','') || '|' || coalesce(item->'to'->>0,'')
    ORDER BY indexed_at DESC, id
  ) AS rn
  FROM "people_message_texts"
  WHERE source = 'instantly' AND item IS NOT NULL
) d
WHERE t.id = d.id AND d.rn > 1;--> statement-breakpoint
UPDATE "people_message_texts" SET message_key = coalesce(item->>'direction','') || '|' || coalesce(item->>'at','') || '|' || coalesce(item->>'from','') || '|' || coalesce(item->'to'->>0,'')
WHERE source = 'instantly' AND item IS NOT NULL;--> statement-breakpoint
UPDATE "people_message_units" u SET messages = (
  SELECT count(*)::int FROM "people_message_texts" t
  WHERE t.scope_id = u.scope_id AND t.source = u.source AND t.unit = u.unit
)
WHERE u.source = 'instantly';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "people_message_texts_address_message_uq" ON "people_message_texts" USING btree ("scope_id","source","address","message_key");