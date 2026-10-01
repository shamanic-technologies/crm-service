import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  people,
  posthogActivities,
  posthogConnections,
  posthogRawRecords,
  stripeConnections,
  stripeRawRecords,
  stripeTransactions,
} from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { runPosthogSyncPass, rebuildPosthogFromBronze } from "../../src/lib/posthog/sync.js";
import { runStripeSyncPass, rebuildStripeFromBronze } from "../../src/lib/stripe/sync.js";
import peopleRoutes from "../../src/routes/people.js";
import posthogStripeRoutes from "../../src/routes/posthog-stripe.js";

/**
 * PostHog + Stripe as read-only sources of the person thread, against a real
 * Postgres (gated on CRM_TEST_DB). PostHog, Stripe, key-service, runs-service
 * and the person layer's siblings are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "eeeeeeee-1111-4111-8111-000000000001";
const BRAND = "eeeeeeee-1111-4111-8111-000000000002";
const USER = "user-ps-1";
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

let keys: Record<string, string> = {};
let posthogRefuses = false;
let stripeRefundsForbidden = false;
let calls: string[] = [];

const PERSONS = [
  {
    id: "ph-alice",
    email: "Alice@X.com",
    name: "Alice Martin",
    first_name: null,
    last_name: null,
    created_at: "2026-09-01T08:00:00Z",
  },
  {
    id: "ph-dave",
    email: "dave@z.com",
    name: null,
    first_name: "Dave",
    last_name: null,
    created_at: "2026-09-03T08:00:00Z",
  },
];
const VISITS = [
  {
    session_id: "s1",
    person_id: "ph-alice",
    started_at: "2026-09-01T09:00:00Z",
    ended_at: "2026-09-01T09:10:00Z",
    entry_url: "https://brand.com/pricing",
    entry_path: "/pricing",
    pageviews: 4,
    paths: ["/pricing", "/signup"],
    referrer: "$direct",
  },
  {
    session_id: "s2",
    person_id: "ph-dave",
    started_at: "2026-09-03T09:00:00Z",
    ended_at: "2026-09-03T09:01:00Z",
    entry_url: "https://brand.com/",
    entry_path: "/",
    pageviews: 1,
    paths: ["/"],
    referrer: "https://google.com",
  },
];
const EVENTS = [
  {
    id: "ev-1",
    event: "signup_completed",
    timestamp: "2026-09-01T09:05:00Z",
    person_id: "ph-alice",
    url: "https://brand.com/signup",
    path: "/signup",
    session_id: "s1",
  },
  {
    id: "ev-2",
    event: "invoice_viewed",
    timestamp: "2026-09-01T11:30:00Z",
    person_id: "ph-alice",
    url: "https://brand.com/billing",
    path: "/billing",
    session_id: "s3",
  },
];
const STRIPE: Record<string, Record<string, unknown>[]> = {
  customers: [
    {
      id: "cus_alice",
      object: "customer",
      email: "alice@x.com",
      phone: "+33612345678",
      name: "Alice M",
      created: 1_788_250_000,
    },
  ],
  charges: [
    {
      id: "ch_1",
      object: "charge",
      customer: "cus_alice",
      amount: 9900,
      amount_refunded: 0,
      refunded: false,
      currency: "usd",
      status: "succeeded",
      paid: true,
      created: 1_788_260_100,
      description: "Subscription creation",
    },
  ],
  refunds: [],
  subscriptions: [
    {
      id: "sub_1",
      object: "subscription",
      customer: "cus_alice",
      status: "active",
      currency: "usd",
      start_date: 1_788_260_000,
      created: 1_788_260_000,
      canceled_at: null,
      items: {
        data: [
          {
            quantity: 1,
            price: { id: "price_1", unit_amount: 9900, currency: "usd", recurring: { interval: "month" } },
          },
        ],
      },
    },
  ],
};

function hogqlAnswer(query: string) {
  const rows = (cols: string[], data: Record<string, unknown>[]) =>
    json({ columns: cols, results: data.map((d) => cols.map((c) => d[c] ?? null)) });
  if (query.includes("count() AS n FROM persons")) return rows(["n"], [{ n: PERSONS.length }]);
  if (query.includes("FROM persons"))
    return rows(
      ["id", "email", "name", "first_name", "last_name", "created_at"],
      query.includes("toString(id) >") ? [] : PERSONS,
    );
  if (query.includes("event = '$pageview'"))
    return rows(
      [
        "session_id",
        "person_id",
        "started_at",
        "ended_at",
        "entry_url",
        "entry_path",
        "pageviews",
        "paths",
        "referrer",
      ],
      VISITS,
    );
  if (query.includes("NOT LIKE '$%'"))
    return rows(["id", "event", "timestamp", "person_id", "url", "path", "session_id"], EVENTS);
  throw new Error(`unexpected HogQL ${query}`);
}

function installFetchStub() {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") {
      const provider = url.pathname.split("/")[4];
      const key = keys[provider];
      return key ? json({ key, provider, keySource: "org" }) : json({ error: "Key not found" }, 404);
    }
    if (url.host === "eu.posthog.com") {
      if (posthogRefuses) {
        return json(
          {
            type: "authentication_error",
            code: "authentication_failed",
            detail: "Personal API key found in request Authorization header is invalid.",
          },
          401,
        );
      }
      const body = JSON.parse(String(init?.body)) as { query: { query: string } };
      return hogqlAnswer(body.query.query);
    }
    if (url.host === "api.stripe.com") {
      const resource = url.pathname.replace("/v1/", "");
      if (resource === "refunds" && stripeRefundsForbidden) {
        return json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "The provided key 'rk_live_***abc' does not have the required permissions for this endpoint. Having the 'rak_refund_read' permission would allow this request to continue.",
            },
          },
          403,
        );
      }
      return json({ object: "list", data: STRIPE[resource] ?? [], has_more: false });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [] });
    if (url.host === "lead.test") {
      if (url.pathname === "/orgs/leads") return json({ leads: [] });
    }
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

async function wipe() {
  await db.execute(
    sql`TRUNCATE people_scopes, people, lead_standing_observations, posthog_connections, stripe_connections, contacts CASCADE`,
  );
}

async function connectBoth() {
  keys = { posthog: "phx_good", stripe: "rk_live_good" };
  const ph = await asOrg(request(app()).post("/orgs/posthog/connections")).send({
    brandId: BRAND,
    projectId: "171095",
    region: "eu",
  });
  expect(ph.status).toBe(200);
  const st = await asOrg(request(app()).post("/orgs/stripe/connections")).send({ brandId: BRAND });
  expect(st.status).toBe(200);
}

describe.skipIf(!RUN)("PostHog + Stripe sources", () => {
  beforeEach(async () => {
    keys = {};
    posthogRefuses = false;
    stripeRefundsForbidden = false;
    installFetchStub();
    await wipe();
  });

  it("connecting refuses a missing key, a vendor-refused key (in the vendor's words) and a secret Stripe key", async () => {
    const none = await asOrg(request(app()).post("/orgs/posthog/connections")).send({
      brandId: BRAND,
      projectId: "1",
      region: "eu",
    });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/no PostHog credential stored/);

    keys = { posthog: "phx_bad", stripe: "sk_live_secret" };
    posthogRefuses = true;
    const bad = await asOrg(request(app()).post("/orgs/posthog/connections")).send({
      brandId: BRAND,
      projectId: "1",
      region: "eu",
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      type: "vendor",
      vendorStatus: 401,
      vendorError: "Personal API key found in request Authorization header is invalid.",
    });

    const secret = await asOrg(request(app()).post("/orgs/stripe/connections")).send({ brandId: BRAND });
    expect(secret.status).toBe(400);
    expect(secret.body.error).toMatch(/not a restricted key/);
    expect(calls.some((c) => c.includes("api.stripe.com"))).toBe(false);

    keys.stripe = "rk_live_abc";
    stripeRefundsForbidden = true;
    const missingPerm = await asOrg(request(app()).post("/orgs/stripe/connections")).send({ brandId: BRAND });
    expect(missingPerm.status).toBe(400);
    expect(missingPerm.body.vendorStatus).toBe(403);
    expect(missingPerm.body.vendorError).toMatch(/rak_refund_read/);

    expect(await db.select().from(posthogConnections)).toHaveLength(0);
    expect(await db.select().from(stripeConnections)).toHaveLength(0);
    // Nothing but reads ever reached a vendor.
    expect(calls.filter((c) => c.includes("api.stripe.com")).every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("connects, mirrors, derives, and a second pass changes nothing", async () => {
    await connectBoth();
    const conn = await asOrg(request(app()).get(`/orgs/stripe/connections?brandId=${BRAND}`));
    expect(conn.body.connections[0]).toMatchObject({ keyMode: "live", status: "active", synced: false });

    const ph1 = await runPosthogSyncPass();
    expect(ph1.failures).toEqual([]);
    expect(ph1.results[0]).toMatchObject({
      personsMirrored: 2,
      personsChanged: 2,
      visitsChanged: 2,
      eventsChanged: 2,
      contactsDerived: 2,
      activitiesDerived: 4,
      activitiesLinked: 4,
    });
    const st1 = await runStripeSyncPass();
    expect(st1.failures).toEqual([]);
    expect(st1.results[0]).toMatchObject({
      full: true,
      contactsDerived: 1,
      transactionsDerived: 2,
      transactionsLinked: 2,
    });

    const snapshot = async () => ({
      raw: await db.select().from(posthogRawRecords).orderBy(posthogRawRecords.externalId),
      act: await db.select().from(posthogActivities).orderBy(posthogActivities.externalId),
      sraw: await db.select().from(stripeRawRecords).orderBy(stripeRawRecords.externalId),
      tx: await db.select().from(stripeTransactions).orderBy(stripeTransactions.externalId),
      contacts: await db.select().from(contacts).orderBy(contacts.externalId),
    });
    const before = await snapshot();
    const ph2 = await runPosthogSyncPass();
    expect(ph2.results[0]).toMatchObject({
      personsChanged: 0,
      visitsChanged: 0,
      eventsChanged: 0,
      contactsDerived: 0,
      activitiesDerived: 0,
      activitiesLinked: 0,
    });
    const st2 = await runStripeSyncPass();
    expect(st2.results[0]).toMatchObject({ full: false, contactsDerived: 0, transactionsDerived: 0 });
    expect(await snapshot()).toEqual(before);

    // Silver is rebuildable from the mirror alone — no vendor call.
    await db.delete(posthogActivities);
    await db.delete(stripeTransactions);
    calls = [];
    const [pc] = await db.select().from(posthogConnections);
    const [sc] = await db.select().from(stripeConnections);
    await rebuildPosthogFromBronze(pc);
    await rebuildStripeFromBronze(sc);
    expect(calls.filter((c) => c.includes("posthog.com") || c.includes("stripe.com"))).toEqual([]);
    const after = await snapshot();
    const strip = <T extends { id: string; lastRebuiltAt: Date }>(rows: T[]) =>
      rows.map(({ id: _i, lastRebuiltAt: _l, ...r }) => r);
    expect(strip(after.act)).toEqual(strip(before.act));
    expect(strip(after.tx)).toEqual(strip(before.tx));
  });

  it("a person who visited and paid: one person, both sources counted, events interleaved in their thread", async () => {
    await connectBoth();
    await runPosthogSyncPass();
    await runStripeSyncPass();
    const { scope } = await ensureScope(ORG, BRAND, USER);
    const built = await runScopeBuild(scope);
    expect(built.ok).toBe(true);

    const rows = await db.select().from(people).orderBy(people.personKey);
    expect(rows.map((r) => r.personKey)).toEqual(["email:alice@x.com", "email:dave@z.com"]);
    expect(rows[0]).toMatchObject({
      sources: ["posthog", "stripe"],
      state: "subscription_active",
      stateSource: "stripe",
      displayName: "Alice M",
    });
    expect(rows[0].identityKeys).toEqual(["email:alice@x.com", "phone:+33612345678"]);
    expect(rows[1]).toMatchObject({ sources: ["posthog"], state: "in_conversation", stateSource: "none" });

    const list = await asOrg(request(app()).get(`/orgs/people?brandId=${BRAND}`));
    expect(list.status).toBe(200);
    const bySource = Object.fromEntries(list.body.sources.map((s: { source: string }) => [s.source, s]));
    expect(bySource.posthog).toMatchObject({ status: "ok", people: 2, presences: 2, sourceCount: 2, error: null });
    expect(bySource.stripe).toMatchObject({ status: "ok", people: 1, presences: 1, sourceCount: 1, error: null });
    expect(bySource.gmail).toMatchObject({ status: "not_connected" });

    const tl = await asOrg(
      request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:alice@x.com")}`),
    );
    expect(tl.status).toBe(200);
    const t = tl.body.items.map(
      (i: { at: string; source: string; event: { step: string } }) => `${i.at} ${i.source}:${i.event.step}`,
    );
    expect(t).toEqual([
      "2026-09-01T09:00:00.000Z posthog:visit",
      "2026-09-01T09:05:00.000Z posthog:event",
      "2026-09-01T10:53:20.000Z stripe:subscription_started",
      "2026-09-01T10:55:00.000Z stripe:payment",
      "2026-09-01T11:30:00.000Z posthog:event",
    ]);
    const payment = tl.body.items.find((i: { event: { step: string } }) => i.event.step === "payment");
    expect(payment.event.detail).toMatchObject({ amountMinor: 9900, amount: 99, currency: "usd", status: "succeeded" });
    const visit = tl.body.items[0];
    expect(visit).toMatchObject({
      channel: "web",
      text: "/pricing",
      event: { detail: { pageviews: 4, url: "https://brand.com/pricing" } },
    });
    const statuses = Object.fromEntries(
      tl.body.sources.map((s: { source: string; status: string }) => [s.source, s.status]),
    );
    expect(statuses).toMatchObject({
      posthog: "ok",
      stripe: "ok",
      gmail: "not_connected",
      matrix: "not_connected",
      gohighlevel: "not_connected",
    });
  });

  it("a connection whose first sync failed is reported failed, never as zero people", async () => {
    await connectBoth();
    keys = {};
    const r = await runPosthogSyncPass();
    expect(r.failures).toHaveLength(1);
    const { scope } = await ensureScope(ORG, BRAND, USER);
    const built = await runScopeBuild(scope);
    const ph = built.summary!.sources.find((s) => s.source === "posthog")!;
    expect(ph.status).toBe("failed");
    expect(ph.error).toMatch(/no PostHog credential stored/);
    const st = built.summary!.sources.find((s) => s.source === "stripe")!;
    expect(st).toMatchObject({ status: "failed", error: "connected, first sync not finished yet" });
    const [row] = await db.select().from(posthogConnections).where(eq(posthogConnections.brandId, BRAND));
    expect(row.status).toBe("error");
  });

  it("disconnecting removes the mirror and the contacts", async () => {
    await connectBoth();
    await runPosthogSyncPass();
    const [pc] = await db.select().from(posthogConnections);
    const del = await asOrg(request(app()).delete(`/orgs/posthog/connections/${pc.id}`));
    expect(del.status).toBe(200);
    expect(await db.select().from(posthogRawRecords)).toHaveLength(0);
    expect(await db.select().from(posthogActivities)).toHaveLength(0);
    expect(await db.select().from(contacts).where(eq(contacts.source, "posthog"))).toHaveLength(0);
  });
});
