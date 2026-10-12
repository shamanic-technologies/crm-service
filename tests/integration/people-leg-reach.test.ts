import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { ghlConnections, ghlRawRecords, people, peopleFacts, peopleScopes } from "../../src/db/schema.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * GET /internal/people/leg-reach (+ /brands) against a real Postgres (gated on
 * CRM_TEST_DB). Scopes, people and live facts are written directly: the read
 * is what is tested.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "1e91e91e-1111-4111-8111-000000000001";
const ORG2 = "1e91e91e-1111-4111-8111-000000000002";
const BRAND = "1e91e91e-1111-4111-8111-00000000000b";
const BRAND_NONE = "1e91e91e-1111-4111-8111-00000000000c";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubRuns() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
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
const get = (query: Record<string, string>) => request(app()).get("/internal/people/leg-reach").set("x-api-key", API_KEY).query(query);

type St = "ok" | "failed" | "not_connected";
const reads = (statuses: Record<string, St>) => ({
  sources: ["gmail", "instantly", "matrix", "gohighlevel", "posthog", "stripe", "clerk"].map((source) => ({
    source,
    status: statuses[source] ?? "not_connected",
  })),
});

let seq = 0;
function fact(org: string, owner: string, type: string, source: string, occurredAt: string | null, payload: Record<string, unknown> = {}) {
  seq += 1;
  return {
    orgId: org,
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
    live: true,
    ownerPersonKey: owner,
  };
}

async function scope(org: string, statuses: Record<string, St>, status = "built") {
  const [s] = await db
    .insert(peopleScopes)
    .values({
      orgId: org,
      brandId: BRAND,
      createdByUserId: "u",
      status,
      sourceReads: reads(statuses),
      lastBuiltAt: status === "built" ? new Date("2026-10-12T00:00:00Z") : null,
    })
    .returning();
  return s;
}

/** A GoHighLevel-only brand (Doc Dinners' shape). */
async function seedGhl() {
  const s = await scope(ORG, { gohighlevel: "ok", instantly: "ok" });
  const person = (key: string, sources: string[], extra: Record<string, unknown> = {}) => ({
    scopeId: s.id,
    orgId: ORG,
    brandId: BRAND,
    personKey: key,
    identityKeys: [key],
    emails: [key.replace("email:", "")],
    phones: [],
    sources,
    presences: [],
    mergeEvidence: [],
    state: "in_conversation",
    stateSource: "gohighlevel",
    ...extra,
  });
  await db.insert(people).values([
    person("email:a@x.com", ["gohighlevel"]),
    person("email:b@x.com", ["gohighlevel"]),
    person("email:c@x.com", ["gohighlevel"]),
    person("email:d@x.com", ["gohighlevel"]),
    person("email:e@x.com", ["gohighlevel", "instantly"]),
    person("email:f@x.com", ["gohighlevel"], { stateSource: "lead_service" }),
  ]);
  await db.insert(peopleFacts).values([
    // a: form then booking a day later: converts, dated on both ends.
    fact(ORG, "email:a@x.com", "form_submitted", "gohighlevel", "2026-09-01T10:00:00Z"),
    fact(ORG, "email:a@x.com", "form_submitted", "gohighlevel", "2026-09-03T10:00:00Z"),
    fact(ORG, "email:a@x.com", "meeting_booked", "gohighlevel", "2026-09-02T10:00:00Z"),
    // b: booking seconds BEFORE the form, same UTC day: counts.
    fact(ORG, "email:b@x.com", "meeting_booked", "gohighlevel", "2026-09-01T09:59:59Z"),
    fact(ORG, "email:b@x.com", "form_submitted", "gohighlevel", "2026-09-01T10:00:00Z"),
    // c: booked a week before the form, never after: toBeforeFrom.
    fact(ORG, "email:c@x.com", "meeting_booked", "gohighlevel", "2026-08-20T10:00:00Z"),
    fact(ORG, "email:c@x.com", "form_submitted", "gohighlevel", "2026-08-27T10:00:00Z"),
    // d: undated form, dated booking: counts (cannot be ordered).
    fact(ORG, "email:d@x.com", "form_submitted", "gohighlevel", null),
    fact(ORG, "email:d@x.com", "meeting_booked", "gohighlevel", "2026-09-05T10:00:00Z"),
    // e + f: our campaigns contacted them: out of the population.
    fact(ORG, "email:e@x.com", "form_submitted", "gohighlevel", "2026-09-01T00:00:00Z"),
    fact(ORG, "email:e@x.com", "meeting_booked", "gohighlevel", "2026-09-02T00:00:00Z"),
    fact(ORG, "email:f@x.com", "form_submitted", "gohighlevel", "2026-09-01T00:00:00Z"),
    // g: left the people index since: kept (nothing says we contacted them), no booking.
    fact(ORG, "email:g@x.com", "form_submitted", "gohighlevel", "2026-09-04T00:00:00Z"),
  ]);
}

describe.skipIf(!RUN)("people leg reach (the brand's own team per leg)", () => {
  const wipe = async () => {
    await db.delete(peopleFacts).where(inArray(peopleFacts.orgId, [ORG, ORG2]));
    await db.delete(ghlConnections).where(inArray(ghlConnections.orgId, [ORG, ORG2]));
    await db.delete(peopleScopes).where(inArray(peopleScopes.orgId, [ORG, ORG2]));
  };
  beforeEach(async () => {
    stubRuns();
    await wipe();
  });
  afterAll(wipe);

  it("form -> booked: of the team's own form fillers, how many booked, dated, sources named", async () => {
    await seedGhl();
    const r = await get({ brandId: BRAND, from: "form_submitted", to: "meeting_booked" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      brandId: BRAND,
      orgId: ORG,
      fromStep: "form_submission",
      toStep: "meeting_booked",
      available: true,
      reason: null,
      reasons: [],
      connectedSources: ["instantly", "gohighlevel"],
      stepSources: { from: ["gohighlevel"], to: ["gohighlevel"] },
    });
    expect(r.body.reachedFrom).toEqual({
      people: 5,
      undated: 1,
      byDay: [
        { day: "2026-08-27", people: 1 },
        { day: "2026-09-01", people: 2 },
        { day: "2026-09-04", people: 1 },
      ],
      sources: [{ source: "gohighlevel", people: 5 }],
    });
    expect(r.body.reachedTo).toEqual({
      people: 3,
      undated: 0,
      byDay: [
        { day: "2026-09-01", people: 1 },
        { day: "2026-09-02", people: 1 },
        { day: "2026-09-05", people: 1 },
      ],
      sources: [{ source: "gohighlevel", people: 3 }],
      toBeforeFrom: 1,
    });
    expect(r.body.excluded).toEqual({ contactedByUs: 2, automated: 0, notBusiness: 0 });
  });

  it("a submission of a calendar's own booking form is the booking, never a form step", async () => {
    await seedGhl();
    const [conn] = await db
      .insert(ghlConnections)
      .values({ orgId: ORG, brandId: BRAND, locationId: "loc", createdByUserId: "u" })
      .returning();
    // The calendar collects its bookers' details with form CAL-FORM; LEAD-FORM is a lead form.
    await db.insert(ghlRawRecords).values({
      orgId: ORG,
      brandId: BRAND,
      connectionId: conn.id,
      kind: "calendar",
      externalId: "cal-1",
      contentHash: "c1",
      payload: { id: "cal-1", name: "Event Calendar", formId: "CAL-FORM" },
    });
    await db.insert(peopleFacts).values([
      // h: only ever filled the calendar's form = only ever booked: not a form filler.
      fact(ORG, "email:h@x.com", "form_submitted", "gohighlevel", "2026-09-06T10:00:00Z", { via: "form_submission", formId: "CAL-FORM" }),
      fact(ORG, "email:h@x.com", "meeting_booked", "gohighlevel", "2026-09-06T10:00:01Z"),
      // i: lead form first, then the calendar's form a week later: FROM on the lead form's day.
      fact(ORG, "email:i@x.com", "form_submitted", "gohighlevel", "2026-09-10T10:00:00Z", { via: "form_submission", formId: "LEAD-FORM" }),
      fact(ORG, "email:i@x.com", "form_submitted", "gohighlevel", "2026-09-17T10:00:00Z", { via: "form_submission", formId: "CAL-FORM" }),
      fact(ORG, "email:i@x.com", "meeting_booked", "gohighlevel", "2026-09-17T10:00:01Z"),
      // j: a contact a form created (no form named): a form step.
      fact(ORG, "email:j@x.com", "form_submitted", "gohighlevel", "2026-09-12T10:00:00Z", { via: "form_origin", formId: null }),
    ]);
    const r = await get({ brandId: BRAND, from: "form_submitted", to: "meeting_booked" });
    expect(r.status).toBe(200);
    // seedGhl's 5 + i + j; h is out.
    expect(r.body.reachedFrom.people).toBe(7);
    expect(r.body.reachedFrom.byDay).toEqual(
      expect.arrayContaining([
        { day: "2026-09-10", people: 1 },
        { day: "2026-09-12", people: 1 },
      ]),
    );
    expect(r.body.reachedFrom.byDay.map((d: { day: string }) => d.day)).not.toContain("2026-09-06");
    expect(r.body.reachedFrom.byDay.map((d: { day: string }) => d.day)).not.toContain("2026-09-17");
    expect(r.body.reachedTo.people).toBe(4);
    expect(r.body.reachedTo.byDay).toEqual(expect.arrayContaining([{ day: "2026-09-17", people: 1 }]));

    // Without the calendar record, h's submission is a form step like any other.
    await db.delete(ghlRawRecords).where(inArray(ghlRawRecords.connectionId, [conn.id]));
    const raw = await get({ brandId: BRAND, from: "form_submitted", to: "meeting_booked" });
    expect(raw.body.reachedFrom.people).toBe(8);
  });

  it("conversation -> booked on a CRM-only brand: a named reason, never 0", async () => {
    await seedGhl();
    const r = await get({ brandId: BRAND, from: "conversation", to: "meeting_booked" });
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(r.body.reason).toBe("from_step_not_recorded");
    expect(r.body.reasons).toEqual([
      expect.objectContaining({ code: "from_step_not_recorded", step: "conversation", recordedBy: ["gmail", "matrix"] }),
    ]);
    expect(r.body.reachedFrom).toBeUndefined();
    const both = await get({ brandId: BRAND, from: "website_visit", to: "paid_client" });
    expect(both.body.reasons.map((x: { code: string }) => x.code)).toEqual(["from_step_not_recorded"]);
    const toMissing = await get({ brandId: BRAND, from: "form_submission", to: "signup" });
    expect(toMissing.body.reason).toBe("to_step_not_recorded");
  });

  it("conversation = the person wrote, the people layer kept the thread; nobody and our leads are out", async () => {
    const s = await scope(ORG, { gmail: "ok", matrix: "ok", stripe: "ok" });
    const person = (key: string, extra: Record<string, unknown> = {}) => ({
      scopeId: s.id,
      orgId: ORG,
      brandId: BRAND,
      personKey: key,
      identityKeys: [key],
      emails: [],
      phones: [],
      sources: ["gmail"],
      presences: [],
      mergeEvidence: [],
      state: "in_conversation",
      stateSource: "gmail",
      ...extra,
    });
    await db.insert(people).values([
      person("email:p@x.com"),
      person("email:q@x.com", { automated: true }),
      person("email:r@x.com", { notBusiness: true }),
      person("email:s@x.com"),
    ]);
    await db.insert(peopleFacts).values([
      fact(ORG, "email:p@x.com", "message_in", "matrix", "2026-09-01T00:00:00Z"),
      fact(ORG, "email:p@x.com", "payment", "stripe", "2026-09-10T00:00:00Z", { status: "succeeded", amountMinor: 900, amountRefunded: 0 }),
      fact(ORG, "email:q@x.com", "message_in", "gmail", "2026-09-01T00:00:00Z"),
      fact(ORG, "email:r@x.com", "message_in", "gmail", "2026-09-01T00:00:00Z"),
      // s only wrote TO them: not a conversation step.
      fact(ORG, "email:s@x.com", "message_out", "gmail", "2026-09-01T00:00:00Z"),
    ]);
    const r = await get({ brandId: BRAND, from: "conversation", to: "sale" });
    expect(r.body.available).toBe(true);
    expect(r.body.reachedFrom.people).toBe(1);
    expect(r.body.reachedFrom.sources).toEqual([{ source: "matrix", people: 1 }]);
    expect(r.body.reachedTo).toMatchObject({ people: 1, byDay: [{ day: "2026-09-10", people: 1 }], sources: [{ source: "stripe", people: 1 }] });
    expect(r.body.excluded).toEqual({ contactedByUs: 0, automated: 1, notBusiness: 1 });
  });

  it("no scope / never built / connected but never read: named reasons", async () => {
    const none = await get({ brandId: BRAND_NONE, from: "signup", to: "sale" });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ available: false, reason: "no_people_scope", scope: null, orgId: null });

    await scope(ORG, {}, "pending");
    expect((await get({ brandId: BRAND, from: "signup", to: "sale" })).body.reason).toBe("not_synced");
    await wipe();

    await scope(ORG, { instantly: "ok" });
    expect((await get({ brandId: BRAND, from: "signup", to: "sale" })).body.reason).toBe("no_connected_source");
    await wipe();

    await scope(ORG, { clerk: "ok", stripe: "failed" });
    const r = await get({ brandId: BRAND, from: "signup", to: "sale" });
    expect(r.body.reasons).toEqual([expect.objectContaining({ code: "not_synced", step: "sale", recordedBy: ["gohighlevel", "stripe"] })]);
  });

  it("a brand held by two orgs: the one that can answer wins; two that can → 409 unless orgId", async () => {
    await seedGhl();
    await scope(ORG2, { instantly: "ok" });
    const r = await get({ brandId: BRAND, from: "form_submission", to: "meeting_booked" });
    expect(r.body.orgId).toBe(ORG);
    expect(r.body.reachedFrom.people).toBe(5);

    await db.delete(peopleScopes).where(inArray(peopleScopes.orgId, [ORG2]));
    await scope(ORG2, { stripe: "ok" });
    const amb = await get({ brandId: BRAND, from: "form_submission", to: "meeting_booked" });
    expect(amb.status).toBe(409);
    expect(amb.body.orgIds.sort()).toEqual([ORG, ORG2].sort());
    const pinned = await get({ brandId: BRAND, from: "form_submission", to: "meeting_booked", orgId: ORG2 });
    expect(pinned.body).toMatchObject({ orgId: ORG2, available: false, reason: "from_step_not_recorded" });
  });

  it("lists every brand with the steps it can answer", async () => {
    await seedGhl();
    const r = await request(app()).get("/internal/people/leg-reach/brands").set("x-api-key", API_KEY);
    expect(r.status).toBe(200);
    expect(r.body.steps[0]).toBe("conversation");
    expect(r.body.brands.find((b: { orgId: string }) => b.orgId === ORG)).toEqual({
      orgId: ORG,
      brandId: BRAND,
      scopeStatus: "built",
      lastBuiltAt: "2026-10-12T00:00:00.000Z",
      connectedSources: ["instantly", "gohighlevel"],
      recordedSteps: ["form_submission", "meeting_booked", "meeting_attended", "sale"],
    });
  });

  it("refuses bad input and an unauthenticated call", async () => {
    expect((await get({ brandId: BRAND, from: "signup", to: "signup" })).status).toBe(400);
    expect((await get({ brandId: BRAND, from: "signups", to: "sale" })).status).toBe(400);
    expect((await get({ brandId: "nope", from: "signup", to: "sale" })).status).toBe(400);
    expect((await request(app()).get("/internal/people/leg-reach").query({ brandId: BRAND, from: "signup", to: "sale" })).status).toBe(401);
  });
});
