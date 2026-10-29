-- ONE-AI-CONVERSES-1029: the Copilot hand-off is retired; every burst is a Lead event occurrence.
-- A hand-off still waiting (pending, or failed and inside its 24 h retry window) becomes a report to deliver
-- as a Lead event; an older one is closed (it was already past every retry).
UPDATE "reply_trigger_reports" SET "status" = 'pending', "reason" = NULL, "attempts" = 0, "last_attempt_at" = NULL, "last_error" = NULL
WHERE "status" IN ('handoff_pending', 'handoff_failed') AND "first_message_at" > now() - interval '24 hours';--> statement-breakpoint
UPDATE "reply_trigger_reports" SET "status" = 'skipped', "reason" = 'copilot_retired'
WHERE "status" IN ('handoff_pending', 'handoff_failed');
