CREATE TABLE IF NOT EXISTS "voice_note_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"room_id" text NOT NULL,
	"status" text NOT NULL,
	"text" text,
	"languages" jsonb,
	"model" text,
	"error_code" text,
	"error" text,
	"size_bytes" integer,
	"duration_ms" integer,
	"run_id" text,
	"chat_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_note_transcripts_event_uq" ON "voice_note_transcripts" USING btree ("event_id");
