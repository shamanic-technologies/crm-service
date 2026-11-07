import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { people, peopleFacts, peopleScopes, clientMessageVerdicts } from "../../src/db/schema.js";
import peopleRoutes from "../../src/routes/people.js";
import { clearOutcomesCache } from "../../src/lib/people/outcomes.js";
import { judgeScope, type Judge } from "../../src/lib/people/client-satisfaction.js";

/**
 * CLIENT-SATISFIED-1107: a paying client's positive message = « Client Satisfied », judged by Jev (stubbed), served on
 * GET /orgs/people/outcomes(/people) as step client_satisfied. Real Postgres (gated on CRM_TEST_DB).
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "c5a7c5a7-1111-4111-8111-000000000001";
const BRAND = "c5a7c5a7-1111-4111-8111-000000000002";
const USER = "user-client-satisfied";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "test-lead-key";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "test-brand-key";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let RUNS_OPENED = 0;

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/runs") {
      RUNS_OPENED++;
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) return json({ id: "run-x" });
    if (url.host === "brand.test") return json({ offers: [] });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads") {
      // client_satisfied is no lead-service bucket: never asked for it.
      expect(url.searchParams.get("bucket")).not.toBe("client_satisfied");
      return json({ leads: [], nextCursor: null });
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
    dateBasis: "sent_at",
    source,
    sourceRef: `${source}-${seq}`,
    payload,
    naturalKey: `${source}|cs|${seq}`,
    family: source,
    contentHash: `h${seq}`,
    live,
    ownerPersonKey: owner,
  };
}
const paid = (status = "succeeded", refunded = 0) => ({ amountMinor: 10000, currency: "usd", status, amountRefunded: refunded, refunded: refunded >= 10000 });
const said = (text: string) => ({ channel: "whatsapp", text });

/** Jev stub: "amazing" / "love" = positive, "broken" = negative, else neutral. Records what it was asked. */
const ASKED: string[] = [];
const fakeJudge: Judge = async (state) => {
  const s = state as { messages: { id: string; text: string }[] };
  const answers: Record<string, { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }> = {};
  for (const m of s.messages) {
    ASKED.push(m.text);
    const probabilities = /amazing|love/i.test(m.text)
      ? { positive: 0.92, neutral: 0.06, negative: 0.02 }
      : /broken/i.test(m.text)
        ? { positive: 0.02, neutral: 0.1, negative: 0.88 }
        : { positive: 0.1, neutral: 0.85, negative: 0.05 };
    answers[m.id] = { type: "choice", choice: "x", confidence: 0.9, probabilities };
  }
  return { model: "jev-test", answers };
};

describe.skipIf(!RUN)("CLIENT-SATISFIED-1107 client_satisfied outcome (real DB)", () => {
  let scope: typeof peopleScopes.$inferSelect;
  const wipe = async () => {
    await db.delete(peopleFacts).where(eq(peopleFacts.orgId, ORG));
    await db.delete(clientMessageVerdicts).where(eq(clientMessageVerdicts.orgId, ORG));
    await db.delete(people).where(eq(people.orgId, ORG));
    await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  };
  beforeEach(async () => {
    ASKED.length = 0;
    RUNS_OPENED = 0;
    stubFetch();
    clearOutcomesCache();
    await wipe();
    [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();
    await db.insert(people).values(
      ["pam", "nat", "neo", "ref", "gil", "kev"].map((n) => ({
        scopeId: scope.id,
        orgId: ORG,
        brandId: BRAND,
        personKey: `email:${n}@x.com`,
        identityKeys: [`email:${n}@x.com`],
        displayName: n,
        // Kev is our staff: his person also holds an @distribute.you address.
        emails: n === "kev" ? [`${n}@x.com`, "ops+test@distribute.you"] : [`${n}@x.com`],
        phones: [],
        sources: ["stripe"],
        presences: [],
        mergeEvidence: [],
        state: "open",
        stateSource: "none",
      })),
    );
    await db.insert(peopleFacts).values([
      // Pam pays on 09-01: her "love it" of 08-01 was before (a positive reply, not a satisfied client).
      fact("email:pam@x.com", "payment", "stripe", "2026-09-01T00:00:00Z", paid()),
      fact("email:pam@x.com", "message_in", "matrix", "2026-08-01T00:00:00Z", said("I love it, how much?")),
      fact("email:pam@x.com", "message_out", "matrix", "2026-09-04T00:00:00Z", said("Your campaign is live")),
      fact("email:pam@x.com", "message_in", "matrix", "2026-09-05T00:00:00Z", said("You guys are amazing")),
      fact("email:pam@x.com", "message_in", "gmail", "2026-09-06T00:00:00Z", said("ok")),
      fact("email:pam@x.com", "message_in", "matrix", "2026-09-07T00:00:00Z", said("👍")),
      // Nat never paid: an amazing message is never judged, never counts.
      fact("email:nat@x.com", "message_in", "matrix", "2026-09-05T00:00:00Z", said("amazing product")),
      // Neo pays (CRM deal won, undated) and only writes neutral / negative.
      fact("email:neo@x.com", "sale", "gohighlevel", null, { amountMinor: 5000 }),
      fact("email:neo@x.com", "message_in", "gmail", "2026-09-05T00:00:00Z", said("Where is my invoice?")),
      fact("email:neo@x.com", "message_in", "gmail", "2026-09-06T00:00:00Z", said("The dashboard is broken")),
      // Ref paid then was refunded in full: no longer a paying client.
      fact("email:ref@x.com", "payment", "stripe", "2026-09-01T00:00:00Z", paid("succeeded", 10000)),
      fact("email:ref@x.com", "message_in", "matrix", "2026-09-05T00:00:00Z", said("amazing")),
      // Gil: a CRM `client` label (undated) and a positive email.
      fact("email:gil@x.com", "client", "gohighlevel", null, {}),
      fact("email:gil@x.com", "message_in", "gmail", "2026-10-02T00:00:00Z", said("Love working with you")),
      // Kev (staff) made a test payment and writes "amazing": staff is nobody's client, never judged.
      fact("email:kev@x.com", "payment", "stripe", "2026-09-01T00:00:00Z", paid()),
      fact("email:kev@x.com", "message_in", "gmail", "2026-09-05T00:00:00Z", said("amazing tool")),
    ]);
  });
  afterAll(wipe);

  it("judges only paying clients' messages since they became one; a positive one = client_satisfied", async () => {
    const r = await judgeScope(scope, fakeJudge);
    expect(r).toMatchObject({ judged: 5, positive: 2, noWords: 1, failedCalls: 0 });
    expect(RUNS_OPENED).toBe(1);
    // Never asked: a non-payer, a refunded payer, our staff, a message before paying, a message with no words.
    expect(ASKED.sort()).toEqual(["Love working with you", "The dashboard is broken", "Where is my invoice?", "You guys are amazing", "ok"]);

    const verdicts = await db.select().from(clientMessageVerdicts).where(eq(clientMessageVerdicts.orgId, ORG));
    expect(verdicts.map((v) => `${v.excerpt}=${v.verdict}`).sort()).toEqual([
      "Love working with you=positive",
      "The dashboard is broken=negative",
      "Where is my invoice?=neutral",
      "You guys are amazing=positive",
      "ok=neutral",
      "👍=no_words",
    ]);
    expect(verdicts.every((v) => v.verdict === "no_words" || (v.runId && v.model === "jev-test"))).toBe(true);

    // A second pass asks nothing: every message is judged once.
    const again = await judgeScope(scope, fakeJudge);
    expect(again).toMatchObject({ candidates: 0, judged: 0 });
    expect(RUNS_OPENED).toBe(1);
  });

  it("serves client_satisfied on the Outcomes read: paying + positive only, with the message behind it", async () => {
    await judgeScope(scope, fakeJudge);
    // A positive verdict stored for a NON-paying person never counts (the paying condition is re-checked at read).
    const [nat] = await db.select().from(peopleFacts).where(sql`${peopleFacts.orgId} = ${ORG} AND ${peopleFacts.ownerPersonKey} = 'email:nat@x.com'`);
    await db.insert(clientMessageVerdicts).values({
      orgId: ORG, brandId: BRAND, naturalKey: nat.naturalKey!, textHash: "x", verdict: "positive", pPositive: 0.9, source: "matrix", excerpt: "amazing product",
    });
    await db.execute(sql`UPDATE client_message_verdicts SET text_hash = md5('amazing product') WHERE natural_key = ${nat.naturalKey!}`);

    const r = await asOrg(request(app()).get("/orgs/people/outcomes").query({ brandId: BRAND }));
    expect(r.status).toBe(200);
    const step = r.body.steps.find((s: { step: string }) => s.step === "client_satisfied");
    expect(step).toMatchObject({ people: 2, contactedByUs: 0, undated: { people: 0, contactedByUs: 0 } });
    expect(step.sources).toEqual([
      { source: "gmail", people: 1 },
      { source: "matrix", people: 1 },
    ]);
    expect(step.months.find((m: { month: string }) => m.month === "2026-09").people).toBe(1);

    const list = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "client_satisfied" }));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.people.map((p: { personKey: string; reachedAt: string }) => [p.personKey, p.reachedAt])).toEqual([
      ["email:pam@x.com", "2026-09-05T00:00:00.000Z"],
      ["email:gil@x.com", "2026-10-02T00:00:00.000Z"],
    ]);
    expect(list.body.people[0].satisfiedBy).toEqual([
      expect.objectContaining({ excerpt: "You guys are amazing", source: "matrix", channel: "whatsapp", pPositive: 0.92 }),
    ]);
    // Other steps carry no satisfiedBy.
    const sale = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "sale" }));
    expect(sale.body.people.every((p: Record<string, unknown>) => !("satisfiedBy" in p))).toBe(true);
  });

  it("a refund that ends the paying status ends the outcome", async () => {
    await judgeScope(scope, fakeJudge);
    await db.execute(sql`UPDATE people_facts SET payload = payload || '{"amountRefunded": 10000, "refunded": true}'::jsonb
      WHERE org_id = ${ORG} AND owner_person_key = 'email:pam@x.com' AND type = 'payment'`);
    const list = await asOrg(request(app()).get("/orgs/people/outcomes/people").query({ brandId: BRAND, step: "client_satisfied" }));
    expect(list.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:gil@x.com"]);
  });
});
