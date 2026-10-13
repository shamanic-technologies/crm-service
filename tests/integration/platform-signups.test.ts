import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { authConnections, peopleFacts, platformSignupFacts } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { runAuthSyncPass } from "../../src/lib/auth/sync.js";
import { pullPlatformSignupFacts } from "../../src/lib/platform-signups/pull.js";
import authProviderRoutes from "../../src/routes/auth-providers.js";
import platformSignupRoutes from "../../src/routes/platform-signups.js";

/**
 * The platform's own signups (client-service's signup fact feed) become the
 * brand's `signup` facts, against a real Postgres (gated on CRM_TEST_DB).
 * client-service, Clerk, key-service, runs-service and the person layer's
 * siblings are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "bcbcbcbc-1111-4111-8111-000000000001";
const BRAND = "bcbcbcbc-1111-4111-8111-000000000002";
const TEST_ORG = "bcbcbcbc-1111-4111-8111-000000000003";
const USER = "user-platform-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

process.env.COPILOT_UNIBOX_ORG_ID = ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "c";
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

const clerkUser = (id: string, email: string, createdAt: string) => ({
  id,
  first_name: null,
  last_name: null,
  primary_email_address_id: `idn_${id}`,
  email_addresses: [{ id: `idn_${id}`, email_address: email, verification: { status: "verified" } }],
  primary_phone_number_id: null,
  phone_numbers: [],
  created_at: ms(createdAt),
  updated_at: ms(createdAt),
  last_sign_in_at: null,
  last_active_at: null,
  private_metadata: {},
});
// Ann created an org; Bob was only invited into one (a Clerk user, no signup of his own).
const USERS = [clerkUser("user_ann", "ann@x.com", "2026-06-18T10:00:00Z"), clerkUser("user_bob", "bob@y.com", "2026-07-01T10:00:00Z")];

const signupFact = (seq: number, over: Record<string, unknown>) => ({
  factId: `fact-${seq}`,
  seq,
  type: "signup",
  brandId: BRAND,
  customerOrgId: `org-${seq}`,
  clerkOrgId: `org_clerk_${seq}`,
  userId: null,
  clerkUserId: null,
  email: null,
  firstName: null,
  lastName: null,
  fullName: null,
  phone: null,
  occurredAt: "2026-06-18T10:01:00.000Z",
  dateBasis: "org_created_at",
  withdrawnOf: null,
  withdrawnReason: null,
  recordedAt: "2026-10-13T15:30:00.000Z",
  ...over,
});

let FEED: Record<string, unknown>[] = [];
let calls: string[] = [];

function installFetchStub() {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") return json({ key: "sk_live_good", provider: "clerk", keySource: "org" });
    if (url.host === "api.clerk.com") {
      if (url.pathname === "/v1/users/count") return json({ object: "total_count", total_count: USERS.length });
      if (url.pathname === "/v1/users") {
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return json(USERS.slice(offset, offset + limit));
      }
    }
    if (url.host === "client.test" && url.pathname === "/internal/signup-facts") {
      expect(init?.headers).toMatchObject({ "x-api-key": "c" });
      const since = Number(url.searchParams.get("since"));
      const limit = Number(url.searchParams.get("limit"));
      const after = FEED.filter((f) => (f.seq as number) > since);
      const page = after.slice(0, limit);
      return json({ facts: page, nextCursor: String(page.length ? page[page.length - 1].seq : since), hasMore: after.length > limit });
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
  a.use(authProviderRoutes);
  a.use(platformSignupRoutes);
  return a;
}

async function wipe() {
  await db.execute(sql`DELETE FROM platform_signup_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM auth_connections WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM contacts WHERE brand_id = ${BRAND}`);
}

/** Clerk connected and mirrored, the staff scope built once: Clerk is the signup source. */
async function clerkBrandBuilt() {
  const res = await request(app())
    .post("/orgs/clerk/connections")
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", USER)
    .send({ brandId: BRAND });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 200));
  const [conn] = await db.select().from(authConnections).where(eq(authConnections.brandId, BRAND));
  await runAuthSyncPass("clerk", conn.id);
  const { scope } = await ensureScope(ORG, BRAND, USER);
  expect((await runScopeBuild(scope)).ok).toBe(true);
  return scope;
}

const factsOf = async (orgId: string, type: string) =>
  db
    .select()
    .from(peopleFacts)
    .where(and(eq(peopleFacts.orgId, orgId), eq(peopleFacts.brandId, BRAND), eq(peopleFacts.type, type)))
    .orderBy(peopleFacts.feedSeq);

describe.skipIf(!RUN)("platform signups (client-service's signup fact feed)", () => {
  beforeEach(async () => {
    FEED = [];
    installFetchStub();
    await wipe();
  });
  afterAll(wipe);

  it("each platform signup becomes the brand's signup fact on its person; Clerk stops being a signup source", async () => {
    const scope = await clerkBrandBuilt();
    expect((await factsOf(ORG, "signup")).map((f) => [f.source, f.sourceRef])).toEqual([
      ["clerk", "user_ann"],
      ["clerk", "user_bob"],
    ]);

    FEED = [
      signupFact(1, { clerkUserId: "user_ann", email: "Ann@X.com", fullName: "Ann Lee", userId: "u-ann" }),
      // Nobody the brand's people hold (no Clerk user, no other presence): held, never invented.
      signupFact(2, { clerkUserId: "user_carol", email: "carol@z.com", occurredAt: "2026-08-01T00:00:00.000Z", dateBasis: "org_claimed_at" }),
    ];
    const pulled = await request(app()).post("/internal/platform-signups/pull").set("x-api-key", API_KEY);
    expect(pulled.status).toBe(200);
    expect(pulled.body).toMatchObject({ status: "ok", pulled: 2, stored: 2, cursor: 2, brands: [BRAND] });
    expect(calls.filter((c) => c.startsWith("GET client.test"))).toEqual([
      "GET client.test/internal/signup-facts?since=0&limit=500",
    ]);
    // The pull kicked the build in the background: build again once it is done.
    for (let i = 0; i < 100; i++) {
      const r = await runScopeBuild(scope);
      expect(r.ok).toBe(true);
      if (!r.skipped) break;
      await new Promise((res) => setTimeout(res, 100));
    }

    const live = (await factsOf(ORG, "signup")).filter((f) => f.live);
    expect(live.map((f) => [f.source, f.sourceRef, f.personKey, f.occurredAt?.toISOString(), f.dateBasis, f.sourceContactId])).toEqual([
      ["distribute_platform", "fact-1", "email:ann@x.com", "2026-06-18T10:01:00.000Z", "org_created_at", "user_ann"],
    ]);
    expect(live[0].payload).toEqual({ customerOrgId: "org-1", clerkOrgId: "org_clerk_1", userId: "u-ann", clerkUserId: "user_ann" });
    // Both Clerk signups are withdrawn as superseded: new facts, the old ones never rewritten.
    const withdrawn = await factsOf(ORG, "withdrawn");
    expect(withdrawn.map((w) => [w.source, w.sourceRef, (w.payload as { reason: string }).reason])).toEqual([
      ["clerk", "user_ann", "signup_source_superseded"],
      ["clerk", "user_bob", "signup_source_superseded"],
    ]);
    expect(await db.select().from(platformSignupFacts).where(eq(platformSignupFacts.brandId, BRAND))).toHaveLength(2);

    // A second pull and build change nothing.
    calls = [];
    expect(await pullPlatformSignupFacts()).toMatchObject({ pulled: 0, stored: 0, cursor: 2 });
    expect(calls.filter((c) => c.startsWith("GET client.test"))).toEqual([
      "GET client.test/internal/signup-facts?since=2&limit=500",
    ]);
    const before = (await db.select().from(peopleFacts).where(eq(peopleFacts.brandId, BRAND))).length;
    expect((await runScopeBuild(scope)).ok).toBe(true);
    expect((await db.select().from(peopleFacts).where(eq(peopleFacts.brandId, BRAND))).length).toBe(before);
  });

  it("a signup client-service withdraws is withdrawn on our feed with its reason", async () => {
    const scope = await clerkBrandBuilt();
    FEED = [signupFact(11, { clerkUserId: "user_ann", email: "ann@x.com" })];
    await pullPlatformSignupFacts();
    await runScopeBuild(scope);
    const [ours] = (await factsOf(ORG, "signup")).filter((f) => f.source === "distribute_platform");
    expect(ours.live).toBe(true);

    FEED.push(signupFact(12, { type: "withdrawn", withdrawnOf: "fact-11", withdrawnReason: "org_deleted", clerkUserId: "user_ann", email: "ann@x.com" }));
    expect(await pullPlatformSignupFacts()).toMatchObject({ stored: 1, cursor: 12 });
    await runScopeBuild(scope);

    const w = (await factsOf(ORG, "withdrawn")).filter((f) => f.source === "distribute_platform");
    expect(w).toHaveLength(1);
    expect(w[0].withdrawnOf).toBe(ours.factId);
    expect(w[0].payload).toEqual({ reason: "source_withdrawn", withdrawnType: "signup", sourceReason: "org_deleted" });
    expect((await factsOf(ORG, "signup")).filter((f) => f.live && f.source === "distribute_platform")).toEqual([]);
  });

  it("files under the staff org only: another org's scope on the same brand gets nothing", async () => {
    await clerkBrandBuilt();
    FEED = [signupFact(21, { clerkUserId: "user_ann", email: "ann@x.com" })];
    await pullPlatformSignupFacts();
    const { scope: other } = await ensureScope(TEST_ORG, BRAND, USER);
    expect((await runScopeBuild(other)).ok).toBe(true);
    expect(await factsOf(TEST_ORG, "signup")).toEqual([]);
    const rows = await db.select().from(platformSignupFacts).where(eq(platformSignupFacts.brandId, BRAND));
    expect(rows.map((r) => r.orgId)).toEqual([ORG]);
  });

  it("a malformed fact stores nothing and leaves the cursor where it was", async () => {
    await clerkBrandBuilt();
    FEED = [signupFact(31, { clerkUserId: "user_ann" }), { factId: "bad", seq: 32, type: "signup" }];
    await expect(pullPlatformSignupFacts()).rejects.toThrow();
    expect(await db.select().from(platformSignupFacts).where(eq(platformSignupFacts.brandId, BRAND))).toEqual([]);
  });
});
