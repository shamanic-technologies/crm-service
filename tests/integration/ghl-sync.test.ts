import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  ghlConnections,
  ghlOpportunities,
  ghlPipelines,
  ghlRawRecords,
} from "../../src/db/schema.js";
import { rebuildFromBronze, runSyncPass } from "../../src/lib/gohighlevel/sync.js";
import { readPipelineView } from "../../src/lib/gohighlevel/view.js";
import { serveNext } from "../../src/lib/serve.js";
import gohighlevelRoutes from "../../src/routes/gohighlevel.js";

/**
 * DB-backed GoHighLevel ingestion tests. Gated on CRM_TEST_DB so a mock
 * CRM_SERVICE_DATABASE_URL skips them. CI runs them against a throwaway
 * Postgres; never staging, never production.
 *
 * key-service, runs-service and GoHighLevel are all stubbed at `fetch`, so the
 * real bronze → silver pipeline runs end to end.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "bbbbbbbb-1111-4111-8111-000000000001";
const BRAND = "bbbbbbbb-1111-4111-8111-000000000002";
const CSV_UPLOAD = "bbbbbbbb-1111-4111-8111-000000000003";
const USER = "user-ghl-1";
const LOCATION = "C2QujeCh8ZnC7al2InWR";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

// ─── vendor fixtures ─────────────────────────────────────────────────────────

const PIPELINES = [
  {
    id: "p1",
    name: "Sales",
    stages: [
      { id: "s1", name: "New lead", position: 0 },
      { id: "s2", name: "Quote sent", position: 1 },
      { id: "s3", name: "Won", position: 2 },
    ],
  },
];

const CONTACTS = [
  { id: "c1", email: "Alice@Example.com", firstName: "Alice", lastName: "Martin", phone: "+33612345678", dnd: false },
  { id: "c2", email: "bob@example.com", firstName: "Bob", lastName: "Durand", dnd: true },
  { id: "c3", firstName: "Carol", lastName: "Nguyen", phone: "0612345678", dnd: false },
];

const OPPORTUNITIES = [
  { id: "o1", name: "Alice — June wedding", monetaryValue: 2500.5, pipelineId: "p1", pipelineStageId: "s2", status: "open", contactId: "c1", createdAt: "2026-08-03T04:55:17.355Z", updatedAt: "2026-08-04T04:55:17.355Z" },
  { id: "o2", name: "Bob — corporate", monetaryValue: 1000, pipelineId: "p1", pipelineStageId: "s3", status: "won", contactId: "c2", createdAt: "2026-08-05T04:55:17.355Z", updatedAt: "2026-08-06T04:55:17.355Z" },
  { id: "o3", name: "Orphan deal", monetaryValue: 250, pipelineId: "p-unknown", pipelineStageId: "sx", status: "open", contactId: "c9", createdAt: "2026-08-07T04:55:17.355Z", updatedAt: "2026-08-07T04:55:17.355Z" },
];

// ─── fetch stub ──────────────────────────────────────────────────────────────

let vendorCalls = 0;
let keyServiceStatus = 200;
let contactsProbeStatus = 200;
let contactsProbeBody = "";

function installFetchStub() {
  vendorCalls = 0;
  keyServiceStatus = 200;
  contactsProbeStatus = 200;
  contactsProbeBody = "";

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/keys/brands/")) {
      if (keyServiceStatus !== 200) {
        return new Response(JSON.stringify({ error: "Key not found" }), {
          status: keyServiceStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ brandId: BRAND, provider: "gohighlevel", key: "pit-token", keySource: "brand", userId: USER }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("services.leadconnectorhq.com")) {
      vendorCalls += 1;
      if (contactsProbeStatus !== 200) {
        return new Response(contactsProbeBody, {
          status: contactsProbeStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/opportunities/pipelines")) {
        return json({ pipelines: PIPELINES });
      }
      if (url.includes("/opportunities/search")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return json(page === 1 ? { opportunities: OPPORTUNITIES, meta: { nextPageUrl: null } } : { opportunities: [] });
      }
      if (url.includes("/contacts/")) {
        const params = new URL(url).searchParams;
        if (params.get("limit") === "1") return json({ contacts: CONTACTS.slice(0, 1) });
        if (params.get("startAfterId")) return json({ contacts: [] });
        return json({ contacts: CONTACTS, meta: { startAfter: 1, startAfterId: "c3" } });
      }
    }

    if (url.includes("/v1/runs") || url.includes("/v1/platform-runs")) {
      return json({
        id: "run-stub-ghl",
        parentRunId: null,
        organizationId: ORG,
        userId: USER,
        serviceName: "crm-service",
        taskName: "gohighlevel.sync",
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function app() {
  const server = express();
  server.use(express.json());
  server.use(gohighlevelRoutes);
  return server;
}

async function wipe() {
  await db.delete(ghlOpportunities);
  await db.delete(ghlPipelines);
  await db.delete(ghlRawRecords);
  await db.delete(ghlConnections);
  await db.execute(sql`DELETE FROM contact_serves`);
  await db.delete(contacts);
}

async function seedConnection(): Promise<string> {
  const [row] = await db
    .insert(ghlConnections)
    .values({
      orgId: ORG,
      brandId: BRAND,
      locationId: LOCATION,
      createdByUserId: USER,
      status: "active",
    })
    .returning({ id: ghlConnections.id });
  return row.id;
}

/** A pre-existing CSV contact — must stay sendable, unchanged, forever. */
async function seedCsvContact(email: string) {
  await db.insert(contacts).values({
    orgId: ORG,
    brandId: BRAND,
    primaryEmail: email,
    phoneE164: null,
    fullName: "Csv Person",
    firstName: "Csv",
    lastName: "Person",
    rawAttributes: {},
    consentStatus: "unknown",
    unsubscribed: false,
    sourceUploadId: CSV_UPLOAD,
    sourceRowId: sql`gen_random_uuid()` as unknown as string,
  });
}

describe.skipIf(!RUN)("GoHighLevel ingestion", () => {
  beforeAll(() => {
    process.env.KEY_SERVICE_URL = "http://key-service.test";
    process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
  });

  beforeEach(async () => {
    installFetchStub();
    await wipe();
  });

  it("mirrors contacts, pipelines and opportunities, and derives silver from them", async () => {
    const connectionId = await seedConnection();
    const pass = await runSyncPass(connectionId);

    expect(pass.failures).toEqual([]);
    expect(pass.results[0]).toMatchObject({
      contactsMirrored: 3,
      opportunitiesMirrored: 3,
      pipelinesMirrored: 1,
    });

    const bronze = await db.select().from(ghlRawRecords);
    expect(bronze).toHaveLength(7);

    const silverContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.source, "gohighlevel"));
    expect(silverContacts).toHaveLength(3);
    expect(silverContacts.find((c) => c.externalId === "c1")?.primaryEmail).toBe("alice@example.com");
    // GoHighLevel's do-not-disturb flag is the customer's own opt-out.
    expect(silverContacts.find((c) => c.externalId === "c2")?.unsubscribed).toBe(true);

    const opportunities = await db.select().from(ghlOpportunities);
    expect(opportunities).toHaveLength(3);
    const won = opportunities.find((o) => o.externalId === "o2");
    expect(won?.status).toBe("won");
    expect(won?.stageName).toBe("Won");
    expect(won?.contactId).not.toBeNull();
  });

  it("groups opportunities the way GoHighLevel groups them, and the counts add up", async () => {
    await seedConnection();
    await runSyncPass();

    const view = await readPipelineView(ORG, BRAND);
    expect(view.totalOpportunities).toBe(3);
    expect(view.pipelines).toHaveLength(1);

    const pipeline = view.pipelines[0];
    expect(pipeline.name).toBe("Sales");
    expect(pipeline.count).toBe(2);
    expect(pipeline.totalValue).toBe("3500.50");
    // Stage order is GoHighLevel's, not alphabetical.
    expect(pipeline.stages.map((s) => s.name)).toEqual(["New lead", "Quote sent", "Won"]);
    expect(pipeline.stages.find((s) => s.name === "Quote sent")?.count).toBe(1);

    // An opportunity in a pipeline we have not mirrored is surfaced, not dropped.
    expect(view.ungrouped.map((o) => o.externalId)).toEqual(["o3"]);
    const grouped = view.pipelines.reduce((n, p) => n + p.count, 0);
    expect(grouped + view.ungrouped.length).toBe(view.totalOpportunities);
  });

  it("AC4 — running the sync twice changes nothing, and churns no row", async () => {
    const connectionId = await seedConnection();
    await runSyncPass(connectionId);

    const before = {
      bronze: await db.select().from(ghlRawRecords).orderBy(ghlRawRecords.externalId),
      contacts: await db.select().from(contacts).orderBy(contacts.externalId),
      opportunities: await db.select().from(ghlOpportunities).orderBy(ghlOpportunities.externalId),
      pipelines: await db.select().from(ghlPipelines).orderBy(ghlPipelines.externalId),
    };

    const second = await runSyncPass(connectionId);

    // Nothing GoHighLevel sent had moved, so nothing was written.
    expect(second.results[0]).toMatchObject({
      contactsChanged: 0,
      opportunitiesChanged: 0,
      pipelinesChanged: 0,
      contactsDerived: 0,
      opportunitiesDerived: 0,
      pipelinesDerived: 0,
    });

    const after = {
      bronze: await db.select().from(ghlRawRecords).orderBy(ghlRawRecords.externalId),
      contacts: await db.select().from(contacts).orderBy(contacts.externalId),
      opportunities: await db.select().from(ghlOpportunities).orderBy(ghlOpportunities.externalId),
      pipelines: await db.select().from(ghlPipelines).orderBy(ghlPipelines.externalId),
    };

    // Row-for-row identical, timestamps included: no duplication AND no churn.
    expect(after.bronze).toEqual(before.bronze);
    expect(after.contacts).toEqual(before.contacts);
    expect(after.opportunities).toEqual(before.opportunities);
    expect(after.pipelines).toEqual(before.pipelines);
  });

  it("re-derives a record whose content actually moved", async () => {
    const connectionId = await seedConnection();
    await runSyncPass(connectionId);

    OPPORTUNITIES[0].monetaryValue = 4000;
    try {
      const second = await runSyncPass(connectionId);
      expect(second.results[0].opportunitiesChanged).toBe(1);
      const [row] = await db
        .select()
        .from(ghlOpportunities)
        .where(eq(ghlOpportunities.externalId, "o1"));
      expect(Number(row.monetaryValue)).toBe(4000);
    } finally {
      OPPORTUNITIES[0].monetaryValue = 2500.5;
    }
  });

  it("AC5 — wiping the derived layers and rebuilding reproduces them with no vendor call", async () => {
    const connectionId = await seedConnection();
    await runSyncPass(connectionId);

    const before = {
      contacts: await db.select().from(contacts).orderBy(contacts.externalId),
      opportunities: await db.select().from(ghlOpportunities).orderBy(ghlOpportunities.externalId),
      pipelines: await db.select().from(ghlPipelines).orderBy(ghlPipelines.externalId),
    };

    await db.delete(ghlOpportunities);
    await db.delete(ghlPipelines);
    await db.delete(contacts);
    expect(await db.select().from(contacts)).toHaveLength(0);

    const callsBeforeRebuild = vendorCalls;
    const [conn] = await db.select().from(ghlConnections).where(eq(ghlConnections.id, connectionId));
    const rebuilt = await rebuildFromBronze(conn);

    expect(vendorCalls).toBe(callsBeforeRebuild);
    expect(rebuilt).toEqual({ contacts: 3, opportunities: 3, pipelines: 1 });

    const after = {
      contacts: await db.select().from(contacts).orderBy(contacts.externalId),
      opportunities: await db.select().from(ghlOpportunities).orderBy(ghlOpportunities.externalId),
      pipelines: await db.select().from(ghlPipelines).orderBy(ghlPipelines.externalId),
    };

    // Same content, down to every derived field. Only the surrogate ids and the
    // rebuild timestamp legitimately differ.
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map(({ id, lastRebuiltAt, contactId, ...rest }) => rest);
    expect(strip(after.contacts)).toEqual(strip(before.contacts));
    expect(strip(after.opportunities)).toEqual(strip(before.opportunities));
    expect(strip(after.pipelines)).toEqual(strip(before.pipelines));
  });

  it("AC6 — no GoHighLevel contact ever becomes sendable", async () => {
    await seedConnection();
    // The same person is in the client's CSV export AND in their GoHighLevel.
    await seedCsvContact("alice@example.com");
    await runSyncPass();

    const sendable = await db.execute(
      sql`SELECT id, source, primary_email FROM sendable_contacts WHERE brand_id = ${BRAND}`,
    );
    const rows = sendable as unknown as { source: string; primary_email: string }[];
    expect(rows.every((r) => r.source === "csv")).toBe(true);
    // The CSV row is still there — the guard drops nothing that was sendable.
    expect(rows.map((r) => r.primary_email)).toContain("alice@example.com");

    // And the serve path itself never hands one out.
    const served = await serveNext(ORG, BRAND, 100, "run-stub-ghl");
    expect(served.contacts).toHaveLength(1);
    expect(served.contacts[0].primaryEmail).toBe("alice@example.com");
  });

  it("AC1 — a credential GoHighLevel refuses is refused here, with its own reason", async () => {
    contactsProbeStatus = 401;
    contactsProbeBody = JSON.stringify({
      message: "The token does not have access to this location.",
    });

    const res = await request(app())
      .post("/orgs/gohighlevel/connections")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ brandId: BRAND, locationId: "someone-elses-location" });

    expect(res.status).toBe(400);
    expect(res.body.vendorStatus).toBe(401);
    expect(res.body.vendorError).toBe("The token does not have access to this location.");
    // Nothing was written: an unproven credential is not a connection.
    expect(await db.select().from(ghlConnections)).toHaveLength(0);
  });

  it("refuses a brand with no credential of its own, rather than reaching for the org's", async () => {
    keyServiceStatus = 404;

    const res = await request(app())
      .post("/orgs/gohighlevel/connections")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ brandId: BRAND, locationId: LOCATION });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no GoHighLevel credential stored");
    expect(await db.select().from(ghlConnections)).toHaveLength(0);
  });

  it("writes the connection once GoHighLevel has proven the credential", async () => {
    const res = await request(app())
      .post("/orgs/gohighlevel/connections")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ brandId: BRAND, locationId: LOCATION });

    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ locationId: LOCATION, status: "active", synced: false });
  });

  it("AC3 — connection health carries the reason the last sync failed", async () => {
    const connectionId = await seedConnection();
    keyServiceStatus = 500;

    const pass = await runSyncPass(connectionId);
    expect(pass.failures).toHaveLength(1);

    const res = await request(app())
      .get(`/orgs/gohighlevel/connections?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.connections[0].status).toBe("error");
    expect(res.body.connections[0].lastError).toContain("key-service");
  });

  it("one broken connection does not stop the others", async () => {
    const good = await seedConnection();
    const [other] = await db
      .insert(ghlConnections)
      .values({
        orgId: ORG,
        brandId: "bbbbbbbb-1111-4111-8111-000000000009",
        locationId: "another-location",
        createdByUserId: USER,
        status: "active",
      })
      .returning({ id: ghlConnections.id });

    // Break exactly one of them by making its vendor probe fail.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("another-location") || url.includes("location_id=another-location")) {
        return new Response(JSON.stringify({ message: "Location not found" }), { status: 404 });
      }
      return realFetch(input, init);
    });

    const pass = await runSyncPass();
    expect(pass.results.map((r) => r.connectionId)).toContain(good);
    expect(pass.failures.map((f) => f.connectionId)).toContain(other.id);
  });

  it("AC7 — disconnecting stops the syncing", async () => {
    const connectionId = await seedConnection();
    await runSyncPass(connectionId);
    expect(await db.select().from(ghlRawRecords)).not.toHaveLength(0);

    const res = await request(app())
      .delete(`/orgs/gohighlevel/connections/${connectionId}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(res.status).toBe(200);

    expect(await db.select().from(ghlConnections)).toHaveLength(0);
    expect(await db.select().from(ghlRawRecords)).toHaveLength(0);
    expect(await db.select().from(ghlOpportunities)).toHaveLength(0);
    expect(await db.select().from(contacts).where(eq(contacts.source, "gohighlevel"))).toHaveLength(0);

    const callsBefore = vendorCalls;
    const pass = await runSyncPass();
    expect(pass.connections).toBe(0);
    expect(vendorCalls).toBe(callsBefore);
  });

  it("a paused connection is skipped, and resumes on demand", async () => {
    const connectionId = await seedConnection();
    await db
      .update(ghlConnections)
      .set({ status: "paused" })
      .where(eq(ghlConnections.id, connectionId));

    const callsBefore = vendorCalls;
    const paused = await runSyncPass();
    expect(paused.results).toHaveLength(0);
    expect(vendorCalls).toBe(callsBefore);

    await request(app())
      .patch(`/orgs/gohighlevel/connections/${connectionId}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ status: "active" });

    const resumed = await runSyncPass();
    expect(resumed.results).toHaveLength(1);
  });

  it("every /orgs read is scoped to the calling org", async () => {
    await seedConnection();
    await runSyncPass();

    const res = await request(app())
      .get(`/orgs/gohighlevel/contacts?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "bbbbbbbb-1111-4111-8111-00000000000f");

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(0);
  });
});
