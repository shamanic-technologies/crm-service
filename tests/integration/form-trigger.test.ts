import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { formOfferMappings, formTriggerReports, ghlConnections, ghlRawRecords } from "../../src/db/schema.js";
import formTriggerRoutes from "../../src/routes/form-triggers.js";
import { runFormWatchPass } from "../../src/lib/form-trigger/watch.js";

/**
 * The form-trigger watch end to end against a real database. GoHighLevel,
 * key-service, brand-service, runs-service and campaign-service are stubbed at
 * `fetch`, with the shapes they answered in prod on 2026-10-12.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "cdcdcdcd-1111-4111-8111-000000000001";
const BRAND = "cdcdcdcd-1111-4111-8111-000000000002";
const OFFER_A = "cdcdcdcd-1111-4111-8111-0000000000a1";
const OFFER_B = "cdcdcdcd-1111-4111-8111-0000000000b1";
const USER = "user-form-1";
const LOCATION = "loc-form-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const META_FORM = "rfJqRLuLSDXDxfbEcA1T";
const BOOKING_FORM = "2zxohOKaAPBeQivGIHSM";

process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
// The post-detection GoHighLevel sync + people build runs behind the pass; off here.
process.env.FORM_TRIGGER_REFRESH = "off";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let submissions: Record<string, unknown>[] = [];
let offers: { offerId: string; name: string; description: null; status: string }[] = [];
let campaignCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
let campaignAnswer: () => Response = () => json({}, 500);

function submission(id: string, createdAt: string, formId = META_FORM, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Person ${id}`,
    email: `${id}@example.com`,
    formId,
    contactId: `contact-${id}`,
    createdAt,
    others: { phone: "+15550100199", fieldsOriSequance: ["MfQa5Fl4DCvkUHR3wZrE", "button"], MfQa5Fl4DCvkUHR3wZrE: "Chiropractor", ...extra },
  };
}

function installFetchStub() {
  campaignCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.pathname.includes("/gohighlevel/decrypt")) return json({ key: "pit-token" });
    if (url.host === "services.leadconnectorhq.com") {
      if (url.pathname === "/forms/submissions") {
        expect(url.searchParams.get("locationId")).toBe(LOCATION);
        return json({ submissions, meta: { total: submissions.length, nextPage: null } });
      }
      if (url.pathname === `/locations/${LOCATION}/customFields`) {
        return json({ customFields: [{ id: "MfQa5Fl4DCvkUHR3wZrE", name: "Which profession best describes you?" }] });
      }
      if (url.pathname === "/forms/") return json({ forms: [{ id: META_FORM, name: "Meta Ads" }], total: 1 });
    }
    if (url.host === "brand.test" && url.pathname.endsWith("/offers")) return json({ offers });
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      campaignCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return campaignAnswer();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(formTriggerRoutes);
  return a;
}

const T0 = Date.parse("2026-10-12T15:00:00Z");
const min = (n: number) => T0 + n * 60_000;

async function reports() {
  return db.select().from(formTriggerReports).where(eq(formTriggerReports.brandId, BRAND));
}

describe.skipIf(!RUN)("form trigger watch", () => {
  let connId: string;

  beforeEach(async () => {
    await db.delete(formTriggerReports).where(eq(formTriggerReports.brandId, BRAND));
    await db.delete(formOfferMappings).where(eq(formOfferMappings.brandId, BRAND));
    await db.delete(ghlConnections).where(eq(ghlConnections.brandId, BRAND));
    const [conn] = await db
      .insert(ghlConnections)
      .values({ orgId: ORG, brandId: BRAND, locationId: LOCATION, createdByUserId: USER, status: "active" })
      .returning();
    connId = conn.id;
    // A mirrored calendar whose booking form is BOOKING_FORM.
    await db.insert(ghlRawRecords).values({
      orgId: ORG, brandId: BRAND, connectionId: connId, kind: "calendar", externalId: "cal-1",
      contentHash: "h", payload: { id: "cal-1", name: "Free Consultation", formId: BOOKING_FORM },
    });
    offers = [{ offerId: OFFER_A, name: "A", description: null, status: "active" }];
    submissions = [submission("old-1", "2026-10-11T09:00:00.000Z")];
    campaignAnswer = () => json({ event: { id: `ev-${campaignCalls.length}`, status: "done", outcome: "skipped", skipReason: "no_campaign", processedAt: new Date(min(1)).toISOString() }, replayed: false }, 201);
    installFetchStub();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(formTriggerReports).where(eq(formTriggerReports.brandId, BRAND));
    await db.delete(formOfferMappings).where(eq(formOfferMappings.brandId, BRAND));
    await db.delete(ghlConnections).where(eq(ghlConnections.brandId, BRAND));
  });

  it("the first look is a baseline: history (the first-sync backlog) is never reported", async () => {
    const pass = await runFormWatchPass(T0);
    expect(pass.connections.find((c) => c.connectionId === connId)).toMatchObject({ baseline: true, detected: 0 });
    const [conn] = await db.select().from(ghlConnections).where(eq(ghlConnections.id, connId));
    expect(conn.formWatchSince?.getTime()).toBe(T0);
    await runFormWatchPass(min(1));
    expect(await reports()).toHaveLength(0);
    expect(campaignCalls).toHaveLength(0);
  });

  it("a new submission is reported once, with the person and what they asked", async () => {
    await runFormWatchPass(T0);
    submissions = [submission("new-1", new Date(min(1) + 5_000).toISOString()), ...submissions];
    await runFormWatchPass(min(2));
    await runFormWatchPass(min(3));
    await runFormWatchPass(min(30));

    expect(campaignCalls).toHaveLength(1);
    const call = campaignCalls[0];
    expect(call.headers.get("x-org-id")).toBe(ORG);
    expect(call.headers.get("x-user-id")).toBe(USER);
    expect(call.headers.get("x-run-id")).toMatch(/^run-/);
    expect(call.body).toMatchObject({
      triggerId: "form_submitted",
      brandId: BRAND,
      offerId: OFFER_A,
      idempotencyKey: "crm:gohighlevel:form_submission:new-1",
    });
    expect(call.body.person).toEqual({ email: "new-1@example.com", name: "Person new-1", phone: "+15550100199", crmContact: { provider: "gohighlevel", contactId: "contact-new-1" } });
    expect(JSON.stringify(call.body)).toContain("Which profession best describes you?");
    expect(JSON.stringify(call.body)).toContain("Meta Ads");

    const [r] = await reports();
    expect(r).toMatchObject({ status: "reported", submissionId: "new-1", campaignEventId: "ev-1", offerId: OFFER_A, formName: "Meta Ads" });
    expect(r.detectedAt.getTime()).toBe(min(2));

    const res = await request(app()).get(`/orgs/gohighlevel/form-triggers?brandId=${BRAND}`).set("x-api-key", API_KEY).set("x-org-id", ORG);
    expect(res.status).toBe(200);
    expect(res.body.reports[0]).toMatchObject({ submissionId: "new-1", status: "reported", campaignEventId: "ev-1" });
  });

  it("a calendar's booking form is the booking: recorded skipped, never reported", async () => {
    await runFormWatchPass(T0);
    submissions = [
      submission("book-1", new Date(min(1)).toISOString(), BOOKING_FORM),
      submission("book-2", new Date(min(1)).toISOString(), "other-calendar-form", { internalSource: { type: "calendars" } }),
    ];
    await runFormWatchPass(min(2));
    expect(campaignCalls).toHaveLength(0);
    const rows = await reports();
    expect(rows.map((r) => [r.submissionId, r.status, r.reason]).sort()).toEqual([
      ["book-1", "skipped", "calendar_booking_form"],
      ["book-2", "skipped", "calendar_booking_form"],
    ]);
  });

  it("several offers and none stated: loud offer_unknown, then reported once an offer is stated", async () => {
    offers = [
      { offerId: OFFER_A, name: "A", description: null, status: "active" },
      { offerId: OFFER_B, name: "B", description: null, status: "active" },
    ];
    await runFormWatchPass(T0);
    submissions = [submission("multi-1", new Date(min(1)).toISOString())];
    await runFormWatchPass(min(2));
    expect(campaignCalls).toHaveLength(0);
    expect((await reports())[0]).toMatchObject({ status: "failed", reason: "offer_unknown", attempts: 1 });

    const put = await request(app())
      .put("/orgs/gohighlevel/form-offers")
      .set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER)
      .send({ brandId: BRAND, formId: META_FORM, offerId: OFFER_B });
    expect(put.status).toBe(200);
    const refused = await request(app())
      .put("/orgs/gohighlevel/form-offers")
      .set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER)
      .send({ brandId: BRAND, offerId: "cdcdcdcd-1111-4111-8111-0000000000c1" });
    expect(refused.status).toBe(422);

    await runFormWatchPass(min(2) + 30_000); // inside the 1-min backoff: not retried
    expect(campaignCalls).toHaveLength(0);
    await runFormWatchPass(min(4));
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0].body.offerId).toBe(OFFER_B);
    expect((await reports())[0]).toMatchObject({ status: "reported" });
  });

  it("an outage is retried with backoff under the same idempotency key; a 400 is final; a day late is given up", async () => {
    await runFormWatchPass(T0);
    submissions = [submission("retry-1", new Date(min(1)).toISOString())];
    campaignAnswer = () => json({}, 503);
    await runFormWatchPass(min(2));
    expect((await reports())[0]).toMatchObject({ status: "failed", reason: "campaign_unreachable", attempts: 1 });

    campaignAnswer = () => json({ event: { id: "ev-ok", outcome: "ran", processedAt: new Date(min(4)).toISOString() }, replayed: false }, 201);
    await runFormWatchPass(min(4));
    expect(campaignCalls.map((c) => c.body.idempotencyKey)).toEqual([
      "crm:gohighlevel:form_submission:retry-1",
      "crm:gohighlevel:form_submission:retry-1",
    ]);
    expect((await reports())[0]).toMatchObject({ status: "reported", campaignEventId: "ev-ok", attempts: 2 });

    submissions = [submission("bad-1", new Date(min(5)).toISOString())];
    campaignAnswer = () => json({ error: "bad body", reason: "validation" }, 400);
    await runFormWatchPass(min(6));
    const afterBad = campaignCalls.length;
    await runFormWatchPass(min(30));
    expect(campaignCalls.length).toBe(afterBad);
    expect((await reports()).find((r) => r.submissionId === "bad-1")).toMatchObject({ status: "failed", reason: "campaign_refused", attempts: 1 });

    submissions = [submission("late-1", new Date(min(31)).toISOString())];
    campaignAnswer = () => json({}, 503);
    await runFormWatchPass(min(32));
    const calls = campaignCalls.length;
    await runFormWatchPass(min(31) + 25 * 3_600_000);
    expect(campaignCalls.length).toBe(calls);
  });

  it("a fill with no email is reported by its E.164 phone (REPLY-PHONE-ONLY-1015); neither = skipped no_email_or_phone, never sent", async () => {
    await runFormWatchPass(T0);
    const s = submission("phone-only", new Date(min(1)).toISOString()) as Record<string, unknown>;
    delete s.email;
    const n = submission("nobody", new Date(min(1)).toISOString(), META_FORM, { phone: "06 12 34 56 78" }) as Record<string, unknown>;
    delete n.email;
    submissions = [s, n];
    const pass = await runFormWatchPass(min(2));
    expect(pass.connections.find((c) => c.connectionId === connId)).toMatchObject({ detected: 1, skippedNoEmail: 1 });
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0].body.person).toEqual({ name: "Person phone-only", phone: "+15550100199", crmContact: { provider: "gohighlevel", contactId: "contact-phone-only" } });
    const rows = await reports();
    expect(rows.find((r) => r.submissionId === "phone-only")).toMatchObject({ status: "reported", email: null, phone: "+15550100199" });
    expect(rows.find((r) => r.submissionId === "nobody")).toMatchObject({ status: "skipped", reason: "no_email_or_phone" });
  });

  it("a paused connection is not watched", async () => {
    await runFormWatchPass(T0);
    await db.update(ghlConnections).set({ status: "paused" }).where(eq(ghlConnections.id, connId));
    submissions = [submission("paused-1", new Date(min(1)).toISOString())];
    await runFormWatchPass(min(2));
    expect(await reports()).toHaveLength(0);
    await db.delete(ghlRawRecords).where(inArray(ghlRawRecords.connectionId, [connId]));
  });
});
