ALTER TABLE "matrix_links" ADD COLUMN IF NOT EXISTS "automation_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "matrix_links" ADD COLUMN IF NOT EXISTS "persona_name" text;--> statement-breakpoint
ALTER TABLE "matrix_links" ADD COLUMN IF NOT EXISTS "persona_role" text;--> statement-breakpoint
ALTER TABLE "matrix_links" ADD COLUMN IF NOT EXISTS "persona_instructions" text;
