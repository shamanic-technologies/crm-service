-- CLIENT-SATISFIED-1107 follow-up: a message counts as positive only at P(positive) >= 0.75 (plain politeness sat at
-- 0.53-0.70 on the first backfill). Verdicts recorded positive under the old 0.5 bar take the likelier of neutral / negative.
UPDATE "client_message_verdicts"
SET "verdict" = CASE WHEN COALESCE(("probabilities"->>'negative')::double precision, 0) > COALESCE(("probabilities"->>'neutral')::double precision, 0)
                     THEN 'negative' ELSE 'neutral' END
WHERE "verdict" = 'positive' AND "p_positive" < 0.75;
