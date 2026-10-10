import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  contactUploads,
  conversations,
  ghlAppointments,
  ghlConnections,
  ghlFormSubmissions,
  ghlOpportunities,
  ghlOpportunityHistory,
  ghlStageMeanings,
  matrixConnections,
  matrixRawEvents,
  people,
  peopleFacts,
  peopleMessageTexts,
  peopleScopes,
  posthogActivities,
  posthogConnections,
  stripeConnections,
  stripeTransactions,
  type PeopleScope,
} from "../../src/db/schema.js";
import { emitScopeFacts, readFacts } from "../../src/lib/people/facts.js";
import { readFunnelEvents } from "../../src/lib/gohighlevel/funnel-events.js";
import type { Presence } from "../../src/lib/people/identity.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * The people fact feed against a real Postgres (gated on CRM_TEST_DB). Silver
 * and the people rows are written directly; the emission is what is tested.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "fac7fac7-1111-4111-8111-000000000001";
const BRAND = "fac7fac7-1111-4111-8111-000000000002";
const USER = "user-facts-1";
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

const presence = (source: Presence["source"], sourceRef: string, detail: Record<string, unknown>, emails: string[] = [], phones: string[] = []): Presence => ({
  source,
  sourceRef,
  displayName: null,
  company: null,
  emails,
  phones,
  firstActivityAt: null,
  lastActivityAt: null,
  messageCount: null,
  inboundCount: null,
  outboundCount: null,
  detail,
});

async function setPeople(scope: PeopleScope, persons: { personKey: string; emails: string[]; phones: string[]; presences: Presence[]; name?: string }[]) {
  await db.delete(people).where(eq(people.scopeId, scope.id));
  if (persons.length === 0) return;
  await db.insert(people).values(
    persons.map((p) => ({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personKey: p.personKey,
      identityKeys: [...p.emails.map((e) => `email:${e}`), ...p.phones.map((x) => `phone:${x}`)],
      displayName: p.name ?? null,
      emails: p.emails,
      phones: p.phones,
      sources: [...new Set(p.presences.map((x) => x.source))],
      presences: p.presences,
      mergeEvidence: [],
      state: "in_conversation",
      stateSource: "test",
    })),
  );
}

interface Seeded {
  scope: PeopleScope;
  ghlId: string;
  aliceGhl: string;
  aliceWa: string;
  posthogContact: string;
  stripeContact: string;
}

/**
 * Alice: GoHighLevel (email + phone; created through a form; a booked-and-held
 * appointment; an opportunity seen in a "Booked" stage then won; a form
 * submission), WhatsApp (phone), Gmail (in + out + a third party), PostHog
 * (one visit), Stripe (a payment + an active subscription). Plus a CSV-only
 * person, and a GoHighLevel contact the build holds as nobody (our own address).
 */
async function seed(): Promise<Seeded> {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();

  const [ghl] = await db.insert(ghlConnections).values({ orgId: ORG, brandId: BRAND, locationId: "loc", createdByUserId: USER, lastSyncedAt: new Date() }).returning();
  const [aliceGhl] = await db
    .insert(contacts)
    .values({
      orgId: ORG,
      brandId: BRAND,
      source: "gohighlevel",
      externalId: "ghl-alice",
      primaryEmail: "alice@x.com",
      phoneE164: "+33612345678",
      fullName: "Alice Martin",
      rawAttributes: {},
      originMedium: "form",
      leadSource: "Meta Ads",
      sourceCreatedAt: new Date("2026-08-01T10:00:00Z"),
      sourceConnectionId: ghl.id,
    })
    .returning();
  await db.insert(contacts).values({
    orgId: ORG,
    brandId: BRAND,
    source: "gohighlevel",
    externalId: "ghl-own",
    primaryEmail: "kevin@brand.com",
    rawAttributes: {},
    sourceCreatedAt: new Date("2026-08-01T11:00:00Z"),
    sourceConnectionId: ghl.id,
  });
  await db.insert(ghlAppointments).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: ghl.id,
    externalId: "appt-1",
    calendarName: "Discovery",
    status: "showed",
    externalContactId: "ghl-alice",
    contactId: aliceGhl.id,
    bookedAt: new Date("2026-08-02T09:00:00Z"),
    startsAt: new Date("2026-08-05T14:00:00Z"),
  });
  await db.insert(ghlOpportunities).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: ghl.id,
    externalId: "opp-1",
    name: "Alice deal",
    status: "won",
    monetaryValue: "1500.50",
    externalContactId: "ghl-alice",
    contactId: aliceGhl.id,
  });
  await db.insert(ghlOpportunityHistory).values([
    { orgId: ORG, brandId: BRAND, connectionId: ghl.id, opportunityExternalId: "opp-1", externalContactId: "ghl-alice", kind: "stage", value: "st-booked", pipelineName: "Sales", stageName: "Booked", changedAt: new Date("2026-08-02T09:05:00Z") },
    // GoHighLevel gave no date for this status change: served as null, never invented.
    { orgId: ORG, brandId: BRAND, connectionId: ghl.id, opportunityExternalId: "opp-1", externalContactId: "ghl-alice", kind: "status", value: "won", pipelineName: "Sales", stageName: "Booked", changedAt: null },
  ]);
  await db.insert(ghlStageMeanings).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: ghl.id,
    stageExternalId: "st-booked",
    stageName: "Booked",
    meaning: "meeting_booked",
    confidence: 0.95,
    probabilities: {},
    model: "jev-test",
    runId: "run-x",
  });
  await db.insert(ghlFormSubmissions).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: ghl.id,
    externalId: "sub-1",
    formExternalId: "form-1",
    formName: "Free trial",
    externalContactId: "ghl-alice",
    contactId: aliceGhl.id,
    submittedAt: new Date("2026-08-01T09:59:58Z"),
  });

  const [mx] = await db
    .insert(matrixConnections)
    .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: "@me:hs", counterpartPrefix: "@whatsapp_", createdByUserId: USER })
    .returning();
  const [aliceWa] = await db
    .insert(contacts)
    .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_33612345678:hs", phoneE164: "+33612345678", fullName: "Alice", rawAttributes: {}, sourceConnectionId: mx.id })
    .returning();
  await db.insert(conversations).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: mx.id,
    contactId: aliceWa.id,
    channel: "whatsapp",
    roomId: "!room",
    firstMessageAt: new Date("2026-09-04T12:00:00Z"),
    lastMessageAt: new Date("2026-09-04T12:05:00Z"),
    messageCount: 2,
    inboundCount: 1,
    outboundCount: 1,
    lastEventId: "$e2",
  });
  await db.insert(matrixRawEvents).values([
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$e1", roomId: "!room", sender: "@whatsapp_33612345678:hs", eventType: "m.room.message", originServerTs: new Date("2026-09-04T12:00:00Z"), payload: { content: { body: "Hello on WhatsApp", msgtype: "m.text" } } },
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$e2", roomId: "!room", sender: "@me:hs", eventType: "m.room.message", originServerTs: new Date("2026-09-04T12:05:00Z"), payload: { content: { body: "Hi Alice", msgtype: "m.text" } } },
  ]);

  const gmailItem = (id: string, direction: string, at: string, text: string) => ({
    at,
    source: "gmail",
    channel: "email",
    kind: "message",
    direction,
    subject: "Intro",
    text,
    from: direction === "inbound" ? "alice@x.com" : "me@brand.com",
    to: [],
    ref: { gmailMessageId: id, threadId: "t1", bodyStatus: "ok" },
    textClean: { status: "cleaned", cleaned: true, original: text },
    event: null,
  });
  await db.insert(peopleMessageTexts).values(
    [
      gmailItem("g1", "outbound", "2026-09-01T09:00:00.000Z", "Hi Alice"),
      gmailItem("g2", "inbound", "2026-09-03T09:00:00.000Z", "Sure, call me"),
      gmailItem("g3", "other", "2026-09-03T10:00:00.000Z", "A colleague chiming in"),
    ].map((item) => ({
      scopeId: scope.id,
      source: "gmail",
      unit: "alice@x.com",
      address: "alice@x.com",
      messageKey: item.ref.gmailMessageId,
      at: new Date(item.at),
      direction: item.direction,
      subject: item.subject,
      body: item.text,
      searchText: item.text,
      item,
    })),
  );

  const [ph] = await db.insert(posthogConnections).values({ orgId: ORG, brandId: BRAND, projectId: "1", region: "eu", createdByUserId: USER, lastSyncedAt: new Date() }).returning();
  const [phContact] = await db
    .insert(contacts)
    .values({ orgId: ORG, brandId: BRAND, source: "posthog", externalId: "ph-alice", primaryEmail: "alice@x.com", rawAttributes: {}, sourceCreatedAt: new Date("2026-07-30T08:00:00Z"), sourceConnectionId: ph.id })
    .returning();
  await db.insert(posthogActivities).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: ph.id,
    kind: "visit",
    externalId: "s1:ph-alice",
    externalPersonId: "ph-alice",
    contactId: phContact.id,
    occurredAt: new Date("2026-07-30T08:00:00Z"),
    endedAt: new Date("2026-07-30T08:10:00Z"),
    name: "/pricing",
    url: "https://brand.com/pricing",
    pageviews: 3,
    detail: { sessionId: "s1", paths: ["/pricing"], referrer: null },
  });

  const [st] = await db.insert(stripeConnections).values({ orgId: ORG, brandId: BRAND, keyMode: "live", createdByUserId: USER, lastSyncedAt: new Date() }).returning();
  const [stContact] = await db
    .insert(contacts)
    .values({ orgId: ORG, brandId: BRAND, source: "stripe", externalId: "cus_alice", primaryEmail: "alice@x.com", rawAttributes: {}, sourceConnectionId: st.id })
    .returning();
  await db.insert(stripeTransactions).values([
    { orgId: ORG, brandId: BRAND, connectionId: st.id, kind: "payment", externalId: "ch_1", externalCustomerId: "cus_alice", contactId: stContact.id, occurredAt: new Date("2026-08-10T10:00:00Z"), amountMinor: 9900, currency: "usd", status: "succeeded", detail: { refunded: false, amountRefunded: 0 } },
    { orgId: ORG, brandId: BRAND, connectionId: st.id, kind: "subscription", externalId: "sub_1", externalCustomerId: "cus_alice", contactId: stContact.id, occurredAt: new Date("2026-08-10T10:00:00Z"), amountMinor: 9900, currency: "usd", status: "active", detail: { interval: "month", cancelAtPeriodEnd: false, canceledAt: null } },
  ]);

  const [upload] = await db
    .insert(contactUploads)
    .values({ orgId: ORG, brandId: BRAND, filename: "crm.csv", contentHash: "h", rowCount: 1, columnHeaders: [], status: "promoted", runId: "run-x" })
    .returning();
  await db.insert(contacts).values({ orgId: ORG, brandId: BRAND, source: "csv", primaryEmail: "carol@z.com", fullName: "Carol", rawAttributes: {}, sourceUploadId: upload.id });

  await setPeople(scope, [
    {
      personKey: "email:alice@x.com",
      emails: ["alice@x.com"],
      phones: ["+33612345678"],
      name: "Alice Martin",
      presences: [
        presence("gohighlevel", aliceGhl.id, { contactId: aliceGhl.id, externalId: "ghl-alice" }, ["alice@x.com"], ["+33612345678"]),
        presence("matrix", aliceWa.id, { contactId: aliceWa.id, channelHandle: "@whatsapp_33612345678:hs" }, [], ["+33612345678"]),
        presence("gmail", "alice@x.com", {}, ["alice@x.com"]),
        presence("posthog", phContact.id, { contactId: phContact.id, externalId: "ph-alice" }, ["alice@x.com"]),
        presence("stripe", stContact.id, { contactId: stContact.id, externalId: "cus_alice" }, ["alice@x.com"]),
      ],
    },
  ]);
  return { scope, ghlId: ghl.id, aliceGhl: aliceGhl.id, aliceWa: aliceWa.id, posthogContact: phContact.id, stripeContact: stContact.id };
}

const csvRow = (facts: { source: string; crmContactId: string | null }[]) => facts.find((f) => f.source === "csv")!;

async function allFacts() {
  const out = [];
  let since = 0;
  for (;;) {
    const page = await readFacts({ since, limit: 1000, orgId: ORG, brandId: BRAND });
    out.push(...page.facts);
    since = Number(page.nextCursor);
    if (!page.hasMore) break;
  }
  return out;
}

const maxSeq = async () => {
  const [r] = (await db.execute(sql`SELECT coalesce(max(feed_seq), 0)::bigint AS m FROM people_facts`)) as unknown as { m: string }[];
  return Number(r.m);
};

describe.skipIf(!RUN)("people fact feed (real DB)", () => {
  // Leave nothing behind: other suites share these tables (and once shared a brand id).
  const wipe = () =>
    db.execute(sql`TRUNCATE people_facts, people_scopes, people, people_message_texts, matrix_raw_events, conversations, matrix_connections, ghl_appointments, ghl_form_submissions, ghl_opportunity_history, ghl_stage_meanings, ghl_opportunities, ghl_connections, posthog_activities, posthog_connections, stripe_transactions, stripe_connections, contact_uploads, contacts CASCADE`);
  beforeEach(async () => {
    stubRuns();
    await wipe();
  });
  afterAll(wipe);

  it("backfills every source's history with vendor dates, untagged, without our own outreach", async () => {
    const s = await seed();
    const summary = await emitScopeFacts(s.scope);
    const facts = await allFacts();

    const types = facts.map((f) => `${f.source}:${f.type}`).sort();
    expect(types).toEqual(
      [
        "csv:added_to_crm",
        "gmail:message_in",
        "gmail:message_out",
        "gohighlevel:added_to_crm",
        "gohighlevel:deal_status_changed",
        "gohighlevel:deal_status_changed",
        "gohighlevel:form_submitted", // form_origin
        "gohighlevel:form_submitted", // form_submission
        "gohighlevel:meeting_attended",
        "gohighlevel:meeting_booked", // appointment
        "gohighlevel:meeting_booked", // stage entry
        "gohighlevel:sale",
        "matrix:message_in",
        "matrix:message_out",
        "posthog:signup",
        "posthog:website_visit",
        "stripe:payment",
        "stripe:subscription_changed",
      ].sort(),
    );
    // The third party in the Gmail thread is not the person; our own address is nobody.
    expect(summary.gmailOtherSkipped).toBe(1);
    expect(summary.held).toBe(1);
    expect(facts.some((f) => f.sourceRef === "ghl-own")).toBe(false);

    for (const f of facts) {
      expect(f.factId).toMatch(/^[0-9a-f-]{36}$/);
      expect(f.orgId).toBe(ORG);
      expect(f.brandId).toBe(BRAND);
      expect(typeof f.dateBasis).toBe("string");
      expect(f.withdrawnOf).toBeUndefined();
    }
    // Every fact backed by a contact row names it; lead-service pairs on that id.
    expect(facts.filter((f) => f.source === "gohighlevel").every((f) => f.crmContactId === s.aliceGhl)).toBe(true);
    expect(csvRow(facts).crmContactId).toMatch(/^[0-9a-f-]{36}$/);
    const alice = facts.filter((f) => f.source !== "csv");
    expect(new Set(alice.map((f) => f.personKey))).toEqual(new Set(["email:alice@x.com"]));
    expect(alice[0].emails).toEqual(["alice@x.com"]);
    expect(alice[0].phones).toEqual(["+33612345678"]);
    expect(alice[0].fullName).toBe("Alice Martin");

    const csv = facts.find((f) => f.source === "csv")!;
    expect(csv).toMatchObject({ personKey: "email:carol@z.com", emails: ["carol@z.com"], fullName: "Carol", dateBasis: "uploaded_at", payload: { origin: "csv_import", filename: "crm.csv" } });

    const added = facts.find((f) => f.source === "gohighlevel" && f.type === "added_to_crm")!;
    expect(added).toMatchObject({ sourceContactId: "ghl-alice", crmContactId: s.aliceGhl, occurredAt: "2026-08-01T10:00:00.000Z", dateBasis: "created_at", payload: { origin: "form", leadSource: "Meta Ads" } });
    const sale = facts.find((f) => f.type === "sale")!;
    expect(sale).toMatchObject({ occurredAt: null, dateBasis: "status_changed_at", sourceRef: "opp-1", payload: { via: "won_status", amountMinor: 150050, amountVerbatim: "1500.50", currency: null } });
    const statusChange = facts.find((f) => f.type === "deal_status_changed" && (f.payload as { change: string }).change === "status")!;
    expect(statusChange.occurredAt).toBeNull();
    expect(facts.find((f) => f.type === "payment")).toMatchObject({ sourceContactId: "cus_alice", crmContactId: s.stripeContact, occurredAt: "2026-08-10T10:00:00.000Z", payload: { amountMinor: 9900, currency: "usd", status: "succeeded" } });
    expect(facts.find((f) => f.type === "subscription_changed")).toMatchObject({ dateBasis: "start_date", payload: { status: "active" } });
    expect(facts.find((f) => f.source === "matrix" && f.type === "message_in")).toMatchObject({ sourceContactId: "@whatsapp_33612345678:hs", crmContactId: s.aliceWa, occurredAt: "2026-09-04T12:00:00.000Z", payload: { channel: "whatsapp", text: "Hello on WhatsApp" } });
    expect(facts.find((f) => f.source === "gmail" && f.type === "message_in")).toMatchObject({ sourceRef: "g2", sourceContactId: null, crmContactId: null, payload: { text: "Sure, call me", textClean: { status: "cleaned", cleaned: true } } });
    expect(facts.find((f) => f.type === "website_visit")).toMatchObject({ sourceContactId: "ph-alice", crmContactId: s.posthogContact, payload: { pageviews: 3, firstUrl: "https://brand.com/pricing" } });
    // Facts are served in feed order.
    expect(facts.map((f) => Number(f.seq))).toEqual([...facts.map((f) => Number(f.seq))].sort((a, b) => a - b));
  });

  it("funnel facts are exactly the funnel-events evidence", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const fromFeed = (await allFacts())
      .filter((f) => f.source === "gohighlevel" && !["added_to_crm", "deal_status_changed"].includes(f.type))
      .map((f) => `${f.crmContactId}|${f.sourceContactId}|${f.type}|${f.occurredAt}|${f.dateBasis}|${(f.payload as { via: string }).via}|${f.sourceRef}`)
      .sort();
    const events = await readFunnelEvents({ orgId: ORG, brandId: BRAND, limit: 1000, offset: 0 });
    const fromEvents = events.contacts
      .flatMap((c) => c.events.map((e) => `${c.contactId}|${c.externalContactId}|${e.step}|${e.occurredAt}|${e.dateBasis}|${e.source}|${e.sourceId}`))
      .sort();
    expect(fromEvents.length).toBe(6);
    expect(fromFeed).toEqual(fromEvents);
  });

  it("a second pass with nothing changed emits nothing", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const before = await maxSeq();
    const again = await emitScopeFacts(s.scope);
    expect(again.emitted).toBe(0);
    expect(again.corrected + again.withdrawnGone + again.merged + again.split).toBe(0);
    expect(await maxSeq()).toBe(before);
  });

  it("a counterpart on two linked accounts of one channel never re-mints on every pass", async () => {
    const s = await seed();
    // The brand links a second WhatsApp; Alice writes to it too (same bridge handle, its own contact row).
    const [mx2] = await db
      .insert(matrixConnections)
      .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: "@rep:hs", counterpartPrefix: "@whatsapp_", createdByUserId: USER })
      .returning();
    const [aliceWa2] = await db
      .insert(contacts)
      .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_33612345678:hs", phoneE164: "+33612345678", fullName: "Alice", rawAttributes: {}, sourceConnectionId: mx2.id })
      .returning();
    await db.insert(conversations).values({
      orgId: ORG, brandId: BRAND, connectionId: mx2.id, contactId: aliceWa2.id, channel: "whatsapp", roomId: "!room2",
      firstMessageAt: new Date("2026-09-05T12:00:00Z"), lastMessageAt: new Date("2026-09-05T12:00:00Z"),
      messageCount: 1, inboundCount: 1, outboundCount: 0, lastEventId: "$e3",
    });
    await db.insert(matrixRawEvents).values({
      orgId: ORG, brandId: BRAND, connectionId: mx2.id, eventId: "$e3", roomId: "!room2", sender: "@whatsapp_33612345678:hs",
      eventType: "m.room.message", originServerTs: new Date("2026-09-05T12:00:00Z"), payload: { content: { body: "Hello rep", msgtype: "m.text" } },
    });
    await emitScopeFacts(s.scope);
    const facts = await allFacts();
    expect(facts.find((f) => f.sourceRef === "$e3")).toMatchObject({ crmContactId: aliceWa2.id });
    expect(facts.find((f) => f.sourceRef === "$e1")).toMatchObject({ crmContactId: s.aliceWa });
    const before = await maxSeq();
    const again = await emitScopeFacts(s.scope);
    expect(again.reminted).toBe(0);
    expect(again.emitted).toBe(0);
    expect(await maxSeq()).toBe(before);
  });

  it("a changed vendor record is withdrawn and re-stated; a vanished snapshot record is withdrawn", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const before = await allFacts();
    const attended = before.find((f) => f.type === "meeting_attended")!;
    const visit = before.find((f) => f.type === "website_visit")!;

    await db.update(ghlAppointments).set({ status: "noshow" }).where(eq(ghlAppointments.externalId, "appt-1"));
    await db.delete(posthogActivities).where(eq(posthogActivities.externalId, "s1:ph-alice"));
    const summary = await emitScopeFacts(s.scope);
    expect(summary).toMatchObject({ corrected: 1, withdrawnGone: 1, emitted: 1 });

    const added = (await readFacts({ since: Number(before[before.length - 1].seq), limit: 100 })).facts;
    const withdrawn = added.filter((f) => f.type === "withdrawn");
    expect(withdrawn.map((w) => w.withdrawnOf).sort()).toEqual([attended.factId, visit.factId].sort());
    expect(withdrawn.find((w) => w.withdrawnOf === attended.factId)!.crmContactId).toBe(s.aliceGhl);
    expect(withdrawn.find((w) => w.withdrawnOf === attended.factId)!.payload).toEqual({ reason: "vendor_record_changed", withdrawnType: "meeting_attended" });
    expect(withdrawn.find((w) => w.withdrawnOf === visit.factId)!.payload).toEqual({ reason: "vendor_record_gone", withdrawnType: "website_visit" });
    expect(added.find((f) => f.type === "meeting_not_held")).toMatchObject({ sourceRef: "appt-1", occurredAt: "2026-08-05T14:00:00.000Z", payload: { reason: "noshow" } });
    // Withdrawals come before the corrected fact.
    expect(Number(added.find((f) => f.type === "meeting_not_held")!.seq)).toBeGreaterThan(Number(withdrawn[0].seq));
    expect((await emitScopeFacts(s.scope)).emitted).toBe(0);
  });

  it("disconnecting a source stops its facts and withdraws none", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const before = await allFacts();
    const ghlBefore = before.filter((f) => f.source === "gohighlevel");
    expect(ghlBefore.length).toBeGreaterThan(0);
    const cursor = await maxSeq();

    // What DELETE /orgs/gohighlevel/connections/:id does: the connection and everything derived go.
    await db.delete(contacts).where(and(eq(contacts.brandId, BRAND), eq(contacts.source, "gohighlevel")));
    await db.delete(ghlConnections).where(eq(ghlConnections.id, s.ghlId));
    const [alice] = await db.select().from(people).where(eq(people.scopeId, s.scope.id));
    await setPeople(s.scope, [
      {
        personKey: "email:alice@x.com",
        emails: ["alice@x.com"],
        phones: ["+33612345678"],
        presences: (alice.presences as Presence[]).filter((p) => p.source !== "gohighlevel"),
      },
    ]);

    const summary = await emitScopeFacts(s.scope);
    expect(summary).toMatchObject({ emitted: 0, corrected: 0, withdrawnGone: 0 });
    const after = await readFacts({ since: cursor, limit: 100, orgId: ORG, brandId: BRAND });
    expect(after.facts).toEqual([]);
    const stored = await db.select().from(peopleFacts).where(eq(peopleFacts.source, "gohighlevel"));
    expect(stored.length).toBe(ghlBefore.length);
    expect(stored.every((f) => f.live)).toBe(true);
  });

  it("a reconnect re-mints contact rows: every fact naming the old row is withdrawn and re-stated with the new one", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const ghlBefore = (await allFacts()).filter((f) => f.source === "gohighlevel");
    expect(new Set(ghlBefore.map((f) => f.crmContactId))).toEqual(new Set([s.aliceGhl]));
    const cursor = await maxSeq();

    // Disconnect (the connection and everything derived go), then reconnect: the
    // first sync has mirrored the contact again under a NEW row id, nothing else yet.
    await db.delete(contacts).where(and(eq(contacts.brandId, BRAND), eq(contacts.source, "gohighlevel")));
    await db.delete(ghlConnections).where(eq(ghlConnections.id, s.ghlId));
    const [ghl2] = await db.insert(ghlConnections).values({ orgId: ORG, brandId: BRAND, locationId: "loc", createdByUserId: USER }).returning();
    const [alice2] = await db
      .insert(contacts)
      .values({ orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-alice", primaryEmail: "alice@x.com", phoneE164: "+33612345678", fullName: "Alice Martin", rawAttributes: {}, originMedium: "form", leadSource: "Meta Ads", sourceCreatedAt: new Date("2026-08-01T10:00:00Z"), sourceConnectionId: ghl2.id })
      .returning();
    const [alice] = await db.select().from(people).where(eq(people.scopeId, s.scope.id));
    await setPeople(s.scope, [
      {
        personKey: "email:alice@x.com",
        emails: ["alice@x.com"],
        phones: ["+33612345678"],
        name: "Alice Martin",
        presences: (alice.presences as Presence[]).map((p) => (p.source === "gohighlevel" ? { ...p, sourceRef: alice2.id, detail: { ...p.detail, contactId: alice2.id } } : p)),
      },
    ]);

    const summary = await emitScopeFacts(s.scope);
    // Not fully synced yet: nothing counts as gone; every GoHighLevel fact is re-stated once.
    expect(summary).toMatchObject({ withdrawnGone: 0, corrected: 0, reminted: ghlBefore.length, emitted: ghlBefore.length });
    const added = (await readFacts({ since: cursor, limit: 1000 })).facts;
    const withdrawn = added.filter((f) => f.type === "withdrawn");
    expect(withdrawn.map((w) => w.withdrawnOf).sort()).toEqual(ghlBefore.map((f) => f.factId).sort());
    expect(withdrawn.every((w) => (w.payload as { reason: string }).reason === "crm_contact_reminted")).toBe(true);
    const restated = added.filter((f) => f.type !== "withdrawn");
    expect(restated.every((f) => f.crmContactId === alice2.id && f.sourceContactId === "ghl-alice")).toBe(true);
    const same = (f: (typeof ghlBefore)[number]) => `${f.type}|${f.occurredAt}|${f.dateBasis}|${f.sourceRef}|${JSON.stringify(f.payload)}`;
    expect(restated.map(same).sort()).toEqual(ghlBefore.map(same).sort());
    expect(Math.min(...restated.map((f) => Number(f.seq)))).toBeGreaterThan(Math.max(...withdrawn.map((f) => Number(f.seq))));
    expect((await emitScopeFacts(s.scope)).emitted).toBe(0);
  });

  it("a person split partitions the old key's facts exactly; a merge names both keys", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const owned = (await allFacts()).filter((f) => f.personKey === "email:alice@x.com");

    // The evidence that tied Alice's phone to her email disappears: WhatsApp is a person of its own.
    const [alice] = await db.select().from(people).where(eq(people.scopeId, s.scope.id));
    const presences = alice.presences as Presence[];
    await setPeople(s.scope, [
      { personKey: "email:alice@x.com", emails: ["alice@x.com"], phones: [], presences: presences.filter((p) => p.source !== "matrix") },
      { personKey: "phone:+33612345678", emails: [], phones: ["+33612345678"], presences: presences.filter((p) => p.source === "matrix") },
    ]);
    const cursor = await maxSeq();
    expect((await emitScopeFacts(s.scope)).split).toBe(1);
    const [split] = (await readFacts({ since: cursor, limit: 100 })).facts;
    expect(split).toMatchObject({ type: "person_split", source: "crm", personKey: "email:alice@x.com", occurredAt: null });
    const parts = (split.payload as { parts: { personKey: string; factIds: string[] }[] }).parts;
    expect(parts.map((p) => p.personKey)).toEqual(["email:alice@x.com", "phone:+33612345678"]);
    const partIds = parts.flatMap((p) => p.factIds);
    expect(new Set(partIds).size).toBe(partIds.length); // each fact in exactly one part
    expect([...partIds].sort()).toEqual(owned.map((f) => f.factId).sort()); // and every fact of the old key
    expect(parts[1].factIds.sort()).toEqual(owned.filter((f) => f.source === "matrix").map((f) => f.factId).sort());
    expect((await emitScopeFacts(s.scope)).split).toBe(0);

    // Evidence ties them again: the phone person merges back into Alice.
    await setPeople(s.scope, [{ personKey: "email:alice@x.com", emails: ["alice@x.com"], phones: ["+33612345678"], presences }]);
    const cursor2 = await maxSeq();
    expect((await emitScopeFacts(s.scope)).merged).toBe(1);
    const [merged] = (await readFacts({ since: cursor2, limit: 100 })).facts;
    expect(merged).toMatchObject({
      type: "person_merged",
      personKey: "email:alice@x.com",
      payload: { fromPersonKey: "phone:+33612345678", intoPersonKey: "email:alice@x.com" },
    });
  });

  it("GET /internal/people/facts pages the feed by cursor", async () => {
    const s = await seed();
    await emitScopeFacts(s.scope);
    const a = express();
    a.use(express.json());
    a.use(peopleRoutes);
    const total = (await allFacts()).length;
    const seen: string[] = [];
    let since: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await request(a)
        .get("/internal/people/facts")
        .query({ limit: 7, brandId: BRAND, ...(since ? { since } : {}) })
        .set("x-api-key", API_KEY);
      expect(r.status).toBe(200);
      seen.push(...r.body.facts.map((f: { factId: string }) => f.factId));
      since = r.body.nextCursor;
      if (!r.body.hasMore) break;
    }
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    const empty = await request(a).get("/internal/people/facts").query({ since }).set("x-api-key", API_KEY);
    expect(empty.body).toEqual({ facts: [], nextCursor: since, hasMore: false });
    expect((await request(a).get("/internal/people/facts").query({ since: "abc" }).set("x-api-key", API_KEY)).status).toBe(400);
    expect((await request(a).get("/internal/people/facts")).status).toBe(401);
  });
});
