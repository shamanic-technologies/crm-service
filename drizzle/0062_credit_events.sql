-- CREDIT-RAN-OUT-UNIBOX-EVENT-1024: billing-service's "credit ran out" / "credit restored" feed, mirrored (bronze,
-- insert-only), the members each event is about, and the Lead event report per member. New tables, additive.
CREATE TABLE IF NOT EXISTS "billing_feed_cursors" (
  "feed" text PRIMARY KEY NOT NULL,
  "cursor" text,
  "caught_up_at" timestamp with time zone,
  "watch_since" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "credit_org_id" uuid NOT NULL,
  "episode_id" uuid NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "org_label" text,
  "member_emails" jsonb,
  "members_resolved_at" timestamp with time zone,
  "members_error" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_events_unresolved_idx" ON "credit_events" USING btree ("at") WHERE "members_resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_events_members_idx" ON "credit_events" USING gin ("member_emails");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_event_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" text NOT NULL,
  "email" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_error" text,
  "offer_ids" jsonb,
  "campaign_events" jsonb,
  "run_id" text,
  "reported_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_event_reports_event_email_uq" ON "credit_event_reports" USING btree ("event_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_event_reports_due_idx" ON "credit_event_reports" USING btree ("created_at") WHERE "status" IN ('pending', 'failed');
