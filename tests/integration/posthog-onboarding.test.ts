import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, people, posthogActivities, posthogConnections } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { mirrorRecentPersons } from "../../src/lib/posthog/sync.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * ONBOARDING-IN-UNIBOX-1015: a visitor walking a product's signup steps is a person
 * of the brand from the first page where they type who they are (here: only their
 * website), and every step they walk shows on their thread with what they entered.
 * Real Postgres (CRM_TEST_DB); PostHog, key-service, runs-service and the person
 * layer's siblings stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "abababab-1111-4111-8111-000000000001";
const BRAND = "abababab-1111-4111-8111-000000000002";
const USER = "user-onb-1";
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

const VISITOR = {
  id: "ph-visitor",
  email: null,
  name: null,
  first_name: null,
  last_name: null,
  created_at: "2026-10-15T09:00:00Z",
  prop_website: "https://www.Acme.io/pricing",
  is_identified: 0,
  distinct_ids: ["anon-visitor-1"],
};
const EVENTS = [
  {
    id: "ev-site",
    event: "get_started_website_submitted",
    timestamp: "2026-10-15T09:00:05Z",
    person_id: "ph-visitor",
    url: "https://brand.test/get-started",
    path: "/get-started",
    session_id: "s1",
    // HogQL serves `properties` as a JSON string, PostHog's own `$` keys included.
    properties: JSON.stringify({ website: "acme.io", $current_url: "https://brand.test/get-started", $set: { website: "acme.io" } }),
  },
  {
    id: "ev-mode",
    event: "get_started_setup_chosen",
    timestamp: "2026-10-15T09:01:00Z",
    person_id: "ph-visitor",
    url: "https://brand.test/get-started",
    path: "/get-started",
    session_id: "s1",
    properties: JSON.stringify({ mode: "ai", $browser: "Chrome" }),
  },
];
let hogql: string[] = [];

function installFetchStub() {
  hogql = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") return json({ key: "phx_good", provider: "posthog", keySource: "org" });
    if (url.host === "eu.posthog.com") {
      const q = (JSON.parse(String(init?.body)) as { query: { query: string } }).query.query;
      hogql.push(q);
      const rows = (cols: string[], data: Record<string, unknown>[]) =>
        json({ columns: cols, results: data.map((d) => cols.map((c) => d[c] ?? null)) });
      if (q.includes("SELECT DISTINCT toString(person_id) AS id")) return rows(["id"], [{ id: VISITOR.id }]);
      if (q.includes("FROM persons AS p")) return rows(Object.keys(VISITOR), [VISITOR]);
      if (q.includes("event = '$pageview'")) return rows(["session_id"], []);
      if (q.includes("NOT LIKE '$%'")) return rows(Object.keys(EVENTS[0]), EVENTS);
      throw new Error(`unexpected HogQL ${q}`);
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
  a.use(peopleRoutes);
  return a;
}
const asOrg = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);

async function wipe() {
  await db.execute(sql`DELETE FROM people WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM posthog_activities WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM contacts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM posthog_connections WHERE brand_id = ${BRAND}`);
}

describe.skipIf(!RUN)("a product's signup walk on the person (ONBOARDING-IN-UNIBOX-1015)", () => {
  beforeEach(async () => {
    installFetchStub();
    await wipe();
  });
  afterAll(async () => {
    await wipe();
  });

  it("a PostHog person known only by their website is 'Visitor from <domain>', each step on their thread with what they entered", async () => {
    const [conn] = await db
      .insert(posthogConnections)
      .values({
        orgId: ORG,
        brandId: BRAND,
        projectId: "1",
        region: "eu",
        status: "active",
        createdByUserId: USER,
        lastSyncedAt: new Date("2026-10-15T08:00:00Z"),
        syncedThrough: new Date("2026-10-15T08:00:00Z"),
      })
      .returning();

    const first = await mirrorRecentPersons(conn, new Date("2026-10-15T08:55:00Z"));
    expect(first).toMatchObject({ changed: ["ph-visitor"], created: 1 });
    // The fast mirror asks only who is KNOWN: a person set by none of these keys is never read.
    const touched = hogql.find((q) => q.includes("SELECT DISTINCT"))!;
    for (const k of ["email", "phone", "name", "first_name", "website"]) expect(touched).toContain(`$set.${k}`);

    const [c] = await db.select().from(contacts).where(eq(contacts.brandId, BRAND));
    expect(c).toMatchObject({ source: "posthog", externalId: "ph-visitor", primaryEmail: null, phoneE164: null, fullName: null });
    expect(c.rawAttributes).toMatchObject({ notSignup: true, website: "https://www.Acme.io/pricing" });
    const acts = await db.select().from(posthogActivities).where(eq(posthogActivities.brandId, BRAND)).orderBy(posthogActivities.occurredAt);
    expect(acts.map((a) => [a.name, (a.detail as { properties: unknown }).properties])).toEqual([
      ["get_started_website_submitted", { website: "acme.io" }],
      ["get_started_setup_chosen", { mode: "ai" }],
    ]);

    // A second minute with nothing new changes nothing.
    expect(await mirrorRecentPersons(conn, new Date("2026-10-15T08:56:00Z"))).toMatchObject({ changed: [], created: 0, eventsChanged: 0 });

    const { scope } = await ensureScope(ORG, BRAND, USER);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    const [person] = await db.select().from(people).where(eq(people.brandId, BRAND));
    expect(person).toMatchObject({ displayName: "Visitor from acme.io", sources: ["posthog"] });

    const list = await asOrg(request(app()).get(`/orgs/people?brandId=${BRAND}`));
    expect(list.status).toBe(200);
    expect(list.body.people.map((p: { displayName: string }) => p.displayName)).toEqual(["Visitor from acme.io"]);

    const tl = await asOrg(request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&personId=${person.personId}`));
    expect(tl.status).toBe(200);
    // No signup: they typed a website, they did not create an account.
    expect(tl.body.items.map((i: { text: string; event: { step: string; detail: { properties: unknown } } }) => [i.event.step, i.text, i.event.detail.properties])).toEqual([
      ["event", "Get started website submitted · website: acme.io", { website: "acme.io" }],
      ["event", "Get started setup chosen · mode: ai", { mode: "ai" }],
    ]);
  });
});
