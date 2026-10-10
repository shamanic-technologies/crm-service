import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { authConnections, authRawRecords, contacts, people, peopleFacts } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { rebuildAuthFromBronze, runAuthSyncPass } from "../../src/lib/auth/sync.js";
import { runPosthogSyncPass } from "../../src/lib/posthog/sync.js";
import authProviderRoutes from "../../src/routes/auth-providers.js";
import posthogStripeRoutes from "../../src/routes/posthog-stripe.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * Clerk as the brand's auth provider (every signup of its product), against a
 * real Postgres (gated on CRM_TEST_DB). Clerk, PostHog, key-service,
 * runs-service and the person layer's siblings are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "fafafafa-1111-4111-8111-000000000001";
const BRAND = "fafafafa-1111-4111-8111-000000000002";
const USER = "user-clerk-1";
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

const ms = (iso: string) => new Date(iso).getTime();

let keys: Record<string, string> = {};
let clerkRefuses = false;
let calls: string[] = [];
let USERS: Record<string, unknown>[] = [];

const ann = {
  id: "user_ann",
  first_name: "Ann",
  last_name: "Lee",
  primary_email_address_id: "idn_ann2",
  email_addresses: [
    { id: "idn_ann1", email_address: "ann.old@x.com", verification: { status: "verified" } },
    { id: "idn_ann2", email_address: "Ann@X.com", verification: { status: "verified" } },
    { id: "idn_ann3", email_address: "typo@x.com", verification: { status: "unverified" } },
  ],
  primary_phone_number_id: null,
  phone_numbers: [],
  created_at: ms("2026-06-18T10:00:00Z"),
  updated_at: ms("2026-06-18T10:00:00Z"),
  last_sign_in_at: ms("2026-09-01T10:00:00Z"),
  last_active_at: ms("2026-09-02T00:00:00Z"),
  private_metadata: { stripeSecret: "never-stored" },
};
const bob = {
  id: "user_bob",
  first_name: null,
  last_name: null,
  primary_email_address_id: "idn_bob",
  email_addresses: [{ id: "idn_bob", email_address: "bob@y.com", verification: { status: "verified" } }],
  primary_phone_number_id: "idn_bobp",
  phone_numbers: [{ id: "idn_bobp", phone_number: "+33612345678", verification: { status: "verified" } }],
  created_at: ms("2026-07-01T10:00:00Z"),
  updated_at: ms("2026-07-01T10:00:00Z"),
  last_sign_in_at: null,
  last_active_at: null,
  private_metadata: {},
};

// PostHog: one person identified by email (Ann, another address), one known only by Bob's Clerk user id.
const PH_PERSONS = [
  {
    id: "ph-ann",
    email: "ann@x.com",
    name: null,
    first_name: null,
    last_name: null,
    created_at: "2026-06-18T10:00:05Z",
    is_identified: 1,
    distinct_ids: ["anon-1", "user_ann"],
  },
];
const PH_BY_AUTH_ID = [
  {
    id: "ph-bob",
    email: null,
    name: null,
    first_name: null,
    last_name: null,
    created_at: "2026-07-01T10:00:02Z",
    is_identified: 0,
    distinct_ids: ["user_bob"],
  },
];
const PH_COLS = ["id", "email", "name", "first_name", "last_name", "created_at", "is_identified", "distinct_ids"];

function hogqlAnswer(query: string) {
  const rows = (cols: string[], data: Record<string, unknown>[]) =>
    json({ columns: cols, results: data.map((d) => cols.map((c) => d[c] ?? null)) });
  if (query.includes("count() AS n FROM persons")) return rows(["n"], [{ n: PH_PERSONS.length }]);
  if (query.includes("FROM persons AS p") && query.includes("WHERE NOT")) {
    return rows(PH_COLS, query.includes("'user_bob'") ? PH_BY_AUTH_ID : []);
  }
  if (query.includes("FROM persons AS p")) return rows(PH_COLS, query.includes("toString(p.id) >") ? [] : PH_PERSONS);
  if (query.includes("event = '$pageview'")) {
    const visits = query.includes("'ph-bob'")
      ? [
          {
            session_id: "s-bob",
            person_id: "ph-bob",
            started_at: "2026-07-02T09:00:00Z",
            ended_at: "2026-07-02T09:05:00Z",
            entry_url: "https://brand.com/app",
            entry_path: "/app",
            pageviews: 3,
            paths: ["/app"],
            referrer: "$direct",
          },
        ]
      : [];
    return rows(
      ["session_id", "person_id", "started_at", "ended_at", "entry_url", "entry_path", "pageviews", "paths", "referrer"],
      visits,
    );
  }
  if (query.includes("NOT LIKE '$%'")) return rows(["id", "event", "timestamp", "person_id", "url", "path", "session_id"], []);
  throw new Error(`unexpected HogQL ${query}`);
}

function installFetchStub() {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") {
      const provider = url.pathname.split("/")[4];
      const key = keys[provider];
      return key ? json({ key, provider, keySource: "org" }) : json({ error: "Key not found" }, 404);
    }
    if (url.host === "api.clerk.com") {
      if (clerkRefuses) {
        return json({ errors: [{ message: "Invalid authentication", long_message: "The provided secret key is invalid.", code: "authentication_invalid" }] }, 401);
      }
      if (url.pathname === "/v1/users/count") return json({ object: "total_count", total_count: USERS.length });
      if (url.pathname === "/v1/users") {
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return json(USERS.slice(offset, offset + limit));
      }
    }
    if (url.host === "eu.posthog.com") {
      const body = JSON.parse(String(init?.body)) as { query: { query: string } };
      return hogqlAnswer(body.query.query);
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
  a.use(authProviderRoutes);
  a.use(posthogStripeRoutes);
  a.use(peopleRoutes);
  return a;
}

const asOrg = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);

async function wipe() {
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM auth_connections WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM posthog_connections WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM contacts WHERE brand_id = ${BRAND}`);
}

/** Connect (the first sync is kicked in the background; the test drives passes itself). */
async function connectClerk() {
  keys = { ...keys, clerk: "sk_live_good" };
  const res = await asOrg(request(app()).post("/orgs/clerk/connections")).send({ brandId: BRAND });
  expect(res.status).toBe(200);
  // Let the background first pass finish before the test drives its own.
  await new Promise((r) => setTimeout(r, 200));
  return res;
}

/** One pass over THIS suite's connection only (other suites leave connections of their own). */
async function syncMine() {
  const [conn] = await db.select().from(authConnections).where(eq(authConnections.brandId, BRAND));
  return runAuthSyncPass("clerk", conn.id);
}

describe.skipIf(!RUN)("Clerk auth provider", () => {
  beforeEach(async () => {
    keys = {};
    clerkRefuses = false;
    USERS = [ann, bob];
    installFetchStub();
    await wipe();
  });
  afterAll(wipe);

  it("refuses a missing key, a publishable key, and a key Clerk refuses (in Clerk's words); writes nothing", async () => {
    const none = await asOrg(request(app()).post("/orgs/clerk/connections")).send({ brandId: BRAND });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/no Clerk credential stored/);

    keys = { clerk: "pk_live_abc" };
    const pk = await asOrg(request(app()).post("/orgs/clerk/connections")).send({ brandId: BRAND });
    expect(pk.status).toBe(400);
    expect(pk.body.error).toMatch(/PUBLISHABLE/);
    expect(calls.some((c) => c.includes("api.clerk.com"))).toBe(false);

    keys = { clerk: "sk_live_bad" };
    clerkRefuses = true;
    const bad = await asOrg(request(app()).post("/orgs/clerk/connections")).send({ brandId: BRAND });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ type: "vendor", vendorStatus: 401, vendorError: "The provided secret key is invalid." });
    expect(await db.select().from(authConnections).where(eq(authConnections.brandId, BRAND))).toHaveLength(0);
  });

  it("imports every user (verified addresses only, no private_metadata), a second pass changes nothing, rebuild needs no Clerk call", async () => {
    const res = await connectClerk();
    expect(res.body).toMatchObject({ userCount: 2, connection: { provider: "clerk", status: "active" } });

    const pass = await syncMine();
    expect(pass.failures).toEqual([]);
    expect(pass.results[0]).toMatchObject({ usersListed: 2, providerUserCount: 2, complete: true, usersRemoved: 0 });

    const raw = await db.select().from(authRawRecords).where(eq(authRawRecords.brandId, BRAND));
    expect(raw).toHaveLength(2);
    expect(JSON.stringify(raw)).not.toContain("never-stored");

    const rows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.brandId, BRAND), eq(contacts.source, "clerk")))
      .orderBy(contacts.externalId);
    expect(rows.map((r) => [r.externalId, r.primaryEmail, r.phoneE164, r.fullName])).toEqual([
      ["user_ann", "ann@x.com", null, "Ann Lee"],
      ["user_bob", "bob@y.com", "+33612345678", null],
    ]);
    expect((rows[0].rawAttributes as { emails: string[] }).emails).toEqual(["ann@x.com", "ann.old@x.com"]);
    expect(rows[0].sourceCreatedAt?.toISOString()).toBe("2026-06-18T10:00:00.000Z");

    const again = await syncMine();
    expect(again.results[0]).toMatchObject({ usersChanged: 0, contactsDerived: 0 });

    calls = [];
    const [conn] = await db.select().from(authConnections).where(eq(authConnections.brandId, BRAND));
    await db.delete(contacts).where(and(eq(contacts.brandId, BRAND), eq(contacts.source, "clerk")));
    expect(await rebuildAuthFromBronze(conn)).toEqual({ contactsDerived: 2 });
    expect(calls.filter((c) => c.includes("clerk.com"))).toEqual([]);
  });

  it("a user deleted in Clerk leaves once a pass lists everyone, and its signup fact is withdrawn", async () => {
    await connectClerk();
    await syncMine();
    const { scope } = await ensureScope(ORG, BRAND, USER);
    expect((await runScopeBuild(scope)).ok).toBe(true);

    USERS = [ann];
    const pass = await syncMine();
    expect(pass.results[0]).toMatchObject({ usersListed: 1, complete: true, usersRemoved: 1 });
    expect(
      (await db.select().from(contacts).where(and(eq(contacts.brandId, BRAND), eq(contacts.source, "clerk")))).map(
        (c) => c.externalId,
      ),
    ).toEqual(["user_ann"]);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    const withdrawn = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.type, "withdrawn")));
    expect(withdrawn).toHaveLength(1);
  });

  it("every signup is a person with a dated signup fact; a PostHog person with no email joins its user on the Clerk id", async () => {
    await connectClerk();
    await syncMine();
    keys = { ...keys, posthog: "phx_good" };
    const ph = await asOrg(request(app()).post("/orgs/posthog/connections")).send({
      brandId: BRAND,
      projectId: "171095",
      region: "eu",
    });
    expect(ph.status).toBe(200);
    const phPass = await runPosthogSyncPass(ph.body.connection.id);
    const mine = phPass.results[0];
    expect(mine).toMatchObject({ personsMirrored: 2, personsByAuthUserId: 1 });

    const { scope } = await ensureScope(ORG, BRAND, USER);
    expect((await runScopeBuild(scope)).ok).toBe(true);

    const rows = await db.select().from(people).where(eq(people.brandId, BRAND)).orderBy(people.personKey);
    expect(rows.map((r) => [r.personKey, r.sources])).toEqual([
      ["email:ann.old@x.com", ["posthog", "clerk"]],
      ["email:bob@y.com", ["posthog", "clerk"]],
    ]);
    expect(rows[1].identityKeys).toEqual(["email:bob@y.com", "phone:+33612345678", "uid:user_bob"]);

    const signups = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.type, "signup")))
      .orderBy(peopleFacts.source, peopleFacts.sourceRef);
    expect(signups.map((f) => [f.source, f.sourceRef, f.dateBasis, f.occurredAt?.toISOString(), f.emails])).toEqual([
      ["clerk", "user_ann", "user_created_at", "2026-06-18T10:00:00.000Z", ["ann.old@x.com", "ann@x.com"]],
      ["clerk", "user_bob", "user_created_at", "2026-07-01T10:00:00.000Z", ["bob@y.com"]],
      ["posthog", "ph-ann", "person_created_at", "2026-06-18T10:00:05.000Z", ["ann.old@x.com", "ann@x.com"]],
      ["posthog", "ph-bob", "person_created_at", "2026-07-01T10:00:02.000Z", ["bob@y.com"]],
    ]);

    // Bob's visit, read from PostHog's whole history, is in his thread beside his Clerk signup.
    const tl = await asOrg(
      request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:bob@y.com")}`),
    );
    expect(tl.status).toBe(200);
    expect(tl.body.items.map((i: { source: string; event: { step: string } }) => `${i.source}:${i.event.step}`)).toEqual([
      "clerk:signup",
      "posthog:signup",
      "posthog:visit",
    ]);
    const list = await asOrg(request(app()).get(`/orgs/people?brandId=${BRAND}`));
    const clerkSource = list.body.sources.find((s: { source: string }) => s.source === "clerk");
    expect(clerkSource).toMatchObject({ status: "ok", people: 2, sourceCount: 2 });
  });
});
