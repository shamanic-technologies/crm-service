-- EMAIL-REPLY-ORPHAN-1027: what the email path (instantly-service POST /orgs/reply-ownership) answered for a Gmail
-- burst: { askedAt, owner: email_path | none, messages: [{ messageId, owner, reason }] }. null = never asked (a
-- legacy `cold_email_path` skip decided on the recipient alone).
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "email_path_answer" jsonb;
