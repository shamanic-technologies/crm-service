import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  contactServes,
  ghlConnections,
  ghlOpportunities,
  people,
  peopleFacts,
  peopleScopes,
} from "../../src/db/schema.js";
import contactRoutes from "../../src/routes/contacts.js";
import { serveNextPeople } from "../../src/lib/serve.js";

/**
 * A people-pool serve scoped to a SEGMENT of the brand's own CRM (pipeline
 * stage, deal status, tag, funnel step), against a real Postgres (gated on
 * CRM_TEST_DB). Silver contacts, deals, people and facts are written directly:
 * the segment read is what is tested.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "5e5e5e5e-1111-4111-8111-000000000001";
const BRAND = "5e5e5e5e-1111-4111-8111-000000000002";
const OTHER_BRAND = "5e5e5e5e-1111-4111-8111-000000000003";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const SALES = "Sales Pipeline";
const WARM = [
  { pipeline: SALES, stage: "Form Filled - No Appointment" },
  { pipeline: SALES, stage: "Showed Up - Interested" },
  { pipeline: SALES, stage: "No-Show for Appointment" },
  { pipeline: SALES, stage: "Potential/ In conversation" },
];

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

interface Seeded {
  name: string;
  deals?: { pipeline: string; stage: string; status: string }[];
  tags?: string[] | null;
  unsubscribed?: boolean;
  facts?: { type: string; payload?: Record<string, unknown> }[];
  brandId?: string;
}

const PEOPLE: Seeded[] = [
  // In: a form filled, never booked.
  { name: "ann", deals: [{ pipeline: SALES, stage: "Form Filled - No Appointment", status: "open" }] },
  // Out: showed up, but the CRM marks them do-not-contact.
  { name: "bob", deals: [{ pipeline: SALES, stage: "Showed Up - Interested", status: "open" }], unsubscribed: true },
  // Out: a no-show who later became a client (deal won elsewhere).
  { name: "cat", deals: [{ pipeline: SALES, stage: "No-Show for Appointment", status: "open" }], facts: [{ type: "sale" }] },
  // Out: unqualified.
  { name: "dan", deals: [{ pipeline: SALES, stage: "Unqualified", status: "abandoned" }] },
  // In: in conversation, tagged (other spelling).
  { name: "eve", deals: [{ pipeline: SALES, stage: "potential/ in conversation ", status: "open" }], tags: ["VIP"] },
  // A won client.
  { name: "fay", deals: [{ pipeline: SALES, stage: "Closed Client", status: "won" }], facts: [{ type: "sale" }] },
  // No deal: a tag and a no-show stated by the calendar.
  { name: "gus", tags: ["vip", "newsletter"], facts: [{ type: "meeting_not_held" }] },
  // Same stage name, another pipeline.
  { name: "hal", deals: [{ pipeline: "DWD", stage: "No-Show for Appointment", status: "open" }] },
  // Another brand's warm lead never leaks in.
  { name: "zed", deals: [{ pipeline: SALES, stage: "Form Filled - No Appointment", status: "open" }], brandId: OTHER_BRAND },
];

const email = (name: string) => `${name}@seg.test`;
const key = (name: string) => `email:${email(name)}`;

async function seed() {
  for (const brandId of [BRAND, OTHER_BRAND]) {
    const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId, createdByUserId: "u", status: "built" }).returning();
    const [conn] = await db
      .insert(ghlConnections)
      .values({ orgId: ORG, brandId, locationId: `loc-${brandId.slice(-1)}`, createdByUserId: "u" })
      .returning();
    let n = 0;
    for (const p of PEOPLE.filter((x) => (x.brandId ?? BRAND) === brandId)) {
      n += 1;
      const [c] = await db
        .insert(contacts)
        .values({
          orgId: ORG,
          brandId,
          source: "gohighlevel",
          externalId: `ext-${p.name}`,
          primaryEmail: email(p.name),
          fullName: p.name,
          rawAttributes: {},
          tags: p.tags ?? null,
          unsubscribed: p.unsubscribed ?? false,
          sourceConnectionId: conn.id,
        })
        .returning();
      for (const [i, d] of (p.deals ?? []).entries()) {
        await db.insert(ghlOpportunities).values({
          orgId: ORG,
          brandId,
          connectionId: conn.id,
          externalId: `opp-${p.name}-${i}`,
          name: `${p.name} deal`,
          pipelineName: d.pipeline,
          stageName: d.stage,
          status: d.status,
          contactId: c.id,
        });
      }
      await db.insert(people).values({
        scopeId: scope.id,
        orgId: ORG,
        brandId,
        personKey: key(p.name),
        identityKeys: [key(p.name)],
        displayName: p.name,
        emails: [email(p.name)],
        phones: [],
        sources: ["gohighlevel"],
        presences: [{ source: "gohighlevel", sourceRef: c.id, emails: [email(p.name)], phones: [], detail: {} }],
        mergeEvidence: [],
        state: "in_conversation",
        stateSource: "gohighlevel",
        firstActivityAt: new Date(`2026-09-${String(n).padStart(2, "0")}T00:00:00Z`),
      });
      for (const [i, f] of (p.facts ?? []).entries()) {
        await db.insert(peopleFacts).values({
          orgId: ORG,
          brandId,
          personKey: key(p.name),
          emails: [email(p.name)],
          phones: [],
          type: f.type,
          occurredAt: null,
          dateBasis: "test",
          source: "gohighlevel",
          sourceRef: `${p.name}-${i}`,
          payload: f.payload ?? {},
          naturalKey: `seg|${p.name}|${i}`,
          family: "gohighlevel",
          contentHash: `h-${p.name}-${i}`,
          live: true,
          ownerPersonKey: key(p.name),
        });
      }
    }
  }
}

async function stats(segment: unknown, extra: Record<string, string> = {}) {
  return asOrg(
    request(app())
      .get("/orgs/contacts/serve-stats")
      .query({ brandId: BRAND, pool: "people", segment: JSON.stringify(segment), ...extra }),
  );
}

describe.skipIf(!RUN)("people pool scoped to a CRM segment", () => {
  const wipe = async () => {
    for (const b of [BRAND, OTHER_BRAND]) {
      await db.delete(contactServes).where(eq(contactServes.brandId, b));
      await db.delete(peopleFacts).where(eq(peopleFacts.brandId, b));
      await db.delete(ghlOpportunities).where(eq(ghlOpportunities.brandId, b));
      await db.delete(contacts).where(eq(contacts.brandId, b));
      await db.delete(ghlConnections).where(eq(ghlConnections.brandId, b));
    }
    await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  };
  beforeEach(async () => {
    stubRuns();
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it("counts the warm stages, minus clients and opted-out people, with a per-stage breakdown", async () => {
    const r = await stats({ dealStages: WARM, dealStatuses: ["open"] });
    expect(r.status).toBe(200);
    // ann + eve; bob opted out, cat a client, hal another pipeline, zed another brand.
    expect(r.body).toMatchObject({ served: 0, remainingSendable: 2, totalSendable: 2 });
    expect(r.body.byStage).toEqual([
      { pipeline: SALES, stage: "Form Filled - No Appointment", served: 0, remainingSendable: 1, totalSendable: 1 },
      { pipeline: SALES, stage: "Showed Up - Interested", served: 0, remainingSendable: 0, totalSendable: 0 },
      { pipeline: SALES, stage: "No-Show for Appointment", served: 0, remainingSendable: 0, totalSendable: 0 },
      { pipeline: SALES, stage: "Potential/ In conversation", served: 0, remainingSendable: 1, totalSendable: 1 },
    ]);
  });

  it("lets the segment state clients and opted-out people back in", async () => {
    expect((await stats({ dealStages: WARM, includeClients: true })).body.totalSendable).toBe(3);
    expect((await stats({ dealStages: WARM, includeOptedOut: true })).body.totalSendable).toBe(3);
  });

  it("a stage without its pipeline matches every pipeline holding that name", async () => {
    expect((await stats({ dealStages: [{ stage: "No-Show for Appointment" }] })).body.totalSendable).toBe(1); // hal (cat is a client)
    expect((await stats({ dealStages: [{ stage: "No-Show for Appointment", pipeline: "DWD" }] })).body.totalSendable).toBe(1);
    expect((await stats({ dealStages: [{ stage: "No-Show for Appointment", pipeline: SALES }] })).body.totalSendable).toBe(0);
  });

  it("filters on deal status, tags and funnel steps", async () => {
    expect((await stats({ dealStatuses: ["WON"], includeClients: true })).body.totalSendable).toBe(1); // fay
    expect((await stats({ dealStatuses: ["won"] })).body.totalSendable).toBe(0); // fay is a client
    expect((await stats({ tags: ["vip"] })).body.totalSendable).toBe(2); // eve + gus
    expect((await stats({ reached: ["meeting_not_held"] })).body.totalSendable).toBe(1); // gus
    expect((await stats({ tags: ["vip"], notReached: ["meeting_not_held"] })).body.totalSendable).toBe(1); // eve
  });

  it("refuses a malformed segment, and a segment on the CSV pool", async () => {
    expect((await stats({ dealStages: [] })).status).toBe(400);
    expect((await stats({ stage: "x" })).status).toBe(400);
    const notJson = await asOrg(request(app()).get("/orgs/contacts/serve-stats").query({ brandId: BRAND, pool: "people", segment: "{" }));
    expect(notJson.status).toBe(400);
    const csv = await asOrg(request(app()).get("/orgs/contacts/serve-stats").query({ brandId: BRAND, segment: "{}" }));
    expect(csv.status).toBe(400);
  });

  it("serves only the segment, marks them served, and says when it is drained", async () => {
    const segment = { dealStages: WARM };
    const first = await serveNextPeople(ORG, BRAND, 1, "run-1", { segment });
    expect(first.contacts.map((c) => c.primaryEmail)).toEqual([email("ann")]);
    expect(first.exhausted).toBe(false);
    const rest = await serveNextPeople(ORG, BRAND, 10, "run-2", { segment });
    expect(rest.contacts.map((c) => c.primaryEmail)).toEqual([email("eve")]);
    expect(rest.exhausted).toBe(true);
    expect((await stats(segment)).body).toMatchObject({ served: 2, remainingSendable: 0, totalSendable: 2 });
  });

  it("serves through the route body too", async () => {
    const r = await asOrg(
      request(app())
        .post("/orgs/contacts/serve-next")
        .send({ brandId: BRAND, limit: 10, people: { segment: { tags: ["VIP"] } } }),
    );
    expect(r.status).toBe(200);
    expect(r.body.contacts.map((c: { primaryEmail: string }) => c.primaryEmail).sort()).toEqual([email("eve"), email("gus")]);
    const bad = await asOrg(
      request(app()).post("/orgs/contacts/serve-next").send({ brandId: BRAND, people: { segment: { dealStages: "x" } } }),
    );
    expect(bad.status).toBe(400);
  });

  it("never serves an opted-out person from the people pool, segment or not", async () => {
    const all = await serveNextPeople(ORG, BRAND, 50, "run-3", {});
    expect(all.contacts.map((c) => c.primaryEmail)).not.toContain(email("bob"));
    expect(all.contacts).toHaveLength(7); // everyone of the brand but bob
  });

  it("lists the segments the brand's CRM holds, with people and who is still in the pool", async () => {
    const r = await asOrg(request(app()).get("/orgs/contacts/segments").query({ brandId: BRAND }));
    expect(r.status).toBe(200);
    const stage = (s: string, p = SALES) => r.body.dealStages.find((d: { stage: string; pipeline: string }) => d.stage === s && d.pipeline === p);
    expect(stage("Form Filled - No Appointment")).toMatchObject({ status: "open", people: 1, inPool: 1 });
    expect(stage("Showed Up - Interested")).toMatchObject({ people: 1, inPool: 0 }); // opted out
    expect(stage("No-Show for Appointment")).toMatchObject({ people: 1, inPool: 0 }); // client
    expect(stage("Closed Client")).toMatchObject({ status: "won", people: 1, inPool: 0 });
    expect(r.body.dealStages).toHaveLength(7);
    // One entry per case-folded tag, in one of the customer's own spellings.
    expect(r.body.tags.map((t: { tag: string; people: number; inPool: number }) => ({ ...t, tag: t.tag.toLowerCase() }))).toEqual([
      { tag: "vip", people: 2, inPool: 2 },
      { tag: "newsletter", people: 1, inPool: 1 },
    ]);
    const step = (s: string) => r.body.steps.find((x: { step: string }) => x.step === s);
    expect(step("sale")).toMatchObject({ people: 2, inPool: 0 });
    expect(step("meeting_not_held")).toMatchObject({ people: 1, inPool: 1 });
  });
});
