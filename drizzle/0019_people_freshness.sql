ALTER TABLE "people_message_units" ADD COLUMN "changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people_message_units" ADD COLUMN "change_mark" text;--> statement-breakpoint
ALTER TABLE "people_scopes" ADD COLUMN "outreach_facts_cursor" text;