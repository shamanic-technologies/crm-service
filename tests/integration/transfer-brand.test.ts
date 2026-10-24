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
  await db.execute(sql`
    INSERT INTO contact_email_lookups (org_id, brand_id, source_row_id, contact_id, status, handed_out_run_id)
    VALUES (${org}, ${brand}, gen_random_uuid(), ${contact.id}, 'handed_out', 'run')`);

  const [mx] = await db.execute<{ id: string }>(sql`
    INSERT INTO matrix_connections (org_id, brand_id, channel, matrix_user_id, counterpart_prefix, created_by_user_id)
    VALUES (${org}, ${brand}, 'whatsapp', '@me:hs', '@whatsapp_', 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO matrix_links (org_id, brand_id, channel, created_by_user_id, matrix_user_id, status, method, connection_id)
    VALUES (${org}, ${brand}, 'whatsapp', 'user', '@me:hs', 'linked', 'qr', ${mx.id})`);
  await db.execute(sql`
    INSERT INTO matrix_raw_events (org_id, brand_id, connection_id, event_id, event_type, sender, room_id, origin_server_ts, payload)
    VALUES (${org}, ${brand}, ${mx.id}, ${"$ev-" + tag}, 'm.room.message', '@whatsapp_1:hs', '!r', now(), '{}')`);
  const [conv] = await db.execute<{ id: string }>(sql`
    INSERT INTO conversations (org_id, brand_id, connection_id, contact_id, channel, room_id, first_message_at, last_message_at, message_count, inbound_count, outbound_count, last_event_id)
    VALUES (${org}, ${brand}, ${mx.id}, ${contact.id}, 'whatsapp', '!r', now(), now(), 1, 1, 0, ${"$ev-" + tag}) RETURNING id`);
  await db.execute(sql`
    INSERT INTO matrix_leads (org_id, brand_id, conversation_id, contact_id, status, next_step, estimated_value_usd, summary, computed_through_event_id, model, run_id)
    VALUES (${org}, ${brand}, ${conv.id}, ${contact.id}, 'new', 'reply', 0, 's', ${"$ev-" + tag}, 'm', 'run')`);
  const [grp] = await db.execute<{ id: string }>(sql`
    INSERT INTO matrix_groups (org_id, brand_id, connection_id, channel, room_id, name, member_count, message_count)
    VALUES (${org}, ${brand}, ${mx.id}, 'whatsapp', ${"!g-" + tag}, 'Group', 1, 0) RETURNING id`);
  await db.execute(sql`
    INSERT INTO matrix_group_members (org_id, brand_id, group_id, room_id, contact_id, ghost_mxid, membership, authored_count)
    VALUES (${org}, ${brand}, ${grp.id}, ${"!g-" + tag}, ${contact.id}, '@whatsapp_lid-1:hs', 'join', 0)`);

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
  await db.execute(sql`
    INSERT INTO crm_label_verdicts (org_id, brand_id, connection_id, kind, label_ref, label, verdict, confidence, probabilities, model, run_id)
    VALUES (${org}, ${brand}, ${ghl.id}, 'tag', '', 'unqualified', 'disqualified', 1, '{}', 'jev', 'run')`);

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
  const [au] = await db.execute<{ id: string }>(sql`
    INSERT INTO auth_connections (org_id, brand_id, provider, created_by_user_id)
    VALUES (${org}, ${brand}, 'clerk', 'user') RETURNING id`);
  await db.execute(sql`
    INSERT INTO auth_raw_records (org_id, brand_id, connection_id, kind, external_id, content_hash, payload)
    VALUES (${org}, ${brand}, ${au.id}, 'user', 'user_1', 'h', '{}')`);
  await db.execute(sql`
    INSERT INTO people_facts (org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, natural_key)
    VALUES (${org}, ${brand}, 'email:a@b.co', '[]', '[]', 'payment', 'created', 'stripe', 'ch_1', '{}', 'stripe|payment|ch_1')`);
  await db.execute(sql`
    INSERT INTO person_ids (org_id, brand_id, identity_key, person_id)
    VALUES (${org}, ${brand}, 'email:a@b.co', gen_random_uuid())`);
  await db.execute(sql`
    INSERT INTO person_id_aliases (org_id, brand_id, retired_id, person_id)
    VALUES (${org}, ${brand}, gen_random_uuid(), gen_random_uuid())`);
  await db.execute(sql`
    INSERT INTO person_merges (org_id, brand_id, person_id_a, person_id_b, keys_a, keys_b, stated_by_user_id)
    VALUES (${org}, ${brand}, gen_random_uuid(), gen_random_uuid(), '["email:a@b.co"]', '["phone:+33600000000"]', 'user-1')`);
  await db.execute(sql`
    INSERT INTO people_corrections (org_id, brand_id, kind, person_keys, target, target_key, stated_by_user_id)
    VALUES (${org}, ${brand}, 'tag_add', '["email:a@b.co"]', '{"tag":"personal_to_user"}', 'tag_add:personal_to_user', 'user-1')`);
  await db.execute(sql`
    INSERT INTO contact_point_org_verdicts (org_id, brand_id, contact_point, choice, confidence, probabilities, options_hash, judged_through, criteria_version, input, model, run_id)
    VALUES (${org}, ${brand}, ${"gmail:a@" + tag}, 'unknown', 0.9, '{}', 'x', 'y', 1, '{}', 'jev', 'run-1')`);
  await db.execute(sql`
    INSERT INTO form_trigger_reports (org_id, brand_id, source, submission_id, answers, submitted_at, status)
    VALUES (${org}, ${brand}, 'gohighlevel', ${"sub-" + tag}, '[]', now(), 'reported')`);
  await db.execute(sql`
    INSERT INTO form_offer_mappings (org_id, brand_id, form_id, offer_id, stated_by_user_id)
    VALUES (${org}, ${brand}, '*', gen_random_uuid(), 'user-1')`);
  await db.execute(sql`
    INSERT INTO reply_trigger_reports (org_id, brand_id, source, channel, connection_id, room_id, anchor_event_id, campaign_id,
      messages, first_message_at, last_message_at, status)
    VALUES (${org}, ${brand}, 'matrix', 'whatsapp', gen_random_uuid(), '!room', ${"$ev-" + tag}, 'camp-1', '[]', now(), now(), 'reported')`);
  await db.execute(sql`
    INSERT INTO phone_given_reports (org_id, brand_id, phone, source, status)
    VALUES (${org}, ${brand}, ${"+4477009" + String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}, 'clerk', 'reported')`);
  await db.execute(sql`
    INSERT INTO phone_watch_artifacts (org_id, brand_id, artifact_id, source)
    VALUES (${org}, ${brand}, gen_random_uuid(), 'clerk')`);
  await db.execute(sql`
    INSERT INTO voice_note_transcripts (event_id, org_id, brand_id, connection_id, room_id, status, text)
    VALUES (${"$voice-" + tag + "-" + Math.random().toString(16).slice(2)}, ${org}, ${brand}, gen_random_uuid(), '!room', 'completed', 'hello')`);
  await db.execute(sql`
    INSERT INTO calendar_attendee_matches (org_id, brand_id, attendee_email, input_hash, person_id, basis, candidates)
    VALUES (${org}, ${brand}, ${"att-" + tag + "@x.co"}, ${"h-" + Math.random().toString(16).slice(2)}, NULL, 'no_candidate', '[]')`);
  await db.execute(sql`
    INSERT INTO calendar_attendance_verdicts (org_id, brand_id, google_event_id, person_id, input_hash, participant_index, confidence, probabilities, model, run_id)
    VALUES (${org}, ${brand}, ${"g-" + tag}, gen_random_uuid()::text, ${"h-" + Math.random().toString(16).slice(2)}, NULL, 0.9, '{}', 'jev', 'run-1')`);
  await db.execute(sql`
    INSERT INTO same_person_verdicts (org_id, brand_id, key_a, key_b, name, keys_a, keys_b, input_hash, verdict, probability_same, model, run_id)
    VALUES (${org}, ${brand}, ${"email:a-" + tag + "-" + Math.random().toString(16).slice(2) + "@x.co"}, 'email:b@x.co', 'ann bee', '[]', '[]', 'h', 'same', 0.9, 'jev', 'run-1')`);
  await db.execute(sql`
    INSERT INTO conversation_verdicts (org_id, brand_id, conversation_key, source, topic, confidence, probabilities,
      brand_probability, offer_scores, offer_ids, context_hash, judged_through, input, model, run_id)
    VALUES (${org}, ${brand}, 'gmail:a@b.co', 'gmail', 'this_brand', 0.9, '{}', 0.9, '{}', '[]', 'h', 'm', '{}', 'jev', 'run-1')`);
  await db.execute(sql`
    INSERT INTO copilot_messages (org_id, brand_id, chat_org_id, chat_user_id, email, session_id, message_id, role, text, sent_at)
    VALUES (${org}, ${brand}, gen_random_uuid(), gen_random_uuid(), 'a@b.co', 's1', gen_random_uuid()::text, 'user', 'hi', now())`);
  await db.execute(sql`
    INSERT INTO api_calls (org_id, brand_id, call_id, channel, caller_user_id, email, method, path, status, duration_ms, called_at)
    VALUES (${org}, ${brand}, gen_random_uuid()::text, 'api', gen_random_uuid(), 'a@b.co', 'GET', '/v1/me', 200, 5, now())`);
  await db.execute(sql`
    INSERT INTO human_link_statements (org_id, brand_id, kind, ref, human_ids, stated_org_id)
    VALUES (${org}, ${brand}, 'stated_merge', gen_random_uuid()::text, '[]', ${org})`);
  await db.execute(sql`
    INSERT INTO human_fact_statements (org_id, brand_id, subject, kind, human_id, fact_id)
    VALUES (${org}, ${brand}, 'csv:' || gen_random_uuid()::text, 'opt_out', gen_random_uuid(), gen_random_uuid())`);
  await db.execute(sql`
    INSERT INTO whatsapp_line_spans (org_id, brand_id, phone, state, started_at, last_seen_at, source)
    VALUES (${org}, ${brand}, '+33600000009', 'connected', now(), now(), 'watch')`);
  await db.execute(sql`
    INSERT INTO whatsapp_line_days (org_id, brand_id, phone, day, status, connected_minutes, reconnecting_minutes, down_minutes, unknown_minutes, recovered_on_its_own)
    VALUES (${org}, ${brand}, '+33600000009', '2026-10-23', 'ok', 60, 0, 0, 0, 0)`);
  await db.execute(sql`
    INSERT INTO lead_identified_declarations (org_id, brand_id, conversation_key, relation_key, run_id, judged_at, status)
    VALUES (${org}, ${brand}, 'gmail:' || gen_random_uuid()::text, 'rel:' || gen_random_uuid()::text || ':pro', gen_random_uuid()::text, now(), 'declared')`);
  await db.execute(sql`
    INSERT INTO message_sent_declarations (org_id, brand_id, run_id, send_id, campaign_id, sent_at, status)
    VALUES (${org}, ${brand}, gen_random_uuid()::text, gen_random_uuid(), gen_random_uuid()::text, now(), 'declared')`);
  await db.execute(sql`
    INSERT INTO whatsapp_sends (org_id, brand_id, idempotency_key, email, phone, text, status)
    VALUES (${org}, ${brand}, gen_random_uuid()::text, 'a@b.co', '+33600000001', 'hi', 'sent')`);
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

