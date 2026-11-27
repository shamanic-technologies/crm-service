-- LEAD-REPLY-CHANNEL-1127. The bridged app an automated send went out on: the conversation send writes into a person's
-- conversation on any app (Telegram, LinkedIn...), recorded in the same table so every reader of our own sends sees it.
-- Every existing row is a WhatsApp send.
ALTER TABLE "whatsapp_sends" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;
