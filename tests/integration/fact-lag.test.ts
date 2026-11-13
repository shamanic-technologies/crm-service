import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { factEmitterPass, inputsMark } from "../../src/lib/people/fact-emitter.js";
import { recordsNoPersonHolds } from "../../src/lib/people/facts.js";
import { runStripeSyncPass } from "../../src/lib/stripe/sync.js";
import peopleRoutes from "../../src/routes/people.js";
import posthogStripeRoutes from "../../src/routes/posthog-stripe.js";
import { noLeadsByAddress } from "../helpers/lead-by-address.js";

/**
 * UNIBOX-FACT-LAG-1028 (prod 2026-10-28, tari@slipless.ng): a person already known to the brand pays at
 * checkout with a card that is refused. Stripe creates a NEW customer for that checkout. The refused
 * charge must reach the fact feed and the timeline within the minute, without waiting for a people
 * build to join the new customer, and a writer reading the thread before that must be told.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "fa9fa9fa-1111-4111-8111-000000000001";
const BRAND = "fa9fa9fa-1111-4111-8111-000000000002";
const USER = "user-fact-lag";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

process.env.KEY_SERVICE_URL = "http://keys.test";
process.env.KEY_SERVICE_API_KEY = "k";
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let stripe: Record<string, Record<string, unknown>[]> = {};
let platformRunsOpened = 0;

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "lead.test" && url.pathname.endsWith("/leads/by-address")) return noLeadsByAddress(init);
    if (url.pathname === "/v1/platform-runs" && init?.method === "POST") platformRunsOpened++;
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") return json({ key: "rk_live_lag", provider: "stripe", keySource: "org" });
    if (url.host === "api.stripe.com") {
      const resource = url.pathname.replace("/v1/", "");
      if (resource === "account") return json({ id: "acct_LAG", settings: { dashboard: { display_name: "Lag" } } });
      return json({ object: "list", data: stripe[resource] ?? [], has_more: false });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [] });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads/unibox") return json({ rows: [], nextCursor: null });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads") return json({ leads: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(posthogStripeRoutes);
  a.use(peopleRoutes);
  return a;
}

const asOrg = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
const timeline = () =>
  asOrg(request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:tari@x.com")}`));

async function wipe() {
  await db.execute(sql`DELETE FROM people_facts WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM stripe_connections WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
}

const paymentFacts = async () =>
  (await db.execute(sql`
    SELECT source_ref, payload->>'status' AS status, person_key FROM people_facts
    WHERE org_id = ${ORG} AND type = 'payment' AND live ORDER BY source_ref
  `)) as unknown as { source_ref: string; status: string; person_key: string }[];

describe.skipIf(!RUN)("a fact reaches the feed and the timeline within the minute (UNIBOX-FACT-LAG-1028)", () => {
  beforeEach(async () => {
    installFetchStub();
    platformRunsOpened = 0;
    await wipe();
    // The person the brand already knows: a first Stripe customer, built into the people index.
    stripe = {
      customers: [{ id: "cus_old", email: "tari@x.com", name: "Tari", created: 1_793_000_000 }],
      charges: [
        { id: "ch_old", customer: "cus_old", amount: 1000, amount_refunded: 0, refunded: false, currency: "usd", status: "succeeded", paid: true, created: 1_793_000_100 },
      ],
      refunds: [],
      subscriptions: [],
    };
    expect((await asOrg(request(app()).post("/orgs/stripe/connections")).send({ brandId: BRAND })).status).toBe(200);
    await runStripeSyncPass();
    const { scope } = await ensureScope(ORG, BRAND, USER);
    await runScopeBuild(scope);
  });
  afterAll(wipe);

  it("a refused charge on a NEW Stripe customer: pending on the timeline, then on the feed after one emitter pass, no build", async () => {
    expect((await paymentFacts()).map((f) => f.source_ref)).toEqual(["ch_old"]);
    expect((await timeline()).body.factFeed).toMatchObject({ settled: true, pending: [] });

    // Checkout: Stripe creates a new customer for the same person; the card is refused.
    stripe.customers.push({ id: "cus_new", email: "tari@x.com", name: "Tari", created: 1_793_100_000 });
    stripe.charges.push({
      id: "ch_refused", customer: "cus_new", amount: 10000, amount_refunded: 0, refunded: false, currency: "usd",
      status: "failed", paid: false, failure_message: "Your card was declined.", created: 1_793_100_039,
    });
    const recordedAt = Date.now();
    await runStripeSyncPass();

    // The thread already shows the refused charge (read through), and says the feed does not hold it yet.
    const before = await timeline();
    expect(before.status).toBe(200);
    const refusedItem = before.body.items.find((i: { ref: { externalId?: string } }) => i.ref.externalId === "ch_refused");
    expect(refusedItem.event.detail.status).toBe("failed");
    expect(refusedItem.ref.factId).toBeUndefined();
    expect(before.body.factFeed.settled).toBe(false);
    expect(before.body.factFeed.pending).toEqual([
      expect.objectContaining({ source: "stripe", factKey: "stripe|payment|ch_refused" }),
    ]);

    // One emitter pass, NO people build: the new customer is filed on the person holding its email.
    const pass = await factEmitterPass();
    expect(pass.failed).toEqual([]);
    const facts = await paymentFacts();
    expect(facts.map((f) => [f.source_ref, f.status])).toEqual([
      ["ch_old", "succeeded"],
      ["ch_refused", "failed"],
    ]);
    expect(new Set(facts.map((f) => f.person_key))).toEqual(new Set(["email:tari@x.com"]));
    expect(Date.now() - recordedAt).toBeLessThan(60_000);

    const after = await timeline();
    expect(after.body.factFeed).toMatchObject({ settled: true, pending: [] });
    const stated = after.body.items.find((i: { ref: { externalId?: string } }) => i.ref.externalId === "ch_refused");
    expect(stated.ref.factId).toEqual(expect.any(String));

    // Nothing moved since: the next pass emits nothing (the inputs mark did not move).
    const [{ id }] = (await db.execute(sql`SELECT id FROM people_scopes WHERE org_id = ${ORG}`)) as unknown as { id: string }[];
    const mark = await inputsMark({ id, orgId: ORG, brandId: BRAND });
    expect((await factEmitterPass()).emitted.filter((e) => e.scopeId === id)).toEqual([]);
    expect(await inputsMark({ id, orgId: ORG, brandId: BRAND })).toBe(mark);
  });

  it("the feed read is a free read: no run, facts served or not (MON-CRM-SLOW-READ-1111)", async () => {
    const all = await request(app()).get(`/internal/people/facts?brandId=${BRAND}`).set("x-api-key", API_KEY);
    expect(all.status).toBe(200);
    expect(all.body.facts.length).toBeGreaterThan(0);
    expect(platformRunsOpened).toBe(0);

    const empty = await request(app()).get(`/internal/people/facts?brandId=${BRAND}&since=${all.body.nextCursor}`).set("x-api-key", API_KEY);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ facts: [], nextCursor: all.body.nextCursor, hasMore: false });
    expect(platformRunsOpened).toBe(0);
  });
  // BOX-LOAD-1107-CRM2: the phone watch kicks a people build only for a record no built person holds.
  it("a new record whose key a built person holds needs no build; one nobody holds, or stating no key, does", async () => {
    const since = new Date();
    stripe.customers.push(
      { id: "cus_same", email: "tari@x.com", name: "Tari", created: 1_793_200_000 },
      { id: "cus_stranger", email: "someone@else.com", name: "Someone", created: 1_793_200_001 },
      { id: "cus_keyless", email: null, name: "No Key", created: 1_793_200_002 },
    );
    await runStripeSyncPass();
    const unheld = await recordsNoPersonHolds(ORG, BRAND, since);
    const refs = (await db.execute(sql`
      SELECT external_id FROM contacts WHERE id = ANY(${`{${unheld.join(",")}}`}::uuid[]) ORDER BY external_id
    `)) as unknown as { external_id: string }[];
    expect(refs.map((r) => r.external_id)).toEqual(["cus_keyless", "cus_stranger"]);
    // Records written before `since` are not this pass's: nothing to build for them.
    expect(await recordsNoPersonHolds(ORG, BRAND, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it("the watch does not re-emit a scope for the build that just emitted it", async () => {
    const stamp = async () =>
      ((await db.execute(sql`SELECT facts_stated_through AS t FROM people_scopes WHERE org_id = ${ORG}`)) as unknown as { t: Date | string }[])[0].t;
    const afterBuild = String(await stamp());
    await factEmitterPass();
    expect(String(await stamp())).toBe(afterBuild);
  });
});
