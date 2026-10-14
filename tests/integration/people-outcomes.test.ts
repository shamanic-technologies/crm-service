import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { people, peopleFacts, peopleScopes } from "../../src/db/schema.js";
import peopleRoutes from "../../src/routes/people.js";
import { clearOutcomesCache } from "../../src/lib/people/outcomes.js";

/**
 * GET /orgs/people/outcomes + /orgs/people/outcomes/people against a real
 * Postgres (gated on CRM_TEST_DB). People rows and live facts are written
 * directly: the read is what is tested.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "acacacac-1111-4111-8111-000000000001";
const BRAND = "acacacac-1111-4111-8111-000000000002";
const USER = "user-outcomes-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "test-lead-key";

const lead = (email: string, firstName: string | null = null) => ({ email, lead: firstName ? { firstName, lastName: null } : null });
// lead-service's bucket of each step: the people OUR campaigns brought there.
let BUCKETS: Record<string, ReturnType<typeof lead>[]> = {};
let LEAD_DOWN = false;
let LEAD_CALLS = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubRuns() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "lead.test" && url.pathname === "/orgs/leads") {
      LEAD_CALLS += 1;
      if (LEAD_DOWN) return json({ error: "boom" }, 500);
      expect(url.searchParams.get("brandId")).toBe(BRAND);
      expect(url.searchParams.get("view")).toBe("compact");
      const all = BUCKETS[url.searchParams.get("bucket")!] ?? [];
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return json({ leads: all.slice(offset, offset + limit) });
    }
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

let seq = 0;
function fact(owner: string, type: string, source: string, occurredAt: string | null, payload: Record<string, unknown> = {}, live = true) {
  seq += 1;
  return {
    orgId: ORG,
    brandId: BRAND,
    personKey: owner,
    emails: [owner.replace("email:", "")],
    phones: [],
    fullName: null,
    type,
    occurredAt: occurredAt ? new Date(occurredAt) : null,
    dateBasis: "created",
    source,
    sourceRef: `${source}-${seq}`,
    payload,
    naturalKey: `${source}|${type}|${seq}`,
    family: source,
    contentHash: `h${seq}`,
    live,
    ownerPersonKey: owner,
  };
}

const paid = (amountMinor: number, amountRefunded: number | null, status = "succeeded") => ({
  amountMinor,
  currency: "usd",
  status,
  refunded: amountRefunded !== null && amountRefunded >= amountMinor,
  amountRefunded,
});

async function seed() {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();
  const person = (key: string, sources: string[], stateSource = "none") => ({
    scopeId: scope.id,
    orgId: ORG,
    brandId: BRAND,
    personKey: key,
    identityKeys: [key],
    displayName: key.slice(6, 9),
    emails: [key.replace("email:", "")],
    phones: [],
    sources,
    presences: [],
    mergeEvidence: [],
    state: "in_conversation",
    stateSource,
  });
  await db.insert(people).values([
    person("email:ann@x.com", ["clerk", "posthog", "instantly"], "lead_service"),
    person("email:bob@x.com", ["posthog"]),
    person("email:cat@x.com", ["stripe", "gohighlevel"]),
    person("email:dan@x.com", ["stripe"]),
    person("email:eve@x.com", ["stripe"]),
    person("email:fay@x.com", ["gohighlevel"]),
  ]);
  await db.insert(peopleFacts).values([
    // Ann: signed up on Clerk AND PostHog (one person), visited twice.
    fact("email:ann@x.com", "signup", "clerk", "2026-09-02T00:00:00Z"),
    fact("email:ann@x.com", "signup", "posthog", "2026-09-01T00:00:00Z"),
    fact("email:ann@x.com", "website_visit", "posthog", "2026-08-30T00:00:00Z"),
    fact("email:ann@x.com", "website_visit", "posthog", "2026-08-31T00:00:00Z"),
    // Bob: a visit, and a signup that was withdrawn.
    fact("email:bob@x.com", "website_visit", "posthog", "2026-08-29T00:00:00Z"),
    fact("email:bob@x.com", "signup", "posthog", "2026-08-29T00:00:00Z", {}, false),
    // Cat: a won deal AND a standing payment: one paid client. A form, a meeting.
    fact("email:cat@x.com", "sale", "gohighlevel", null, { amountMinor: 50000 }),
    fact("email:cat@x.com", "payment", "stripe", "2026-09-05T00:00:00Z", paid(9900, 0)),
    fact("email:cat@x.com", "form_submitted", "gohighlevel", "2026-09-01T00:00:00Z"),
    fact("email:cat@x.com", "meeting_booked", "gohighlevel", "2026-09-02T00:00:00Z"),
    fact("email:cat@x.com", "meeting_attended", "gohighlevel", "2026-09-03T00:00:00Z"),
    // Dan: wholly refunded + a failed one: not a paid client.
    fact("email:dan@x.com", "payment", "stripe", "2026-09-05T00:00:00Z", paid(9900, 9900)),
    fact("email:dan@x.com", "payment", "stripe", "2026-09-06T00:00:00Z", paid(9900, 0, "failed")),
    // Eve: partially refunded: still paid.
    fact("email:eve@x.com", "payment", "stripe", "2026-09-07T00:00:00Z", paid(9900, 1000)),
    // Fay: a stage meaning no-show, not a step here; a meeting booked.
    fact("email:fay@x.com", "meeting_not_held", "gohighlevel", "2026-09-04T00:00:00Z"),
    fact("email:fay@x.com", "meeting_booked", "gohighlevel", "2026-09-04T00:00:00Z"),
    // Another brand's fact never leaks in.
    { ...fact("email:zed@x.com", "signup", "clerk", "2026-09-01T00:00:00Z"), brandId: "acacacac-1111-4111-8111-000000000099" },
  ]);
}

describe.skipIf(!RUN)("people outcomes (all sources)", () => {
  const wipe = async () => {
    for (const b of [BRAND, "acacacac-1111-4111-8111-000000000099"]) {
      await db.delete(peopleFacts).where(and(eq(peopleFacts.orgId, ORG), eq(peopleFacts.brandId, b)));
    }
    await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  };
  beforeEach(async () => {
    BUCKETS = {};
    LEAD_DOWN = false;
    stubRuns();
    clearOutcomesCache();
    await wipe();
  });
  afterAll(wipe);

  it("DASH-LATENCY-1014: a re-read within seconds is served from cache; a new fact shows once the cache is past fresh", async () => {
    await seed();
    const read = () => asOrg(request(app()).get("/orgs/people/outcomes").query({ brandId: BRAND }));
    const visits = (r: request.Response) => r.body.steps.find((s: { step: string }) => s.step === "website_visit").people;
    const first = await read();
    expect(first.status).toBe(200);
    expect(visits(first)).toBe(2);
    const callsAfterFirst = LEAD_CALLS;
    expect(callsAfterFirst).toBe(6); // one bucket per step
    const again = await read();
    expect(again.body.steps).toEqual(first.body.steps);
    expect(LEAD_CALLS).toBe(callsAfterFirst); // nothing recomputed, lead-service not asked
    await db.insert(peopleFacts).values(fact("email:fay@x.com", "website_visit", "posthog", "2026-09-08T00:00:00Z"));
    const prev = { fresh: process.env.PEOPLE_OUTCOMES_FRESH_MS, stale: process.env.PEOPLE_OUTCOMES_MAX_STALE_MS };
    process.env.PEOPLE_OUTCOMES_FRESH_MS = "1";
    process.env.PEOPLE_OUTCOMES_MAX_STALE_MS = "1";
    try {
      await new Promise((r) => setTimeout(r, 5));
      const after = await read();
      expect(visits(after)).toBe(3);
      // Everything else unchanged: the cache never changes a figure, it only reuses one.
      expect(after.body.steps.filter((s: { step: string }) => s.step !== "website_visit")).toEqual(
        first.body.steps.filter((s: { step: string }) => s.step !== "website_visit"),
      );
    } finally {
      if (prev.fresh === undefined) delete process.env.PEOPLE_OUTCOMES_FRESH_MS;
      else process.env.PEOPLE_OUTCOMES_FRESH_MS = prev.fresh;
      if (prev.stale === undefined) delete process.env.PEOPLE_OUTCOMES_MAX_STALE_MS;
      else process.env.PEOPLE_OUTCOMES_MAX_STALE_MS = prev.stale;
    }
  });

  it("counts distinct people per step, any source, one person once", async () => {
    await seed();
    const r = await asOrg(request(app()).get("/orgs/people/outcomes").query({ brandId: BRAND }));
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.steps.map((s: { step: string }) => [s.step, s]));
    expect(r.body.steps.map((s: { step: string }) => s.step)).toEqual([
      "website_visit",
      "signup",
      "form_submission",
      "meeting_booked",
      "meeting_attended",
      "sale",
    ]);
    expect(by.website_visit).toEqual({ step: "website_visit", people: 2, sources: [{ source: "posthog", people: 2 }], contactedByUs: 1 });
    // Ann once though Clerk and PostHog both state it; Bob's withdrawn signup is gone.
    expect(by.signup.people).toBe(1);
    expect(by.signup.sources).toEqual([
      { source: "clerk", people: 1 },
      { source: "posthog", people: 1 },
    ]);
    expect(by.signup.contactedByUs).toBe(1);
    expect(by.form_submission.people).toBe(1);
    expect(by.meeting_booked.people).toBe(2);
    expect(by.meeting_attended.people).toBe(1);
    // Cat (deal won + payment, once) and Eve (partial refund); Dan refunded/failed is not.
    expect(by.sale.people).toBe(2);
    expect(by.sale.sources).toEqual([
      { source: "stripe", people: 2 },
      { source: "gohighlevel", people: 1 },
    ]);
    expect(by.sale.contactedByUs).toBe(0);
  });

  it("lists the people of a step, earliest first, paging to exactly the count", async () => {
    await seed();
    const first = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "signup" }));
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(1);
    expect(first.body.people[0]).toMatchObject({
      personKey: "email:ann@x.com",
      emails: ["ann@x.com"],
      reachedAt: "2026-09-01T00:00:00.000Z",
      sources: [
        { source: "posthog", reachedAt: "2026-09-01T00:00:00.000Z" },
        { source: "clerk", reachedAt: "2026-09-02T00:00:00.000Z" },
      ],
      contactedByUs: true,
    });

    const seen: string[] = [];
    for (let offset = 0; offset < 10; offset++) {
      const p = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "sale", limit: 1, offset }));
      expect(p.body.total).toBe(2);
      if (p.body.people.length === 0) break;
      seen.push(p.body.people[0].personKey);
    }
    // Undated GoHighLevel sale does not hide Cat's dated payment: her earliest date wins.
    expect(seen).toEqual(["email:cat@x.com", "email:eve@x.com"]);

    const visits = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "website_visit" }));
    expect(visits.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:bob@x.com", "email:ann@x.com"]);
  });

  it("adds the people our campaigns brought to each step: all sources is a superset, one person once", async () => {
    await seed();
    BUCKETS = {
      // Ann (already a PostHog visitor) + Gus, who clicked our email but never identified on PostHog.
      website_visit: [lead("ANN@x.com"), lead("gus@x.com", "Gus"), lead("gus@x.com", "Gus")],
      signup: [lead("ann@x.com")],
      // Dan's Stripe payment was refunded, but lead-service holds a sale for him.
      sale: [lead("dan@x.com")],
    };
    const r = await asOrg(request(app()).get("/orgs/people/outcomes").query({ brandId: BRAND }));
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.steps.map((s: { step: string }) => [s.step, s]));
    expect(by.website_visit).toEqual({
      step: "website_visit",
      people: 3,
      sources: [
        { source: "campaigns", people: 2 },
        { source: "posthog", people: 2 },
      ],
      contactedByUs: 2,
    });
    expect(by.signup.people).toBe(1);
    expect(by.sale.people).toBe(3);
    expect(by.sale.contactedByUs).toBe(1);

    const visits = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "website_visit" }));
    expect(visits.body.total).toBe(3);
    const gus = visits.body.people.find((p: { personKey: string }) => p.personKey === "email:gus@x.com");
    expect(gus).toMatchObject({ personId: null, displayName: "Gus", emails: ["gus@x.com"], reachedAt: null, contactedByUs: true, sources: [{ source: "campaigns", reachedAt: null }] });
    // Undated (campaigns-only) last.
    expect(visits.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:bob@x.com", "email:ann@x.com", "email:gus@x.com"]);
  });

  it("fails loud when lead-service cannot be read: never a count without our campaigns", async () => {
    await seed();
    LEAD_DOWN = true;
    const r = await asOrg(request(app()).get("/orgs/people/outcomes").query({ brandId: BRAND }));
    expect(r.status).toBe(502);
    expect(r.body.reason).toBe("campaign_outcomes_unavailable");
    const l = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "signup" }));
    expect(l.status).toBe(502);
  });

  it("refuses an unknown step and an unauthenticated call", async () => {
    expect((await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "sales" }))).status).toBe(400);
    expect((await asOrg(request(app()).get("/orgs/people/outcomes").query({ brandId: "nope" }))).status).toBe(400);
    expect((await request(app()).get("/orgs/people/outcomes").query({ brandId: BRAND })).status).toBe(401);
  });
});
