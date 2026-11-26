-- MODEL-TAG-EVERY-AI-MESSAGE-1126. The run that asked us to send a WhatsApp message (`x-run-id` as the request arrived),
-- stated on the message's `message_out` fact. No backfill: rows sent before carry NULL (no run is guessed).
ALTER TABLE "whatsapp_sends" ADD COLUMN IF NOT EXISTS "caller_run_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_sends_event_idx" ON "whatsapp_sends" ("event_id");
