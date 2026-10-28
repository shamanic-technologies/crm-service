-- ACCOUNT-TYPES-1028: every linked account carries ONE type the brand picks: pro_human | personal_human | pro_ai
-- (lib/matrix/account-types.ts). No cap per type. The SOPHIE-SENDS-1028 roles carry over: assistant = pro_ai,
-- founder = pro_human. `line_role` is no longer read or written (kept for a rolled-back deploy).
ALTER TABLE "matrix_links" ADD COLUMN IF NOT EXISTS "account_type" text;
--> statement-breakpoint
UPDATE "matrix_links" SET "account_type" = CASE "line_role" WHEN 'assistant' THEN 'pro_ai' WHEN 'founder' THEN 'pro_human' END WHERE "line_role" IS NOT NULL AND "account_type" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "matrix_links_line_role_uq";
