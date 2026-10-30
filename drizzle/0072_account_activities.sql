-- CLIENT-ACTIVITY-1030: a client's actions on their account (campaign created / edited / paused / resumed, budget
-- changed...), reported by the service that performed them, on the staff Unibox thread + one owner Telegram each.
CREATE TABLE IF NOT EXISTS "account_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "producer" text NOT NULL,
  "activity_id" text NOT NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "subject" jsonb,
  "changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "via" text,
  "account_org_id" uuid NOT NULL,
  "account_brand_id" uuid,
  "actor_user_id" uuid,
  "actor_email" text,
  "actor_name" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "ping_status" text,
  "ping_text" text,
  "ping_error" text,
  "telegram_message_id" integer,
  "pinged_at" timestamp with time zone,
  "run_id" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_activities_producer_activity_uq" ON "account_activities" ("producer", "activity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_activities_filed_email_idx" ON "account_activities" ("actor_email", "occurred_at") WHERE "status" = 'filed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_activities_pending_idx" ON "account_activities" ("received_at") WHERE "status" = 'pending' OR ("status" = 'filed' AND "ping_status" IS NULL);
