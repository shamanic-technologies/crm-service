import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, stripeConnections, stripeTransactions } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { emitScopeFacts } from "../../src/lib/people/facts.js";
import { runStripeSyncPass } from "../../src/lib/stripe/sync.js";
import posthogStripeRoutes from "../../src/routes/posthog-stripe.js";

/**
 * A brand connects SEVERAL Stripe accounts, each with its own restricted key
 * stored in key-service under its own provider name (`stripe`, `stripe-<label>`).
 * Stripe, key-service, runs-service and the person layer's siblings are stubbed
 * at `fetch`; each key answers with its OWN account's objects.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "abcdefab-1111-4111-8111-000000000001";
const BRAND = "abcdefab-1111-4111-8111-000000000002";
const USER = "user-stripe-multi";
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

/** key-service: provider name → key. */
let keys: Record<string, string> = {};

/** What each Stripe account holds, by the key that reads it. */
const ACCOUNTS: Record<string, { account: Record<string, unknown> | null; data: Record<string, Record<string, unknown>[]> }> = {
  rk_live_us: {
    account: { id: "acct_US", settings: { dashboard: { display_name: "Brand US" } } },
    data: {
      customers: [{ id: "cus_us_1", email: "ann@us.com", name: "Ann", created: 1_788_250_000 }],
      charges: [
        { id: "ch_us_1", customer: "cus_us_1", amount: 5000, amount_refunded: 0, refunded: false, currency: "usd", status: "succeeded", paid: true, created: 1_788_260_000 },
      ],
      refunds: [],
      subscriptions: [],
    },
  },
  rk_live_eu: {
    // This key may not read the account: Stripe refuses, the identity is unknown.
    account: null,
    data: {
      customers: [{ id: "cus_eu_1", email: "bob@eu.com", name: "Bob", created: 1_788_250_100 }],
      charges: [
        { id: "ch_eu_1", customer: "cus_eu_1", amount: 7000, amount_refunded: 0, refunded: false, currency: "eur", status: "succeeded", paid: true, created: 1_788_260_100 },
      ],
      refunds: [],
      subscriptions: [],
    },
  },
};
// A second key on the US account (same account, another key).
ACCOUNTS.rk_live_us_again = ACCOUNTS.rk_live_us;
// A second key on the EU account: the account cannot be read, the overlap of objects tells.
ACCOUNTS.rk_live_eu_again = ACCOUNTS.rk_live_eu;

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") {
      const provider = url.pathname.split("/")[4];
      const key = keys[provider];
      return key ? json({ key, provider, keySource: "org" }) : json({ error: "Key not found" }, 404);
    }
    if (url.host === "api.stripe.com") {
      const key = new Headers(init?.headers).get("authorization")!.replace("Bearer ", "");
      const acct = ACCOUNTS[key];
      if (!acct) return json({ error: { message: "Invalid API Key provided" } }, 401);
      const resource = url.pathname.replace("/v1/", "");
      if (resource === "account") {
        return acct.account
          ? json(acct.account)
          : json({ error: { message: "The provided key does not have the required permissions for this endpoint." } }, 403);
      }
      return json({ object: "list", data: acct.data[resource] ?? [], has_more: false });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [] });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads") return json({ leads: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(posthogStripeRoutes);
  return a;
}

const asOrg = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
const connect = (credentialProvider?: string) =>
  asOrg(request(app()).post("/orgs/stripe/connections")).send({
    brandId: BRAND,
    ...(credentialProvider ? { credentialProvider } : {}),
  });

async function wipe() {
  await db.execute(sql`DELETE FROM people_facts WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM stripe_connections WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
}

describe.skipIf(!RUN)("several Stripe accounts on one brand", () => {
  beforeEach(async () => {
    keys = {};
    installFetchStub();
    await wipe();
  });
  afterAll(wipe);

  it("connects two accounts side by side, each named, both synced, every read covering both", async () => {
    keys = { stripe: "rk_live_us", "stripe-eu": "rk_live_eu" };
    const first = await connect();
    expect(first.status).toBe(200);
    expect(first.body.connection).toMatchObject({
      credentialProvider: "stripe",
      account: { id: "acct_US", name: "Brand US" },
    });
    const second = await connect("stripe-eu");
    expect(second.status).toBe(200);
    expect(second.body.connection).toMatchObject({ credentialProvider: "stripe-eu", account: null });
    expect(second.body.connection.id).not.toBe(first.body.connection.id);

    const list = await asOrg(request(app()).get(`/orgs/stripe/connections?brandId=${BRAND}`));
    expect(list.body.connections.map((c: { credentialProvider: string }) => c.credentialProvider).sort()).toEqual([
      "stripe",
      "stripe-eu",
    ]);

    // Re-posting one provider re-proves THAT connection, it does not add a third.
    expect((await connect("stripe-eu")).body.connection.id).toBe(second.body.connection.id);
    expect(await db.select().from(stripeConnections).where(eq(stripeConnections.orgId, ORG))).toHaveLength(2);

    const pass = await runStripeSyncPass();
    expect(pass.failures).toEqual([]);
    const txs = await db.select().from(stripeTransactions).where(eq(stripeTransactions.orgId, ORG));
    expect(txs.map((t) => t.externalId).sort()).toEqual(["ch_eu_1", "ch_us_1"]);

    const { scope } = await ensureScope(ORG, BRAND, USER);
    const built = await runScopeBuild(scope);
    const st = built.summary!.sources.find((s) => s.source === "stripe")!;
    expect(st).toMatchObject({ status: "ok", sourceCount: 2 });
  });

  it("refuses the same account twice: by its account id, or by its objects when the account cannot be read", async () => {
    keys = { stripe: "rk_live_us", "stripe-us2": "rk_live_us_again", "stripe-eu": "rk_live_eu", "stripe-eu2": "rk_live_eu_again" };
    expect((await connect()).status).toBe(200);
    const byAccount = await connect("stripe-us2");
    expect(byAccount.status).toBe(409);
    expect(byAccount.body.type).toBe("stripe_account_already_connected");

    expect((await connect("stripe-eu")).status).toBe(200);
    await runStripeSyncPass();
    const byObjects = await connect("stripe-eu2");
    expect(byObjects.status).toBe(409);
    expect(await db.select().from(stripeConnections).where(eq(stripeConnections.orgId, ORG))).toHaveLength(2);
  });

  it("a second account still on its first sync does not hide the first one's people", async () => {
    keys = { stripe: "rk_live_us", "stripe-eu": "rk_live_eu" };
    await connect();
    await runStripeSyncPass();
    await connect("stripe-eu");
    const { scope } = await ensureScope(ORG, BRAND, USER);
    const st = (await runScopeBuild(scope)).summary!.sources.find((s) => s.source === "stripe")!;
    expect(st.status).toBe("ok");
    expect(st.sourceCount).toBe(1);
    expect(st.error).toBe("connected, first sync not finished yet");
  });

  it("disconnecting one account leaves the other syncing, and withdraws none of its facts", async () => {
    keys = { stripe: "rk_live_us", "stripe-eu": "rk_live_eu" };
    const us = (await connect()).body.connection;
    const eu = (await connect("stripe-eu")).body.connection;
    await runStripeSyncPass();
    const { scope } = await ensureScope(ORG, BRAND, USER);
    await runScopeBuild(scope);
    await emitScopeFacts(scope);
    const before = (await db.execute(sql`
      SELECT source_ref FROM people_facts WHERE org_id = ${ORG} AND type = 'payment' ORDER BY source_ref
    `)) as unknown as { source_ref: string }[];
    expect(before.map((f) => f.source_ref)).toEqual(["ch_eu_1", "ch_us_1"]);

    const del = await asOrg(request(app()).delete(`/orgs/stripe/connections/${eu.id}`));
    expect(del.status).toBe(200);
    const left = await db.select().from(stripeConnections).where(eq(stripeConnections.orgId, ORG));
    expect(left.map((c) => c.id)).toEqual([us.id]);
    expect(
      (await db.select().from(contacts).where(eq(contacts.orgId, ORG))).map((c) => c.externalId),
    ).toEqual(["cus_us_1"]);

    // The US account keeps syncing on its own key.
    const pass = await runStripeSyncPass(us.id);
    expect(pass.failures).toEqual([]);
    expect(pass.results.map((r) => r.connectionId)).toEqual([us.id]);

    // Disconnect stops the feed, it never withdraws (the EU payment fact stays live).
    await runScopeBuild(scope);
    await emitScopeFacts(scope);
    const withdrawn = (await db.execute(sql`
      SELECT f.source_ref FROM people_facts f WHERE f.org_id = ${ORG} AND f.type = 'withdrawn'
    `)) as unknown as { source_ref: string }[];
    expect(withdrawn).toEqual([]);
  });
});
