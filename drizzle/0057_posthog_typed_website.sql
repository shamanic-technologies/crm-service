-- WA-THREAD-IDENTITY-1023: the website a PostHog person typed on the brand's form lived in raw_attributes only,
-- so it named no company (people/organizations.ts reads the canonical `website` column). New derivations write
-- `website` + `company_domain`; this carries the rows derived before. Idempotent (only rows still empty).
UPDATE "contacts"
SET "website" = trim("raw_attributes"->>'website')
WHERE "source" = 'posthog'
  AND "website" IS NULL
  AND nullif(trim("raw_attributes"->>'website'), '') IS NOT NULL;
--> statement-breakpoint
UPDATE "contacts"
SET "company_domain" = d.domain
FROM (
  SELECT "id",
         regexp_replace(
           regexp_replace(
             regexp_replace(lower(trim("website")), '^[a-z][a-z0-9+.-]*://', ''),
             '[/?#:].*$', ''),
           '^www\.', '') AS domain
  FROM "contacts"
  WHERE "source" = 'posthog' AND "website" IS NOT NULL AND "company_domain" IS NULL
) d
WHERE "contacts"."id" = d."id" AND d.domain LIKE '%.%';
