-- Silver dedup natural key: (org_id, brand_id, lower(primary_email)).
-- Expression index — drizzle-kit does not emit expression indexes, so hand-written.
-- Null emails are treated as distinct by Postgres, so email-less contacts are
-- never collapsed together.
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_org_brand_lower_email_uq"
  ON "contacts" USING btree ("org_id", "brand_id", lower("primary_email"));
--> statement-breakpoint
-- Gold: sendable contacts — valid email, not unsubscribed, consent not denied.
CREATE OR REPLACE VIEW "sendable_contacts" AS
SELECT *
FROM "contacts"
WHERE "primary_email" IS NOT NULL
  AND "primary_email" ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  AND "unsubscribed" = false
  AND "consent_status" <> 'denied';
