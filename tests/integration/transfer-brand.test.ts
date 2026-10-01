import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../../src/db/index.js";
import { TRANSFER_TABLES, transferBrand } from "../../src/lib/transfer-brand.js";

/**
 * DB-backed transfer tests. Gated on CRM_TEST_DB (CI uses a mock DB URL):
 *   CRM_SERVICE_DATABASE_URL=<db> CRM_TEST_DB=1 npx vitest run tests/integration/transfer-brand.test.ts
 */
const RUN = !!process.env.CRM_TEST_DB;

const SRC_ORG = "cccccccc-1111-4111-8111-000000000001";
const DST_ORG = "cccccccc-1111-4111-8111-000000000002";
const BRAND = "cccccccc-1111-4111-8111-000000000003";
const OTHER_BRAND = "cccccccc-1111-4111-8111-000000000004";
const NEW_BRAND = "cccccccc-1111-4111-8111-000000000005";
const TABLES = TRANSFER_TABLES.map((t) => getTableConfig(t).name);

/** One row in every brand-scoped table, all wired together by id. */
async function seedBrand(org: string, brand: string, tag: string) {
  const [upload] = await db.execute<{ id: string }>(sql`
    INSERT INTO contact_uploads (org_id, brand_id, filename, content_hash, column_headers, run_id)
    VALUES (${org}, ${brand}, 'crm.csv', ${"hash-" + tag}, '["email"]', 'run') RETURNING id`);
  await db.execute(sql`
    INSERT INTO contact_rows_raw (org_id, brand_id, upload_id, row_number, payload)
    VALUES (${org}, ${brand}, ${upload.id}, 1, '{"email":"a@x.com"}')`);
  const [contact] = await db.execute<{ id: string }>(sql`
    INSERT INTO contacts (org_id, brand_id, primary_email, raw_attributes, source_upload_id)
    VALUES (${org}, ${brand}, ${tag + "@x.com"}, '{}', ${upload.id}) RETURNING id`);
  await db.execute(sql`
    INSERT INTO contact_serves (org_id, brand_id, contact_id, email, served_run_id)
    VALUES (${org}, ${brand}, ${contact.id}, ${tag + "@x.com"}, 'run')`);

  const [mx] = await db.execute<{ id: string }>(sql`
    INSERT INTO matrix_connections (org_id, brand_id, channel, matrix_user_id, counterpart_prefix, created_by_user_id)
    VALUES (${org}, ${brand}, 'whatsapp', '@me:hs', '@whatsapp_', 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO matrix_raw_events (org_id, brand_id, connection_id, event_id, event_type, sender, room_id, origin_server_ts, payload)
    VALUES (${org}, ${brand}, ${mx.id}, ${"$ev-" + tag}, 'm.room.message', '@whatsapp_1:hs', '!r', now(), '{}')`);
  const [conv] = await db.execute<{ id: string }>(sql`
    INSERT INTO conversations (org_id, brand_id, connection_id, contact_id, channel, room_id, first_message_at, last_message_at, message_count, inbound_count, outbound_count, last_event_id)
    VALUES (${org}, ${brand}, ${mx.id}, ${contact.id}, 'whatsapp', '!r', now(), now(), 1, 1, 0, ${"$ev-" + tag}) RETURNING id`);
  await db.execute(sql`
    INSERT INTO matrix_leads (org_id, brand_id, conversation_id, contact_id, status, next_step, estimated_value_usd, summary, computed_through_event_id, model, run_id)
    VALUES (${org}, ${brand}, ${conv.id}, ${contact.id}, 'new', 'reply', 0, 's', ${"$ev-" + tag}, 'm', 'run')`);

  const [ghl] = await db.execute<{ id: string }>(sql`
    INSERT INTO ghl_connections (org_id, brand_id, location_id, created_by_user_id)
    VALUES (${org}, ${brand}, 'loc', 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO ghl_raw_records (org_id, brand_id, connection_id, kind, external_id, content_hash, payload)
    VALUES (${org}, ${brand}, ${ghl.id}, 'contact', 'c1', 'h', '{}')`);
  await db.execute(sql`
    INSERT INTO ghl_pipelines (org_id, brand_id, connection_id, external_id, name, stages)
    VALUES (${org}, ${brand}, ${ghl.id}, 'p1', 'Sales', '[]')`);
  await db.execute(sql`
    INSERT INTO ghl_opportunities (org_id, brand_id, connection_id, external_id, name, contact_id)
    VALUES (${org}, ${brand}, ${ghl.id}, 'o1', 'Deal', ${contact.id})`);
  await db.execute(sql`
    INSERT INTO ghl_appointments (org_id, brand_id, connection_id, external_id, contact_id)
    VALUES (${org}, ${brand}, ${ghl.id}, 'a1', ${contact.id})`);
  await db.execute(sql`
    INSERT INTO ghl_form_submissions (org_id, brand_id, connection_id, external_id, contact_id)
    VALUES (${org}, ${brand}, ${ghl.id}, 'f1', ${contact.id})`);
  await db.execute(sql`
    INSERT INTO ghl_opportunity_history (org_id, brand_id, connection_id, opportunity_external_id, kind)
    VALUES (${org}, ${brand}, ${ghl.id}, 'o1', 'stage')`);
  await db.execute(sql`
    INSERT INTO ghl_stage_meanings (org_id, brand_id, connection_id, stage_external_id, stage_name, meaning, confidence, probabilities, model, run_id)
    VALUES (${org}, ${brand}, ${ghl.id}, 's1', 'Booked', 'meeting_booked', 1, '{}', 'jev', 'run')`);

  const [scope] = await db.execute<{ id: string }>(sql`
    INSERT INTO people_scopes (org_id, brand_id, created_by_user_id)
    VALUES (${org}, ${brand}, 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO people (scope_id, org_id, brand_id, person_key, identity_keys, emails, phones, sources, presences, merge_evidence, state, state_source)
    VALUES (${scope.id}, ${org}, ${brand}, ${"email:" + tag + "@x.com"}, '[]', '[]', '[]', '[]', '[]', '[]', 'in_conversation', 'none')`);
  await db.execute(sql`
    INSERT INTO lead_standing_observations (org_id, brand_id, email, found)
    VALUES (${org}, ${brand}, ${tag + "@x.com"}, false)`);

  const [ph] = await db.execute<{ id: string }>(sql`
    INSERT INTO posthog_connections (org_id, brand_id, project_id, region, created_by_user_id)
    VALUES (${org}, ${brand}, '1', 'eu', 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO posthog_raw_records (org_id, brand_id, connection_id, kind, external_id, content_hash, payload)
    VALUES (${org}, ${brand}, ${ph.id}, 'person', 'p1', 'h', '{}')`);
  await db.execute(sql`
    INSERT INTO posthog_activities (org_id, brand_id, connection_id, kind, external_id, external_person_id, contact_id, occurred_at, name, detail)
    VALUES (${org}, ${brand}, ${ph.id}, 'event', 'e1', 'p1', ${contact.id}, now(), 'signup', '{}')`);
  const [st] = await db.execute<{ id: string }>(sql`
    INSERT INTO stripe_connections (org_id, brand_id, key_mode, created_by_user_id)
    VALUES (${org}, ${brand}, 'live', 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO stripe_raw_records (org_id, brand_id, connection_id, kind, external_id, content_hash, payload)
    VALUES (${org}, ${brand}, ${st.id}, 'charge', 'ch_1', 'h', '{}')`);
  await db.execute(sql`
    INSERT INTO stripe_transactions (org_id, brand_id, connection_id, kind, external_id, contact_id, occurred_at, amount_minor, currency, status, detail)
    VALUES (${org}, ${brand}, ${st.id}, 'payment', 'ch_1', ${contact.id}, now(), 9900, 'usd', 'succeeded', '{}')`);
}

/** Rows per table for (org, brand). */
async function counts(org: string, brand: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const [r] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND brand_id = ${brand}`,
    );
    out[t] = r.n;
  }
  return out;
}

const ones = () => Object.fromEntries(TABLES.map((t) => [t, 1]));
const zeros = () => Object.fromEntries(TABLES.map((t) => [t, 0]));

describe.skipIf(!RUN)("transferBrand (real DB)", () => {
  beforeEach(async () => {
    for (const t of [...TABLES].reverse()) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id IN (${SRC_ORG}, ${DST_ORG})`);
    }
    await seedBrand(SRC_ORG, BRAND, "moved");
    await seedBrand(SRC_ORG, OTHER_BRAND, "stays");
  }, 30_000);

  it("moves every table of the brand, leaves the source empty, and leaves other brands alone", async () => {
    const result = await transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
    expect(result.map((r) => r.tableName).sort()).toEqual([...TABLES].sort());
    expect(Object.fromEntries(result.map((r) => [r.tableName, r.count]))).toEqual(ones());

    expect(await counts(SRC_ORG, BRAND)).toEqual(zeros());
    expect(await counts(DST_ORG, BRAND)).toEqual(ones());
    expect(await counts(SRC_ORG, OTHER_BRAND)).toEqual(ones());

    // Id-wired graph survives: the moved lead still joins its conversation and contact.
    const [joined] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM matrix_leads l
      JOIN conversations c ON c.id = l.conversation_id
      JOIN contacts k ON k.id = l.contact_id
      WHERE l.org_id = ${DST_ORG} AND c.org_id = ${DST_ORG} AND k.org_id = ${DST_ORG}`);
    expect(joined.n).toBe(1);
  });

  it("re-running is a no-op", async () => {
    const input = { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG };
    await transferBrand(input);
    const again = await transferBrand(input);
    expect(again.every((r) => r.count === 0)).toBe(true);
    expect(await counts(DST_ORG, BRAND)).toEqual(ones());
  });

  it("rewrites the brand id when targetBrandId is given, idempotently, and finishes a half-move", async () => {
    // Half-move: an earlier call without targetBrandId.
    await transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
    const input = { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG, targetBrandId: NEW_BRAND };
    const first = await transferBrand(input);
    expect(first.every((r) => r.count === 1)).toBe(true);
    expect(await counts(DST_ORG, NEW_BRAND)).toEqual(ones());
    expect(await counts(DST_ORG, BRAND)).toEqual(zeros());
    const again = await transferBrand(input);
    expect(again.every((r) => r.count === 0)).toBe(true);
  });

  it("is all-or-nothing: a conflict in the target rolls the whole move back", async () => {
    // Target already has its own CRM for the brand → the ghl_connections (org, brand) key collides.
    await seedBrand(DST_ORG, BRAND, "clash");
    await expect(
      transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG }),
    ).rejects.toThrow();
    expect(await counts(SRC_ORG, BRAND)).toEqual(ones());
  });
});

