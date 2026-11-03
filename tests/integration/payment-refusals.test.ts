import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { paymentRefusalReports } from "../../src/db/schema.js";
import { runRefusalWatchPass } from "../../src/lib/payment-refusals/watch.js";

/**
 * A refused charge on a brand's Stripe = ONE Lead event for the payer (REFUSED-CARD-LEAD-EVENT-1103), against a real
 * Postgres (gated on CRM_TEST_DB). brand / campaign / runs services are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "d3c1f0aa-1111-4111-8111-000000000001";
const BRAND = "d3c1f0aa-1111-4111-8111-000000000002";
const OFFER = "d3c1f0aa-1111-4111-8111-000000000003";

process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "br";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "ca";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let doorCalls: Record<string, unknown>[] = [];

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs")) return json({ id: "run-" + Math.random().toString(16).slice(2) });
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${BRAND}/offers`) {
      return json({ offers: [{ offerId: OFFER, name: "Done for you", status: "active" }] });
    }
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      doorCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ event: { id: `ev-${doorCalls.length}`, status: "fired" }, replayed: false });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function wipe() {
  await db.execute(sql`DELETE FROM payment_refusal_reports WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM stripe_transactions WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM stripe_connections WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM contacts WHERE brand_id = ${BRAND}`);
}

const NOW = Date.parse("2026-11-03T16:00:00Z");
const H = 60 * 60 * 1000;

async function seed() {
  const [conn] = (await db.execute(sql`
    INSERT INTO stripe_connections (org_id, brand_id, key_mode, created_by_user_id, created_at)
    VALUES (${ORG}, ${BRAND}, 'live', 'user-refusals', ${new Date(NOW - 30 * 24 * H).toISOString()}::timestamptz) RETURNING id`)) as unknown as { id: string }[];
  const contact = async (ext: string, email: string, name: string) =>
    ((await db.execute(sql`
      INSERT INTO contacts (org_id, brand_id, source, external_id, primary_email, full_name, raw_attributes)
      VALUES (${ORG}, ${BRAND}, 'stripe', ${ext}, ${email}, ${name}, '{}'::jsonb) RETURNING id`)) as unknown as { id: string }[])[0].id;
  const payer = await contact("cus_payer", "Chaim@BeyondLogic.tech", "Chaim Tesser");
  const staff = await contact("cus_staff", "kevin@distribute.you", "Kevin");
  const charge = (id: string, contactId: string, hoursAgo: number, status: string, amount = 5000) =>
    db.execute(sql`
      INSERT INTO stripe_transactions (org_id, brand_id, connection_id, kind, external_id, contact_id, occurred_at, amount_minor, currency, status, description, detail)
      VALUES (${ORG}, ${BRAND}, ${conn.id}, 'payment', ${id}, ${contactId}, ${new Date(NOW - hoursAgo * H).toISOString()}::timestamptz,
        ${amount}, 'usd', ${status}, 'Top-up', ${JSON.stringify({ failureMessage: "Your card has insufficient funds." })}::jsonb)`);
  await charge("ch_refused_1", payer, 2, "failed", 5002);
  await charge("ch_refused_2", payer, 1, "failed", 5263);
  await charge("ch_paid", payer, 1, "succeeded");
  await charge("ch_old", payer, 48, "failed");
  await charge("ch_staff", staff, 1, "failed");
}

describe.skipIf(!RUN)("refused Stripe charge = Lead event", () => {
  beforeEach(async () => {
    installFetchStub();
    doorCalls = [];
    await wipe();
  });
  afterAll(wipe);

  it("one Lead event for the payer's latest fresh refusal; succeeded, old and staff charges none; a re-read reports nothing twice", async () => {
    await seed();
    const first = await runRefusalWatchPass(NOW);
    expect(first.detected).toEqual({ recorded: 3, pending: 2 });

    const rows = await db.select().from(paymentRefusalReports).where(sql`brand_id = ${BRAND}`);
    const by = new Map(rows.map((r) => [r.chargeId, r]));
    expect([...by.keys()].sort()).toEqual(["ch_refused_1", "ch_refused_2", "ch_staff"]);
    expect(by.get("ch_staff")).toMatchObject({ status: "skipped", reason: "staff" });
    expect(by.get("ch_refused_1")).toMatchObject({ status: "skipped", reason: "superseded" });
    expect(by.get("ch_refused_2")).toMatchObject({ status: "reported", email: "chaim@beyondlogic.tech", offerIds: [OFFER] });

    expect(doorCalls).toHaveLength(1);
    expect(doorCalls[0]).toMatchObject({
      triggerId: "account_event",
      brandId: BRAND,
      offerId: OFFER,
      person: { email: "chaim@beyondlogic.tech", name: "Chaim Tesser" },
      item: { kind: "payment_refused", chargeId: "ch_refused_2", amount: "$52.63", text: "Payment refused: $52.63 · Your card has insufficient funds. · Top-up" },
    });

    const second = await runRefusalWatchPass(NOW + 60_000);
    expect(second.detected).toEqual({ recorded: 0, pending: 0 });
    expect(second.delivered).toEqual([]);
    expect(doorCalls).toHaveLength(1);
  });

  it("a new refusal after a reported one is its own Lead event", async () => {
    await seed();
    await runRefusalWatchPass(NOW);
    await db.execute(sql`
      INSERT INTO stripe_transactions (org_id, brand_id, connection_id, kind, external_id, contact_id, occurred_at, amount_minor, currency, status, detail)
      SELECT org_id, brand_id, connection_id, 'payment', 'ch_refused_3', contact_id, ${new Date(NOW + 30 * 60_000).toISOString()}::timestamptz, 5490, 'usd', 'failed', '{}'::jsonb
      FROM stripe_transactions WHERE brand_id = ${BRAND} AND external_id = 'ch_refused_2'`);
    const next = await runRefusalWatchPass(NOW + 31 * 60_000);
    expect(next.detected).toEqual({ recorded: 1, pending: 1 });
    expect(doorCalls.map((c) => (c.item as { chargeId: string }).chargeId)).toEqual(["ch_refused_2", "ch_refused_3"]);
  });
});
