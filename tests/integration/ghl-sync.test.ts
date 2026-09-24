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

const CONTACTS: Record<string, unknown>[] = [
  // c1 is the rich case: company, place and provenance all present.
  {
    id: "c1",
    email: "Alice@Example.com",
    firstName: "Alice",
    lastName: "Martin",
    phone: "+33612345678",
    dnd: false,
    companyName: "Martin Traiteur",
    website: "https://martin-traiteur.fr",
    city: "Lyon",
    state: "Auvergne-Rhône-Alpes",
    country: "FR",
    postalCode: "69002",
    address1: "3 rue de la Ré",
    source: "Salon des Mariages ",
    type: "customer",
    tags: ["wedding", "vip"],
    dateAdded: "2026-08-19T15:23:58.577Z",
    dateUpdated: "2026-08-20T09:00:00.000Z",
    attributions: [
      { isLast: true, medium: "referral", url: "https://later.example" },
      {
        isFirst: true,
        medium: "order_form",
        url: "https://sites.leadconnectorhq.com/preview/x",
        referrer: "https://app.gohighlevel.com",
        ip: "151.158.212.9",
        userAgent: "Mozilla/5.0",
      },
    ],
  },
  // c2 carries a company and NO email — the 454-of-455 case that makes company
  // the only non-name signal those records have anywhere.
  {
    id: "c2",
    email: "bob@example.com",
    firstName: "Bob",
    lastName: "Durand",
    dnd: true,
    companyName: "Durand SARL",
    tags: [],
  },
  // c3 is the bare case: GoHighLevel holds nothing beyond a name and a phone.
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

  it("carries the company, the place and the provenance GoHighLevel holds", async () => {
    await seedConnection();
    await runSyncPass();

    const [alice] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.source, "gohighlevel"), eq(contacts.externalId, "c1")));

    expect(alice).toMatchObject({
      companyName: "Martin Traiteur",
      website: "https://martin-traiteur.fr",
      city: "Lyon",
      stateRegion: "Auvergne-Rhône-Alpes",
      country: "FR",
      postalCode: "69002",
      streetAddress: "3 rue de la Ré",
      // The customer's own words, trimmed but never mapped onto anything of ours.
      leadSource: "Salon des Mariages",
      contactType: "customer",
      tags: ["wedding", "vip"],
      // FIRST touch, and never the ip or the user agent sitting beside it.
      originMedium: "order_form",
      originUrl: "https://sites.leadconnectorhq.com/preview/x",
      originReferrer: "https://app.gohighlevel.com",
    });
    expect(alice.sourceCreatedAt?.toISOString()).toBe("2026-08-19T15:23:58.577Z");
    expect(alice.sourceUpdatedAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("states what GoHighLevel does not hold as absent, never as a default", async () => {
    await seedConnection();
    await runSyncPass();

    const [carol] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.source, "gohighlevel"), eq(contacts.externalId, "c3")));

    expect(carol.companyName).toBeNull();
    expect(carol.website).toBeNull();
    expect(carol.city).toBeNull();
    expect(carol.country).toBeNull();
    expect(carol.leadSource).toBeNull();
    expect(carol.contactType).toBeNull();
    expect(carol.originMedium).toBeNull();
    expect(carol.sourceCreatedAt).toBeNull();
    // No tags FIELD at all reads null; an empty tags field reads [] — those differ.
    expect(carol.tags).toBeNull();

    const [bob] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.source, "gohighlevel"), eq(contacts.externalId, "c2")));
    expect(bob.tags).toEqual([]);
    // Company with no email: the whole reason this exists.
    expect(bob.companyName).toBe("Durand SARL");
  });

  it("breaks the brand's contacts down by where they came from, reconciling to the total", async () => {
    await seedConnection();
    await runSyncPass();
    // A CSV contact of the same brand is not part of the GoHighLevel population.
    await seedCsvContact("csv-origins@example.com");

    const res = await request(app())
      .get(`/orgs/gohighlevel/contacts/origins?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);

    expect(res.status).toBe(200);
    expect(res.body.totalContacts).toBe(3);
    // The customer's own words, and the contacts carrying none as their own bucket.
    expect(res.body.leadSource).toEqual([
      { value: null, count: 2 },
      { value: "Salon des Mariages", count: 1 },
    ]);
    expect(res.body.originMedium).toEqual([
      { value: null, count: 2 },
      { value: "order_form", count: 1 },
    ]);
    expect(res.body.contactType).toEqual([
      { value: null, count: 2 },
      { value: "customer", count: 1 },
    ]);
    // Tags overlap, so they reconcile through tagged + untagged instead.
    expect(res.body.tags).toEqual({
      tagged: 1,
      untagged: 2,
      labels: [
        { value: "vip", count: 1 },
        { value: "wedding", count: 1 },
      ],
    });

    for (const key of ["leadSource", "originMedium", "contactType"]) {
      const sum = (res.body[key] as { count: number }[]).reduce((a, b) => a + b.count, 0);
      expect(sum).toBe(res.body.totalContacts);
    }
  });

  it("states the none bucket even when every contact carries a value, and scopes to the org", async () => {
    const empty = await request(app())
      .get(`/orgs/gohighlevel/contacts/origins?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      totalContacts: 0,
      leadSource: [{ value: null, count: 0 }],
      tags: { tagged: 0, untagged: 0, labels: [] },
    });

    await seedConnection();
    await runSyncPass();
    const otherOrg = await request(app())
      .get(`/orgs/gohighlevel/contacts/origins?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "bbbbbbbb-1111-4111-8111-00000000000f");
    expect(otherOrg.body.totalContacts).toBe(0);

    const bad = await request(app())
      .get(`/orgs/gohighlevel/contacts/origins?brandId=not-a-uuid`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(bad.status).toBe(400);
  });

  it("serves the company and the provenance on the brand's contacts read", async () => {
    await seedConnection();
    await runSyncPass();

    const app = express();
    app.use(express.json());
    app.use(gohighlevelRoutes);

    const res = await request(app)
      .get(`/orgs/gohighlevel/contacts?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);

    expect(res.status).toBe(200);
    const alice = res.body.contacts.find((c: { externalId: string }) => c.externalId === "c1");
    expect(alice).toMatchObject({
      primaryEmail: "alice@example.com",
      company: { name: "Martin Traiteur", website: "https://martin-traiteur.fr" },
      location: {
        city: "Lyon",
        stateRegion: "Auvergne-Rhône-Alpes",
        country: "FR",
        postalCode: "69002",
        streetAddress: "3 rue de la Ré",
      },
      record: {
        type: "customer",
        leadSource: "Salon des Mariages",
        tags: ["wedding", "vip"],
        origin: {
          medium: "order_form",
          url: "https://sites.leadconnectorhq.com/preview/x",
          referrer: "https://app.gohighlevel.com",
        },
      },
    });
    // The raw attribution blob's ip and user agent stay in bronze.
    expect(JSON.stringify(alice)).not.toContain("151.158.212.9");

    const carol = res.body.contacts.find((c: { externalId: string }) => c.externalId === "c3");
    expect(carol.company).toEqual({ name: null, website: null });
    expect(carol.record.tags).toBeNull();
    expect(carol.record.origin).toEqual({ medium: null, url: null, referrer: null });
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

  it("the contacts list has a total order: paging visits every contact exactly once", async () => {
    // Heavy name ties (and a null name) are exactly what a name-only sort
    // cannot page through safely. 3 names over 22 contacts + 1 unnamed.
    const names = ["Jean Dupont", "Marie Curie", "Paul Martin"];
    const rows = Array.from({ length: 23 }, (_, i) => ({
      orgId: ORG,
      brandId: BRAND,
      source: "gohighlevel",
      externalId: `tie-${String(i).padStart(2, "0")}`,
      fullName: i === 22 ? null : names[i % 3],
      rawAttributes: {},
    }));
    // Inserted in reverse so physical order disagrees with the tie-break.
    await db.insert(contacts).values([...rows].reverse());

    async function walk(pageSize: number): Promise<string[]> {
      const seen: string[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const res = await request(app())
          .get(`/orgs/gohighlevel/contacts?brandId=${BRAND}&limit=${pageSize}&offset=${offset}`)
          .set("x-api-key", API_KEY)
          .set("x-org-id", ORG)
          .set("x-user-id", USER);
        expect(res.status).toBe(200);
        const page = res.body.contacts as { externalId: string }[];
        seen.push(...page.map((c) => c.externalId));
        if (page.length < pageSize) return seen;
      }
    }

    for (const size of [1, 7, 1000]) {
      const seen = await walk(size);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
    }

    // Still sorted by name for a human reader; ties broken by GoHighLevel's id.
    const all = await walk(1000);
    const expected = [...rows]
      .sort((a, b) =>
        a.fullName === b.fullName
          ? a.externalId.localeCompare(b.externalId)
          : a.fullName === null
            ? 1
            : b.fullName === null
              ? -1
              : a.fullName.localeCompare(b.fullName),
      )
      .map((r) => r.externalId);
    expect(all).toEqual(expected);
    expect(await walk(7)).toEqual(expected);
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
