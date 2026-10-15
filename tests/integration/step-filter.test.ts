import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  contactServes,
  crmLabelVerdicts,
  ghlConnections,
  ghlOpportunityHistory,
  people,
  peopleFacts,
  peopleScopes,
} from "../../src/db/schema.js";
import contactRoutes from "../../src/routes/contacts.js";
import { labelEventsQuery, type LabelEventRow } from "../../src/lib/gohighlevel/label-verdicts.js";

/**
 * CRM-WARM-NURTURE-1015: a CRM label (stage, tag) Jev judged `client` /
 * `disqualified` becomes evidence, and the SERVING PIPE's `stepFilter` (stated by
 * its play's workflow) serves only "reached a form or a meeting, never a sale,
 * never disqualified", on both pools. Real Postgres (gated on CRM_TEST_DB).
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "7d7d7d7d-1111-4111-8111-000000000001";
const BRAND = "7d7d7d7d-1111-4111-8111-000000000002";
const UPLOAD = "7d7d7d7d-1111-4111-8111-000000000003";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const WARM = {
  reached: ["form_submission", "meeting_booked", "meeting_attended", "meeting_not_held"],
  notReached: ["sale", "disqualified"],
};

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
  a.use(contactRoutes);
  return a;
}
const asOrg = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG);

const email = (name: string) => `${name}@step.test`;
const key = (name: string) => `email:${email(name)}`;

/** Who is in the brand's people index, and the step facts each holds. */
const PEOPLE: { name: string; facts: string[] }[] = [
  { name: "warm", facts: ["form_submitted"] }, // in
  { name: "noshow", facts: ["meeting_booked", "meeting_not_held"] }, // in
  { name: "tagclient", facts: ["form_submitted", "client"] }, // out: the CRM labels them a client
  { name: "dq", facts: ["form_submitted", "disqualified"] }, // out: disqualified
  { name: "sold", facts: ["meeting_attended", "sale"] }, // out: a client
  { name: "cold", facts: [] }, // out: never reached a form or a meeting
];

let connectionId = "";

async function seed() {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "u", status: "built" }).returning();
  const [conn] = await db.insert(ghlConnections).values({ orgId: ORG, brandId: BRAND, locationId: "loc-step", createdByUserId: "u" }).returning();
  connectionId = conn.id;
  for (const [n, p] of PEOPLE.entries()) {
    await db.insert(people).values({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personKey: key(p.name),
      identityKeys: [key(p.name)],
      displayName: p.name,
      emails: [email(p.name)],
      phones: [],
      sources: ["gohighlevel"],
      presences: [],
      mergeEvidence: [],
      state: "in_conversation",
      stateSource: "gohighlevel",
      firstActivityAt: new Date(`2026-09-${String(n + 1).padStart(2, "0")}T00:00:00Z`),
    });
    for (const [i, type] of p.facts.entries()) {
      await db.insert(peopleFacts).values({
        orgId: ORG,
        brandId: BRAND,
        personKey: key(p.name),
        emails: [email(p.name)],
        phones: [],
        type,
        occurredAt: null,
        dateBasis: "test",
        source: "gohighlevel",
        sourceRef: `${p.name}-${i}`,
        payload: {},
        naturalKey: `step|${p.name}|${i}`,
        family: "ghl_funnel",
        contentHash: `h-${p.name}-${i}`,
        live: true,
        ownerPersonKey: key(p.name),
      });
    }
  }
}

async function wipe() {
  await db.delete(contactServes).where(eq(contactServes.brandId, BRAND));
  await db.delete(peopleFacts).where(eq(peopleFacts.brandId, BRAND));
  await db.delete(people).where(eq(people.brandId, BRAND));
  await db.delete(contacts).where(eq(contacts.brandId, BRAND));
  await db.delete(ghlConnections).where(eq(ghlConnections.brandId, BRAND)); // cascades history + verdicts
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
}

const served = (body: { contacts: { primaryEmail: string }[] }) => body.contacts.map((c) => c.primaryEmail).sort();

describe.skipIf(!RUN)("the serving pipe's step filter (CRM-WARM-NURTURE-1015)", () => {
  beforeEach(async () => {
    stubRuns();
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it("people pool: serves only warm people who never became clients and were never disqualified", async () => {
    const r = await asOrg(request(app()).post("/orgs/contacts/serve-next").send({ brandId: BRAND, limit: 50, people: {}, stepFilter: WARM }));
    expect(r.status).toBe(200);
    expect(served(r.body)).toEqual([email("noshow"), email("warm")]);
    // Nobody refused was burned: the plain pool still serves them.
    const rest = await asOrg(request(app()).post("/orgs/contacts/serve-next").send({ brandId: BRAND, limit: 50, people: {} }));
    expect(served(rest.body)).toEqual([email("cold"), email("dq"), email("sold"), email("tagclient")]);
  });

  it("is ANDed with the audience's own filter, and clients stay out even when only notReached is stated", async () => {
    const both = await asOrg(
      request(app())
        .post("/orgs/contacts/serve-next")
        .send({ brandId: BRAND, limit: 50, people: { segment: { reached: ["meeting_not_held"] } }, stepFilter: WARM }),
    );
    expect(served(both.body)).toEqual([email("noshow")]);
    const onlyNot = await asOrg(
      request(app()).get("/orgs/contacts/serve-stats").query({ brandId: BRAND, pool: "people", stepFilter: JSON.stringify({ notReached: ["disqualified"] }) }),
    );
    // warm, noshow (served just above), cold: tagclient and sold are clients, dq disqualified.
    expect(onlyNot.body).toMatchObject({ served: 1, remainingSendable: 2, totalSendable: 3 });
  });

  it("serve-stats counts the same population", async () => {
    const r = await asOrg(request(app()).get("/orgs/contacts/serve-stats").query({ brandId: BRAND, pool: "people", stepFilter: JSON.stringify(WARM) }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ served: 0, remainingSendable: 2, totalSendable: 2 });
  });

  it("still-fits names why a person left the pipe's steps", async () => {
    const dq = await asOrg(request(app()).post("/orgs/contacts/still-fits").send({ brandId: BRAND, email: email("dq"), people: {}, stepFilter: WARM }));
    expect(dq.body.fits).toBe(false);
    expect(dq.body.failed.map((f: { code: string }) => f.code)).toEqual(["step_not_reached"]);
    const tc = await asOrg(request(app()).post("/orgs/contacts/still-fits").send({ brandId: BRAND, email: email("tagclient"), people: {}, stepFilter: WARM }));
    expect(tc.body.failed.map((f: { code: string }) => f.code)).toEqual(["step_not_reached", "step_client"]);
    const ok = await asOrg(request(app()).post("/orgs/contacts/still-fits").send({ brandId: BRAND, email: email("warm"), people: {}, stepFilter: WARM }));
    expect(ok.body).toEqual({ fits: true, pool: "people" });
  });

  it("CSV pool: a row is judged on the person holding its address", async () => {
    for (const name of ["warm", "dq", "csvonly"]) {
      await db.insert(contacts).values({
        orgId: ORG,
        brandId: BRAND,
        source: "csv",
        primaryEmail: email(name),
        rawAttributes: {},
        consentStatus: "unknown",
        unsubscribed: false,
        sourceUploadId: UPLOAD,
        sourceRowId: sql`gen_random_uuid()` as unknown as string,
      });
    }
    const warm = await asOrg(request(app()).post("/orgs/contacts/serve-next").send({ brandId: BRAND, limit: 50, stepFilter: WARM }));
    expect(served(warm.body)).toEqual([email("warm")]);
    expect(warm.body.exhausted).toBe(true);
    const notDq = await asOrg(
      request(app()).get("/orgs/contacts/serve-stats").query({ brandId: BRAND, stepFilter: JSON.stringify({ notReached: ["disqualified"] }) }),
    );
    // warm (served), csvonly (nobody knows them: reached nothing); dq out.
    expect(notDq.body).toMatchObject({ remainingSendable: 1, totalSendable: 2 });
    const fits = await asOrg(request(app()).post("/orgs/contacts/still-fits").send({ brandId: BRAND, email: email("dq"), stepFilter: WARM }));
    expect(fits.body.failed.map((f: { code: string }) => f.code)).toEqual(["step_filter"]);
  });

  it("refuses an unknown step or an empty filter", async () => {
    for (const stepFilter of [{ reached: ["closed client"] }, {}, { reached: [] }]) {
      const r = await asOrg(request(app()).post("/orgs/contacts/serve-next").send({ brandId: BRAND, people: {}, stepFilter }));
      expect(r.status).toBe(400);
    }
    const q = await asOrg(request(app()).get("/orgs/contacts/serve-stats").query({ brandId: BRAND, stepFilter: "{" }));
    expect(q.status).toBe(400);
  });

  it("turns judged CRM labels into client / disqualified evidence, above the confidence floor only", async () => {
    const insertContact = async (name: string, tags: string[] | null) =>
      (
        await db
          .insert(contacts)
          .values({ orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: `ext-${name}`, primaryEmail: email(name), rawAttributes: {}, tags, sourceConnectionId: connectionId })
          .returning()
      )[0];
    const verdict = (kind: "stage" | "tag", labelRef: string, label: string, v: string, confidence: number) => ({
      orgId: ORG,
      brandId: BRAND,
      connectionId,
      kind,
      labelRef,
      label,
      pipelineName: kind === "stage" ? "Sales Pipeline" : null,
      verdict: v,
      confidence,
      probabilities: { [v]: confidence },
      model: "jev-test",
      runId: "run-test",
    });
    await insertContact("t1", ["Unqualified", "vip"]);
    await insertContact("t2", ["client."]);
    await insertContact("t3", ["maybe"]);
    const s1 = await insertContact("s1", null);
    await db.insert(crmLabelVerdicts).values([
      verdict("tag", "", "unqualified", "disqualified", 0.9),
      verdict("tag", "", "client.", "client", 0.95),
      verdict("tag", "", "vip", "none", 1),
      verdict("tag", "", "maybe", "disqualified", 0.4), // below the floor: no evidence
      verdict("stage", "st-unq", "Unqualified", "disqualified", 0.8),
      verdict("stage", "st-new", "New Lead", "none", 1),
    ]);
    await db.insert(ghlOpportunityHistory).values([
      { orgId: ORG, brandId: BRAND, connectionId, opportunityExternalId: "opp-s1", externalContactId: s1.externalId, kind: "stage", value: "st-new", pipelineName: "Sales Pipeline", stageName: "New Lead", changedAt: new Date("2026-09-01T00:00:00Z") },
      { orgId: ORG, brandId: BRAND, connectionId, opportunityExternalId: "opp-s1", externalContactId: s1.externalId, kind: "stage", value: "st-unq", pipelineName: "Sales Pipeline", stageName: "Unqualified", changedAt: new Date("2026-09-05T00:00:00Z") },
    ]);

    const rows = (await db.execute(labelEventsQuery(ORG, BRAND))) as unknown as LabelEventRow[];
    const seen = rows
      .map((r) => `${r.external_contact_id}|${r.step}|${r.source}|${r.tag ?? r.stage_name}|${r.occurred_at ? new Date(r.occurred_at).toISOString() : "undated"}`)
      .sort();
    expect(seen).toEqual([
      "ext-s1|disqualified|stage_label|Unqualified|2026-09-05T00:00:00.000Z",
      "ext-t1|disqualified|contact_tag|unqualified|undated",
      "ext-t2|client|contact_tag|client.|undated",
    ]);
  });
});
