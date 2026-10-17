ALTER TABLE "conversation_verdicts" ADD COLUMN IF NOT EXISTS "tag_scores" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ADD COLUMN IF NOT EXISTS "tags" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_verdicts" ADD COLUMN IF NOT EXISTS "account_user_ids" jsonb;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "connection_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
