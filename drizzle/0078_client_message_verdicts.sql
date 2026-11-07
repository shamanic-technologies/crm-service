-- CLIENT-SATISFIED-1107: Jev's verdict on each message a paying client wrote the brand (outcome « Client Satisfied »).
CREATE TABLE IF NOT EXISTS "client_message_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"text_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"p_positive" double precision NOT NULL,
	"probabilities" jsonb,
	"model" text,
	"run_id" text,
	"source" text NOT NULL,
	"message_at" timestamp with time zone,
	"excerpt" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_message_verdicts_message_uq" ON "client_message_verdicts" ("org_id","brand_id","natural_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_message_verdicts_positive_idx" ON "client_message_verdicts" ("org_id","brand_id") WHERE "verdict" = 'positive';
