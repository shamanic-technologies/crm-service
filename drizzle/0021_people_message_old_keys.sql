-- A deploy of 0020 rolled back for a minute and the OLD code re-wrote one unit with per-unit keys
-- ("<position>:<at>:<direction>"), which the address-level unique index cannot see as twins.
-- Drop every cold-email row still under such a key and make its unit re-read; stamp every other
-- unit with store format 4 (keyed on the message's own identity), so a unit an older build writes
-- again (format 3) is re-read and re-keyed by the next pass.
UPDATE "people_message_units" u SET format = 0
WHERE u.source = 'instantly' AND EXISTS (
  SELECT 1 FROM "people_message_texts" t
  WHERE t.scope_id = u.scope_id AND t.source = u.source AND t.unit = u.unit AND position('|' in t.message_key) = 0
);--> statement-breakpoint
DELETE FROM "people_message_texts" WHERE source = 'instantly' AND position('|' in message_key) = 0;--> statement-breakpoint
UPDATE "people_message_units" SET format = 4 WHERE format = 3;
