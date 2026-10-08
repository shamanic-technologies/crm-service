ALTER TABLE "people_message_texts" ADD COLUMN "item" jsonb;--> statement-breakpoint
ALTER TABLE "people_message_units" ADD COLUMN "format" integer DEFAULT 1 NOT NULL;