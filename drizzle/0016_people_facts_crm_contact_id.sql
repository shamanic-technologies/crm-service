ALTER TABLE "people_facts" ADD COLUMN "crm_contact_id" uuid;--> statement-breakpoint
-- Backfill the facts already emitted: crm-service's own contact row for the
-- fact's vendor contact id (served bookkeeping-free: no new fact, no seq change).
UPDATE "people_facts" f SET "crm_contact_id" = c.id
FROM "contacts" c
WHERE f.crm_contact_id IS NULL AND f.type <> 'withdrawn'
  AND c.org_id = f.org_id AND c.brand_id = f.brand_id
  AND f.source IN ('gohighlevel', 'posthog', 'stripe')
  AND c.source = f.source AND c.external_id = f.source_contact_id;--> statement-breakpoint
UPDATE "people_facts" f SET "crm_contact_id" = c.id
FROM "contacts" c
WHERE f.crm_contact_id IS NULL AND f.type <> 'withdrawn' AND f.source = 'matrix'
  AND c.org_id = f.org_id AND c.brand_id = f.brand_id
  AND c.source = 'matrix' AND c.channel_handle = f.source_contact_id;--> statement-breakpoint
UPDATE "people_facts" f SET "crm_contact_id" = c.id
FROM "contacts" c
WHERE f.crm_contact_id IS NULL AND f.type = 'added_to_crm' AND f.source = 'csv'
  AND c.org_id = f.org_id AND c.brand_id = f.brand_id
  AND c.source = 'csv' AND lower(c.primary_email) = f.source_ref;--> statement-breakpoint
UPDATE "people_facts" w SET "crm_contact_id" = o.crm_contact_id
FROM "people_facts" o
WHERE w.type = 'withdrawn' AND w.crm_contact_id IS NULL AND o.fact_id = w.withdrawn_of;
