CREATE TABLE IF NOT EXISTS "sender_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"verdict" text NOT NULL,
	"confidence" double precision NOT NULL,
	"probabilities" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"model" text NOT NULL,
	"run_id" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "automated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "automated_verdict" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sender_verdicts_org_email_uq" ON "sender_verdicts" USING btree ("org_id","email");