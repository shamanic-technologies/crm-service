-- SOPHIE-SENDS-1028: the role the brand states for a linked account. `assistant` = every automated send writes
-- from it (even where another linked line already talks with the person); `founder` = only a send asking
-- `fromLine: "founder"` writes from it. At most one account per role per (org, brand, channel). null = no role.
ALTER TABLE "matrix_links" ADD COLUMN IF NOT EXISTS "line_role" text;
CREATE UNIQUE INDEX IF NOT EXISTS "matrix_links_line_role_uq" ON "matrix_links" ("org_id", "brand_id", "channel", "line_role") WHERE "line_role" IS NOT NULL;
