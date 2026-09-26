import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  ghlAppointments,
  ghlConnections,
  ghlFormSubmissions,
  ghlOpportunities,
  ghlOpportunityHistory,
  ghlPipelines,
  ghlRawRecords,
  ghlStageMeanings,
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

const OPPORTUNITIES: Record<string, unknown>[] = [
  // o1 carries no stage / status change dates at all: its stage entry is undated.
  { id: "o1", name: "Alice — June wedding", monetaryValue: 2500.5, pipelineId: "p1", pipelineStageId: "s2", status: "open", contactId: "c1", createdAt: "2026-08-03T04:55:17.355Z", updatedAt: "2026-08-04T04:55:17.355Z" },
  { id: "o2", name: "Bob — corporate", monetaryValue: 1000, pipelineId: "p1", pipelineStageId: "s3", status: "won", contactId: "c2", createdAt: "2026-08-05T04:55:17.355Z", updatedAt: "2026-08-06T04:55:17.355Z", lastStageChangeAt: "2026-08-06T04:00:00.000Z", lastStatusChangeAt: "2026-08-06T04:00:05.000Z" },
  { id: "o3", name: "Orphan deal", monetaryValue: 250, pipelineId: "p-unknown", pipelineStageId: "sx", status: "open", contactId: "c9", createdAt: "2026-08-07T04:55:17.355Z", updatedAt: "2026-08-07T04:55:17.355Z" },
];

const CALENDARS = [{ id: "cal1", name: "Discovery call" }];

const APPOINTMENTS: Record<string, unknown>[] = [
  // Booked, not yet held: evidences the booking only.
  { id: "ap1", calendarId: "cal1", contactId: "c1", appointmentStatus: "confirmed", appoinmentStatus: "confirmed", title: "Alice", dateAdded: "2026-08-10T10:00:00.000Z", dateUpdated: "2026-08-10T10:00:10.000Z", startTime: "2026-08-12T10:00:00-04:00", endTime: "2026-08-12T10:30:00-04:00" },
  // Held: booked AND attended.
  { id: "ap2", calendarId: "cal1", contactId: "c2", appointmentStatus: "showed", title: "Bob", dateAdded: "2026-08-01T09:00:00.000Z", dateUpdated: "2026-08-02T14:00:00.000Z", startTime: "2026-08-02T15:00:00+02:00", endTime: "2026-08-02T15:30:00+02:00" },
  // No-show: booked AND not held.
  { id: "ap3", calendarId: "cal1", contactId: "c3", appointmentStatus: "noshow", title: "Carol", dateAdded: "2026-08-03T09:00:00.000Z", dateUpdated: "2026-08-05T09:00:00.000Z", startTime: "2026-08-04T09:00:00Z", endTime: "2026-08-04T09:30:00Z" },
  // Invalid: mirrored, evidences nothing.
  { id: "ap4", calendarId: "cal1", contactId: "c1", appointmentStatus: "invalid", title: "Alice dup", dateAdded: "2026-08-11T10:00:00.000Z", dateUpdated: "2026-08-11T10:00:00.000Z", startTime: "2026-08-13T10:00:00Z", endTime: "2026-08-13T10:30:00Z" },
];

const FORMS = [{ id: "f1", locationId: LOCATION, name: "Meta Ads" }];

const FORM_SUBMISSIONS: Record<string, unknown>[] = [
  // Carol filled the Meta Ads lead form: dated by GoHighLevel's own createdAt.
  { id: "fs1", contactId: "c3", formId: "f1", name: "Carol Nguyen", createdAt: "2026-08-20T11:00:59.547Z", external: false, others: { ip: "1.2.3.4", phone: "0612345678" } },
  // A zone-less timestamp is NOT placed on a timeline: the event is served undated.
  { id: "fs2", contactId: "c3", formId: "f1", name: "Carol Nguyen", createdAt: "2026-08-21 10:00:00" },
  // A form GoHighLevel does not list (its relayed Facebook lead forms): no name, never guessed.
  { id: "fs3", contactId: "c3", formId: "fb-location", createdAt: "2026-08-22T09:00:00.000Z" },
  // Submitted by a contact we never mirrored: nobody to attribute it to.
  { id: "fs4", contactId: "c9", formId: "f1", createdAt: "2026-08-23T09:00:00.000Z" },
];

/** What the stubbed judgment model answers per stage name: [meaning, confidence]. */
const STAGE_ANSWERS: Record<string, [string, number]> = {
  "New lead": ["none", 1],
  "Quote sent": ["meeting_booked", 1],
  Won: ["sale", 1],
  "Deal signed": ["sale", 1],
};

// ─── fetch stub ──────────────────────────────────────────────────────────────

let vendorCalls = 0;
let chatCalls = 0;
let chatStageNames: string[][] = [];
let keyServiceStatus = 200;
let contactsProbeStatus = 200;
let contactsProbeBody = "";

function installFetchStub() {
  vendorCalls = 0;
  chatCalls = 0;
  chatStageNames = [];
  keyServiceStatus = 200;
  contactsProbeStatus = 200;
  contactsProbeBody = "";

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("/orgs/judgments")) {
      chatCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, { instructions: string }>;
      };
      const names: string[] = [];
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(body.questions)) {
        const name = /the stage "([^"]*)"/.exec(question.instructions)![1];
        names.push(name);
        const [meaning, confidence] = STAGE_ANSWERS[name] ?? ["none", 1];
        answers[key] = { type: "choice", choice: meaning, confidence, probabilities: { [meaning]: confidence } };
      }
      chatStageNames.push(names);
      return json({ model: "jev-1.13.0", answers, usage: { inputTokens: 10, outputTokens: 5 } });
    }

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
      if (url.includes("/forms/submissions")) {
        const params = new URL(url).searchParams;
        // Without an explicit window GoHighLevel answers the last 30 days only.
        if (params.get("limit") !== "1" && (!params.get("startAt") || !params.get("endAt"))) {
          throw new Error("form submissions read without an explicit startAt/endAt window");
        }
        return json({ submissions: FORM_SUBMISSIONS, meta: { total: FORM_SUBMISSIONS.length, nextPage: null } });
      }
      if (url.includes("/forms/")) {
        return json({ forms: FORMS, total: FORMS.length });
      }
      if (url.includes("/calendars/events")) {
        return json({ events: APPOINTMENTS });
      }
      if (url.includes("/calendars/")) {
        return json({ calendars: CALENDARS });
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
  await db.delete(ghlStageMeanings);
  await db.delete(ghlOpportunityHistory);
  await db.delete(ghlAppointments);
  await db.delete(ghlFormSubmissions);
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
      formSubmissionsMirrored: 4,
      formSubmissionsDerived: 4,
    });

    const bronze = await db.select().from(ghlRawRecords);
    // 3 contacts + 3 opportunities + 1 pipeline + 1 calendar + 4 appointments
    // + 1 form + 4 form submissions.
    expect(bronze).toHaveLength(17);

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
      formSubmissions: await db.select().from(ghlFormSubmissions).orderBy(ghlFormSubmissions.externalId),
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
      formSubmissionsChanged: 0,
      formSubmissionsDerived: 0,
    });

    const after = {
      bronze: await db.select().from(ghlRawRecords).orderBy(ghlRawRecords.externalId),
      contacts: await db.select().from(contacts).orderBy(contacts.externalId),
      opportunities: await db.select().from(ghlOpportunities).orderBy(ghlOpportunities.externalId),
      pipelines: await db.select().from(ghlPipelines).orderBy(ghlPipelines.externalId),
      formSubmissions: await db.select().from(ghlFormSubmissions).orderBy(ghlFormSubmissions.externalId),
    };

    // Row-for-row identical, timestamps included: no duplication AND no churn.
    expect(after.bronze).toEqual(before.bronze);
    expect(after.contacts).toEqual(before.contacts);
    expect(after.opportunities).toEqual(before.opportunities);
    expect(after.pipelines).toEqual(before.pipelines);
    expect(after.formSubmissions).toEqual(before.formSubmissions);
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
    expect(rebuilt).toEqual({
      contacts: 3,
      opportunities: 3,
      pipelines: 1,
      appointments: 4,
      formSubmissions: 4,
      // The history already holds every observation: a rebuild appends nothing.
      historyAppended: 0,
      stageMeaningsDecided: 0,
    });

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

  // ─── funnel evidence: appointments, stage history, stage meanings ─────────

  async function funnelEvents(query = "") {
    const res = await request(app())
      .get(`/orgs/gohighlevel/funnel-events?brandId=${BRAND}${query}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(res.status).toBe(200);
    return res.body as {
      contacts: {
        contactId: string;
        externalContactId: string;
        events: {
          step: string;
          occurredAt: string | null;
          dateBasis: string;
          source: string;
          sourceId: string;
          detail: Record<string, unknown>;
        }[];
      }[];
      totalContacts: number;
      nextOffset: number | null;
      undecidedStages: number;
    };
  }

  it("mirrors the calendar appointments with the dates that matter", async () => {
    await seedConnection();
    const pass = await runSyncPass();
    expect(pass.results[0]).toMatchObject({ appointmentsMirrored: 4, appointmentsDerived: 4 });

    const rows = await db.select().from(ghlAppointments).orderBy(ghlAppointments.externalId);
    expect(rows.map((r) => r.externalId)).toEqual(["ap1", "ap2", "ap3", "ap4"]);
    const [ap1, ap2] = rows;
    expect(ap1).toMatchObject({ calendarName: "Discovery call", status: "confirmed", externalContactId: "c1" });
    expect(ap1.contactId).not.toBeNull();
    expect(ap1.bookedAt?.toISOString()).toBe("2026-08-10T10:00:00.000Z");
    // The offset in GoHighLevel's answer is honoured, never replaced by ours.
    expect(ap1.startsAt?.toISOString()).toBe("2026-08-12T14:00:00.000Z");
    expect(ap2.status).toBe("showed");
    expect(ap2.startsAt?.toISOString()).toBe("2026-08-02T13:00:00.000Z");
  });

  it("appends the stage and status history once, and again only when it moves", async () => {
    const connectionId = await seedConnection();
    const first = await runSyncPass(connectionId);
    // Three opportunities, each observed in one stage and one status.
    expect(first.results[0].historyAppended).toBe(6);

    const second = await runSyncPass(connectionId);
    expect(second.results[0].historyAppended).toBe(0);
    expect(await db.select().from(ghlOpportunityHistory)).toHaveLength(6);

    const [o2Stage] = await db
      .select()
      .from(ghlOpportunityHistory)
      .where(and(eq(ghlOpportunityHistory.opportunityExternalId, "o2"), eq(ghlOpportunityHistory.kind, "stage")));
    expect(o2Stage).toMatchObject({ value: "s3", stageName: "Won", pipelineName: "Sales" });
    expect(o2Stage.changedAt?.toISOString()).toBe("2026-08-06T04:00:00.000Z");

    // o1 has no dates in GoHighLevel: the row says so rather than borrowing ours.
    const [o1Stage] = await db
      .select()
      .from(ghlOpportunityHistory)
      .where(and(eq(ghlOpportunityHistory.opportunityExternalId, "o1"), eq(ghlOpportunityHistory.kind, "stage")));
    expect(o1Stage.changedAt).toBeNull();

    // o1 moves on: the old row stays, the new stage is appended with GoHighLevel's date.
    const original = { ...OPPORTUNITIES[0] };
    Object.assign(OPPORTUNITIES[0], {
      pipelineStageId: "s3",
      status: "won",
      lastStageChangeAt: "2026-08-20T08:00:00.000Z",
      lastStatusChangeAt: "2026-08-20T08:00:01.000Z",
    });
    try {
      const third = await runSyncPass(connectionId);
      expect(third.results[0].historyAppended).toBe(2);
      const o1 = await db
        .select()
        .from(ghlOpportunityHistory)
        .where(eq(ghlOpportunityHistory.opportunityExternalId, "o1"))
        .orderBy(ghlOpportunityHistory.observedAt, ghlOpportunityHistory.kind);
      expect(o1.map((r) => `${r.kind}:${r.value}`)).toEqual([
        "stage:s2",
        "status:open",
        "stage:s3",
        "status:won",
      ]);
    } finally {
      for (const key of Object.keys(OPPORTUNITIES[0])) delete OPPORTUNITIES[0][key];
      Object.assign(OPPORTUNITIES[0], original);
    }
  });

  it("observes opportunities mirrored before the history existed, even when nothing moved", async () => {
    // The production shape: bronze and silver already hold every opportunity,
    // nothing changes on the next pass, and the history is empty.
    const connectionId = await seedConnection();
    await runSyncPass(connectionId);
    await db.delete(ghlOpportunityHistory);

    const quiet = await runSyncPass(connectionId);
    expect(quiet.results[0].opportunitiesChanged).toBe(0);
    expect(quiet.results[0].historyAppended).toBe(6);

    const again = await runSyncPass(connectionId);
    expect(again.results[0].historyAppended).toBe(0);
  });

  it("decides each stage's meaning once, records the model, and never re-asks", async () => {
    const connectionId = await seedConnection();
    const first = await runSyncPass(connectionId);
    expect(first.results[0].stageMeaningsDecided).toBe(3);
    expect(chatCalls).toBe(1);
    expect(chatStageNames[0].sort()).toEqual(["New lead", "Quote sent", "Won"]);

    const second = await runSyncPass(connectionId);
    expect(second.results[0].stageMeaningsDecided).toBe(0);
    expect(chatCalls).toBe(1);

    const res = await request(app())
      .get(`/orgs/gohighlevel/stage-meanings?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.stageMeanings.map((m: { stageName: string; meaning: string; model: string }) => [
        m.stageName,
        `${m.meaning}@${m.model}`,
      ]),
    );
    expect(byName).toEqual({
      "New lead": "none@jev-1.13.0",
      "Quote sent": "meeting_booked@jev-1.13.0",
      Won: "sale@jev-1.13.0",
    });

    // A NEW stage name is the only thing sent to the model again.
    PIPELINES[0].stages[2].name = "Deal signed";
    try {
      const third = await runSyncPass(connectionId);
      expect(third.results[0].stageMeaningsDecided).toBe(1);
      expect(chatCalls).toBe(2);
      expect(chatStageNames[1]).toEqual(["Deal signed"]);
    } finally {
      PIPELINES[0].stages[2].name = "Won";
    }
  });

  it("serves each contact's dated funnel events, with where each came from", async () => {
    await seedConnection();
    await runSyncPass();

    const body = await funnelEvents();
    expect(body.totalContacts).toBe(3);
    expect(body.undecidedStages).toBe(0);
    const byExternal = Object.fromEntries(body.contacts.map((c) => [c.externalContactId, c.events]));

    // Alice: booked through the calendar (dated), and her opportunity sits in a
    // stage that means booked — with no date, because GoHighLevel gave none.
    // Her `invalid` appointment evidences nothing.
    expect(byExternal.c1.map((e) => [e.step, e.source, e.occurredAt, e.dateBasis])).toEqual([
      ["meeting_booked", "appointment", "2026-08-10T10:00:00.000Z", "booked_at"],
      ["meeting_booked", "stage_entry", null, "stage_entered_at"],
    ]);
    expect(byExternal.c1[0].detail).toMatchObject({ calendarName: "Discovery call", appointmentStatus: "confirmed" });

    // Bob: booked, attended, and won — the won date is GoHighLevel's.
    expect(byExternal.c2.map((e) => [e.step, e.source, e.occurredAt])).toEqual([
      ["meeting_booked", "appointment", "2026-08-01T09:00:00.000Z"],
      ["meeting_attended", "appointment", "2026-08-02T13:00:00.000Z"],
      ["sale", "stage_entry", "2026-08-06T04:00:00.000Z"],
      ["sale", "won_status", "2026-08-06T04:00:05.000Z"],
    ]);
    expect(byExternal.c2[2].detail).toMatchObject({ pipelineName: "Sales", stageName: "Won" });

    // Carol: booked, did not show, then filled the Meta Ads lead form (twice,
    // plus once through a form GoHighLevel does not list).
    expect(byExternal.c3.map((e) => [e.step, e.source, e.occurredAt, e.dateBasis])).toEqual([
      ["meeting_booked", "appointment", "2026-08-03T09:00:00.000Z", "booked_at"],
      ["meeting_not_held", "appointment", "2026-08-04T09:00:00.000Z", "scheduled_start"],
      ["form_submitted", "form_submission", "2026-08-20T11:00:59.547Z", "submitted_at"],
      ["form_submitted", "form_submission", "2026-08-22T09:00:00.000Z", "submitted_at"],
      // Zone-less createdAt: served, undated, never guessed.
      ["form_submitted", "form_submission", null, "submitted_at"],
    ]);
    expect(byExternal.c3[2]).toMatchObject({
      sourceId: "fs1",
      detail: { formId: "f1", formName: "Meta Ads", attributionMedium: null },
    });
    expect(byExternal.c3[3].detail).toMatchObject({ formId: "fb-location", formName: null });

    // No form evidence, no form event: Alice came in through an order form
    // (a checkout, not a lead form) and Bob carries no attribution at all.
    expect(byExternal.c1.some((e) => e.step === "form_submitted")).toBe(false);
    expect(byExternal.c2.some((e) => e.step === "form_submitted")).toBe(false);

    // The orphan deal's contact was never mirrored: nobody to attribute it to.
    expect(Object.keys(byExternal).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("counts, over the whole CRM, the contacts that ever reached each step", async () => {
    await seedConnection();
    await runSyncPass();

    const res = await request(app())
      .get(`/orgs/gohighlevel/funnel-reach?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    const steps = Object.fromEntries(
      (res.body.steps as { step: string; contacts: number; contactsAtOrBeyond: number }[]).map((s) => [
        s.step,
        [s.contacts, s.contactsAtOrBeyond],
      ]),
    );
    // Alice booked; Bob booked, attended and won; Carol booked, no-showed, filled a form.
    expect(steps).toEqual({
      form_submitted: [1, 1],
      meeting_booked: [3, 3],
      meeting_attended: [1, 1],
      meeting_not_held: [1, 1],
      sale: [1, 1],
      deal_lost: [0, 0],
    });
    const booked = res.body.steps.find((s: { step: string }) => s.step === "meeting_booked");
    expect(booked.bySource).toEqual({ appointment: 3, stage_entry: 1 });
    expect(res.body.coverage).toMatchObject({
      connectionStatus: "active",
      totalContacts: 3,
      contactsWithEvidence: 3,
      appointmentsSince: "2026-08-01T09:00:00.000Z",
      undecidedStages: 0,
    });
    expect(res.body.coverage.stageHistorySince).not.toBeNull();

    // The org-less twin answers the same, resolving the org from the connection.
    const internal = await request(app())
      .get(`/internal/gohighlevel/funnel-reach?brandId=${BRAND}`)
      .set("x-api-key", API_KEY);
    expect(internal.status).toBe(200);
    expect(internal.body).toEqual(res.body);
  });

  it("says why reach is not available, distinctly from zeros", async () => {
    const noConnection = await request(app())
      .get(`/orgs/gohighlevel/funnel-reach?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(noConnection.status).toBe(200);
    expect(noConnection.body).toEqual({
      brandId: BRAND,
      available: false,
      reason: "no_connection",
      coverage: null,
    });
    const internal = await request(app())
      .get(`/internal/gohighlevel/funnel-reach?brandId=${BRAND}`)
      .set("x-api-key", API_KEY);
    expect(internal.body).toMatchObject({ available: false, reason: "no_connection" });

    await seedConnection();
    const notSynced = await request(app())
      .get(`/orgs/gohighlevel/funnel-reach?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(notSynced.body).toMatchObject({ available: false, reason: "not_synced" });
    expect(notSynced.body.steps).toBeUndefined();

    await runSyncPass();
    await db.delete(ghlStageMeanings);
    const pending = await request(app())
      .get(`/orgs/gohighlevel/funnel-reach?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(pending.body).toMatchObject({ available: false, reason: "stage_meanings_pending" });
    expect(pending.body.coverage.undecidedStages).toBeGreaterThan(0);
  });

  it("a contact whose first touch is a form evidences a form fill, dated by its creation", async () => {
    CONTACTS.push({
      id: "c4",
      email: "dora@example.com",
      firstName: "Dora",
      source: "Meta Ads",
      tags: ["funnel form submitted"],
      dateAdded: "2026-06-11T19:25:23.633Z",
      attributions: [
        { isFirst: true, medium: "form", mediumId: "f1", url: "https://example.com/optin" },
        { isLast: true, medium: "calendar" },
      ],
    });
    try {
      await seedConnection();
      await runSyncPass();

      const body = await funnelEvents();
      const dora = body.contacts.find((c) => c.externalContactId === "c4")!;
      // GoHighLevel no longer serves Dora's submission record; its attribution
      // still says the form is what created her.
      expect(dora.events).toEqual([
        {
          step: "form_submitted",
          occurredAt: "2026-06-11T19:25:23.633Z",
          dateBasis: "contact_created_at",
          source: "form_origin",
          sourceId: "c4",
          detail: {
            calendarName: null,
            appointmentStatus: null,
            scheduledStart: null,
            pipelineName: null,
            stageName: null,
            observedAt: null,
            meaningConfidence: null,
            formId: null,
            formName: null,
            attributionMedium: "form",
          },
        },
      ]);
    } finally {
      CONTACTS.pop();
    }
  });

  it("never serves a stage the judgment model hesitated on", async () => {
    STAGE_ANSWERS["Quote sent"] = ["meeting_booked", 0.4];
    try {
      await seedConnection();
      await runSyncPass();

      const body = await funnelEvents();
      expect(body.hesitantStages).toBe(1);
      const alice = body.contacts.find((c) => c.externalContactId === "c1")!;
      // The calendar booking still stands; the hesitant stage entry does not.
      expect(alice.events.map((e) => e.source)).toEqual(["appointment"]);

      const res = await request(app())
        .get(`/orgs/gohighlevel/stage-meanings?brandId=${BRAND}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG);
      const quote = res.body.stageMeanings.find((m: { stageName: string }) => m.stageName === "Quote sent");
      expect(quote).toMatchObject({ meaning: "meeting_booked", confidence: 0.4, servedAsEvidence: false });
    } finally {
      STAGE_ANSWERS["Quote sent"] = ["meeting_booked", 1];
    }
  });

  it("pages the funnel events over contacts, each visited once, and reads one contact", async () => {
    await seedConnection();
    await runSyncPass();

    const seen: string[] = [];
    for (let offset = 0; ; ) {
      const page = await funnelEvents(`&limit=1&offset=${offset}`);
      seen.push(...page.contacts.map((c) => c.externalContactId));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(seen.sort()).toEqual(["c1", "c2", "c3"]);

    const all = await funnelEvents();
    const bob = all.contacts.find((c) => c.externalContactId === "c2")!;
    const one = await funnelEvents(`&contactId=${bob.contactId}`);
    expect(one.totalContacts).toBe(1);
    expect(one.contacts[0].events).toEqual(bob.events);

    const otherOrg = await request(app())
      .get(`/orgs/gohighlevel/funnel-events?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", "bbbbbbbb-1111-4111-8111-00000000000f");
    expect(otherOrg.body.totalContacts).toBe(0);
  });

  it("disconnecting drops the appointments, the history and the stage meanings", async () => {
    const connectionId = await seedConnection();
    await runSyncPass(connectionId);

    await request(app())
      .delete(`/orgs/gohighlevel/connections/${connectionId}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);

    expect(await db.select().from(ghlAppointments)).toHaveLength(0);
    expect(await db.select().from(ghlOpportunityHistory)).toHaveLength(0);
    expect(await db.select().from(ghlStageMeanings)).toHaveLength(0);
    expect(await db.select().from(ghlFormSubmissions)).toHaveLength(0);
  });
});
