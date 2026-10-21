import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixRawEvents,
  people,
  peopleMessageTexts,
  peopleMessageUnits,
  peopleScopes,
  personIdAliases,
  whatsappSends,
} from "../../src/db/schema.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * POST /internal/people/relations/latest-messages against a real Postgres (gated on CRM_TEST_DB).
 * Scopes, people (with their relations), the message store and the Matrix mirror are written
 * directly: the read is what is tested (UNIBOX-LAST-MESSAGE-PREVIEW-1021).
 */
const RUN = !!process.env.CRM_TEST_DB;
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const ORG = "1a7e5700-1111-4111-8111-000000000001";
const BRAND = "1a7e5700-1111-4111-8111-00000000000b";
const BRAND_EMPTY = "1a7e5700-1111-4111-8111-00000000000c";

const P_ANDREAS = "1a7e5700-1111-4111-8111-0000000000a1";
const P_REPLIER = "1a7e5700-1111-4111-8111-0000000000a2";
const P_SILENT = "1a7e5700-1111-4111-8111-0000000000a3";
const P_FAILED = "1a7e5700-1111-4111-8111-0000000000a4";
const P_WA = "1a7e5700-1111-4111-8111-0000000000a5";
const P_MERGED = "1a7e5700-1111-4111-8111-0000000000a6";
const P_RETIRED = "1a7e5700-1111-4111-8111-0000000000a7";
const COMPANY = "1a7e5700-1111-4111-8111-0000000000c1";

const relKey = (personId: string) => `rel:${personId}:org:${COMPANY}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
const post = (body: unknown) => request(app()).post("/internal/people/relations/latest-messages").set("x-api-key", API_KEY).send(body);

const instantlyPresence = (email: string) => ({
  source: "instantly",
  sourceRef: email,
  displayName: null,
  company: null,
  emails: [email],
  phones: [],
  firstActivityAt: null,
  lastActivityAt: null,
  messageCount: null,
  inboundCount: null,
  outboundCount: null,
  detail: { campaignIds: ["camp-1"] },
});

const relation = (personId: string, points: { id: string; source: string }[], emails: string[], phones: string[] = []) => ({
  relationKey: relKey(personId),
  capacity: "professional",
  companyId: COMPANY,
  domain: "platomics.com",
  tags: [],
  contactPoints: points.map((p) => ({ ...p, companyBasis: "evidence" })),
  emails,
  phones,
  keys: [],
});

let scopeId = "";

async function wipe() {
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  await db.delete(personIdAliases).where(eq(personIdAliases.orgId, ORG));
  await db.delete(whatsappSends).where(eq(whatsappSends.orgId, ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
}

async function seed() {
  const [s] = await db
    .insert(peopleScopes)
    .values({
      orgId: ORG,
      brandId: BRAND,
      createdByUserId: "u",
      status: "built",
      lastBuiltAt: new Date("2026-10-21T06:00:00Z"),
      sourceReads: { sources: ["gmail", "instantly", "matrix"].map((source) => ({ source, status: source === "gmail" ? "not_connected" : "ok" })) },
    })
    .returning();
  scopeId = s.id;

  const person = (personId: string, key: string, presences: unknown[], relations: unknown[], emails: string[]) => ({
    scopeId,
    orgId: ORG,
    brandId: BRAND,
    personId,
    personKey: key,
    identityKeys: [key],
    emails,
    phones: [],
    sources: ["instantly"],
    presences,
    mergeEvidence: [],
    state: "in_conversation",
    stateSource: "instantly",
    relations,
  });

  const andreas = "andreas.oberleitner@platomics.com";
  const replier = "rita@platomics.com";
  const silent = "sam@platomics.com";
  const failed = "fred@platomics.com";
  const merged = "mia@platomics.com";

  // WhatsApp: the person's DM, our last message there is an automated send.
  const [mx] = await db
    .insert(matrixConnections)
    .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: "@me:hs", counterpartPrefix: "@whatsapp_", createdByUserId: "u" })
    .returning();
  const [waContact] = await db
    .insert(contacts)
    .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_lid-wendy:hs", fullName: "Wendy", rawAttributes: {}, sourceConnectionId: mx.id })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({
      orgId: ORG,
      brandId: BRAND,
      connectionId: mx.id,
      contactId: waContact.id,
      channel: "whatsapp",
      roomId: "!wendy",
      firstMessageAt: new Date("2026-10-19T09:00:00Z"),
      lastMessageAt: new Date("2026-10-20T09:00:00Z"),
      messageCount: 2,
      inboundCount: 1,
      outboundCount: 1,
      lastEventId: "$w2",
    })
    .returning();
  await db.insert(matrixRawEvents).values([
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$w1", roomId: "!wendy", sender: "@whatsapp_lid-wendy:hs", eventType: "m.room.message", originServerTs: new Date("2026-10-19T09:00:00Z"), payload: { content: { body: "Hi, is this still available?" } } },
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$w2", roomId: "!wendy", sender: "@me:hs", eventType: "m.room.message", originServerTs: new Date("2026-10-20T09:00:00Z"), payload: { content: { body: "Yes it is, want a call?" } } },
    // Not a message: a membership event later than both never answers.
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$w3", roomId: "!wendy", sender: "@me:hs", eventType: "m.room.member", stateKey: "@me:hs", originServerTs: new Date("2026-10-21T09:00:00Z"), payload: { content: { membership: "join" } } },
  ]);
  await db.insert(whatsappSends).values({ orgId: ORG, brandId: BRAND, idempotencyKey: "k1", roomId: "!wendy", eventId: "$w2", text: "Yes it is, want a call?", status: "sent" });
  const waPresence = {
    source: "matrix",
    sourceRef: waContact.id,
    displayName: "Wendy",
    company: null,
    emails: [],
    phones: [],
    firstActivityAt: null,
    lastActivityAt: null,
    messageCount: 2,
    inboundCount: 1,
    outboundCount: 1,
    detail: { conversationId: conv.id, channel: "whatsapp", channelHandle: "@whatsapp_lid-wendy:hs" },
  };

  await db.insert(people).values([
    person(P_ANDREAS, `email:${andreas}`, [instantlyPresence(andreas)], [relation(P_ANDREAS, [{ id: `instantly:${andreas}`, source: "instantly" }], [andreas])], [andreas]),
    person(P_REPLIER, `email:${replier}`, [instantlyPresence(replier)], [relation(P_REPLIER, [{ id: `instantly:${replier}`, source: "instantly" }], [replier])], [replier]),
    person(P_SILENT, `email:${silent}`, [instantlyPresence(silent)], [relation(P_SILENT, [{ id: `instantly:${silent}`, source: "instantly" }], [silent])], [silent]),
    person(P_FAILED, `email:${failed}`, [instantlyPresence(failed)], [relation(P_FAILED, [{ id: `instantly:${failed}`, source: "instantly" }], [failed])], [failed]),
    person(P_WA, "matrix:wendy", [waPresence], [relation(P_WA, [{ id: "matrix:@whatsapp_lid-wendy:hs", source: "matrix" }], [])], []),
    person(P_MERGED, `email:${merged}`, [instantlyPresence(merged)], [relation(P_MERGED, [{ id: `instantly:${merged}`, source: "instantly" }], [merged])], [merged]),
  ]);
  await db.insert(personIdAliases).values({ orgId: ORG, brandId: BRAND, retiredId: P_RETIRED, personId: P_MERGED });

  const stored = (address: string, at: string, direction: string, body: string, outreachFact: unknown = null) => ({
    scopeId,
    source: "instantly",
    unit: `camp-1:${address}`,
    address,
    messageKey: `${direction}|${at}|x|${address}`,
    at: new Date(at),
    direction,
    subject: "Re: regulatory releases",
    body,
    searchText: body,
    item: {
      at,
      source: "instantly",
      channel: "email",
      kind: "message",
      direction,
      subject: "Re: regulatory releases",
      text: body,
      from: direction === "outbound" ? "kevin@getdistribute.com" : address,
      to: [direction === "outbound" ? address : "kevin@getdistribute.com"],
      ref: { campaignId: "camp-1", instantlyCampaignId: "ic-1" },
      textClean: null,
      outreachFact,
      event: null,
    },
  });
  const LONG = "Last note from me, Andreas.\n\nIf a call feels like too much right now, there's a " + "x".repeat(700);
  await db.insert(peopleMessageTexts).values([
    stored(andreas, "2026-10-10T17:32:50.277Z", "outbound", "Hey Andreas,\n\nSaw you started as VP", { subjectKey: "ievt:1", step: 1, position: "first" }),
    stored(andreas, "2026-10-21T05:08:53.212Z", "outbound", LONG, { subjectKey: "ievt:3", step: 3, position: "followup" }),
    stored(andreas, "2026-10-13T17:57:50.103Z", "outbound", "Andreas, one more angle.", { subjectKey: "ievt:2", step: 2, position: "followup" }),
    stored(replier, "2026-10-12T08:00:00.000Z", "outbound", "Hi Rita", { subjectKey: "ievt:4", step: 1, position: "first" }),
    stored(replier, "2026-10-14T10:00:00.000Z", "inbound", "Sounds interesting, send me more."),
    stored(merged, "2026-10-15T10:00:00.000Z", "outbound", "Hi Mia", null),
  ]);
  const unit = (address: string, status: string, error: string | null = null) => ({
    scopeId,
    source: "instantly",
    unit: `camp-1:${address}`,
    address,
    status,
    error,
    runId: "r",
    format: 4,
  });
  await db.insert(peopleMessageUnits).values([unit(andreas, "ok"), unit(replier, "ok"), unit(silent, "ok"), unit(failed, "failed", "instantly-service returned 502"), unit(merged, "ok")]);
}

describe.skipIf(!RUN)("POST /internal/people/relations/latest-messages", () => {
  beforeAll(async () => {
    stubRuns();
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it("answers the latest message of each relation, each status stated", async () => {
    const res = await post({
      orgId: ORG,
      brandId: BRAND,
      relationKeys: [relKey(P_ANDREAS), relKey(P_REPLIER), relKey(P_SILENT), relKey(P_FAILED), relKey(P_WA), relKey(P_ANDREAS), "rel:nope", `rel:${P_ANDREAS}:personal`, relKey("1a7e5700-1111-4111-8111-0000000000ff")],
    });
    expect(res.status).toBe(200);
    const by = new Map(res.body.relations.map((r: { relationKey: string }) => [r.relationKey, r]));
    // One answer per distinct key, in the order asked.
    expect(res.body.relations.map((r: { relationKey: string }) => r.relationKey)).toEqual([
      relKey(P_ANDREAS),
      relKey(P_REPLIER),
      relKey(P_SILENT),
      relKey(P_FAILED),
      relKey(P_WA),
      "rel:nope",
      `rel:${P_ANDREAS}:personal`,
      relKey("1a7e5700-1111-4111-8111-0000000000ff"),
    ]);

    // AC: our outbound cold email of 2026-10-21 05:08 UTC, "Last note from me, Andreas."
    const a = by.get(relKey(P_ANDREAS)) as any;
    expect(a.status).toBe("message");
    expect(a.message).toMatchObject({
      at: "2026-10-21T05:08:53.212Z",
      source: "instantly",
      channel: "email",
      direction: "outbound",
      sentBy: "automation",
      subject: "Re: regulatory releases",
      textBasis: "original",
      textTruncated: true,
    });
    expect(a.message.text.startsWith("Last note from me, Andreas.")).toBe(true);
    expect(Array.from(a.message.text).length).toBe(500);
    expect(a.gaps).toEqual([]);

    // Their reply is the latest: inbound, nobody of ours wrote it.
    const r = by.get(relKey(P_REPLIER)) as any;
    expect(r.status).toBe("message");
    expect(r.message).toMatchObject({ direction: "inbound", sentBy: null, text: "Sounds interesting, send me more.", from: "rita@platomics.com" });

    // Read, nothing exchanged: no_message, stated.
    expect(by.get(relKey(P_SILENT))).toMatchObject({ status: "no_message", reason: null, message: null, gaps: [] });

    // Could not read, nothing stored: unreadable, never no_message.
    expect(by.get(relKey(P_FAILED))).toMatchObject({
      status: "unreadable",
      reason: "source_unreadable",
      message: null,
      gaps: [{ source: "instantly", address: "fred@platomics.com", reason: "read_failed", error: "instantly-service returned 502" }],
    });

    // WhatsApp: our automated send is the latest message (a later membership event is no message).
    expect((by.get(relKey(P_WA)) as any).message).toMatchObject({
      at: "2026-10-20T09:00:00.000Z",
      source: "matrix",
      channel: "whatsapp",
      direction: "outbound",
      sentBy: "automation",
      text: "Yes it is, want a call?",
      textBasis: "as_written",
    });

    expect(by.get("rel:nope")).toMatchObject({ status: "unknown", reason: "not_a_relation_key" });
    expect(by.get(`rel:${P_ANDREAS}:personal`)).toMatchObject({ status: "unknown", reason: "relation_not_found" });
    expect(by.get(relKey("1a7e5700-1111-4111-8111-0000000000ff"))).toMatchObject({ status: "unknown", reason: "person_not_found" });
    expect(res.body.counts).toEqual({ message: 3, no_message: 1, unreadable: 1, unknown: 3 });
  });

  it("a hand-typed WhatsApp message of the brand is sentBy person", async () => {
    await db.delete(whatsappSends).where(eq(whatsappSends.orgId, ORG));
    const res = await post({ orgId: ORG, brandId: BRAND, relationKeys: [relKey(P_WA)] });
    expect(res.body.relations[0].message).toMatchObject({ direction: "outbound", sentBy: "person" });
  });

  it("a cold-email send tied to no sequence step does not claim automation", async () => {
    const res = await post({ orgId: ORG, brandId: BRAND, relationKeys: [relKey(P_MERGED)] });
    expect(res.body.relations[0].message).toMatchObject({ direction: "outbound", sentBy: null, text: "Hi Mia" });
  });

  it("a relation key naming a retired person id: the relation is rebuilt under the surviving id, so unknown", async () => {
    // The person moved under P_MERGED: the retired id's relation is not held (rebuilt under the new id).
    const res = await post({ orgId: ORG, brandId: BRAND, relationKeys: [relKey(P_RETIRED)] });
    expect(res.body.relations[0]).toMatchObject({ status: "unknown", reason: "relation_not_found" });
  });

  it("a brand with no people scope answers every key unknown scope_not_built", async () => {
    const res = await post({ orgId: ORG, brandId: BRAND_EMPTY, relationKeys: [relKey(P_ANDREAS)] });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBeNull();
    expect(res.body.relations[0]).toMatchObject({ status: "unknown", reason: "scope_not_built" });
  });

  it("refuses a bad body", async () => {
    expect((await post({ orgId: ORG, brandId: BRAND, relationKeys: [] })).status).toBe(400);
    expect((await post({ orgId: "x", brandId: BRAND, relationKeys: ["rel:a"] })).status).toBe(400);
    expect((await post({ orgId: ORG, brandId: BRAND, relationKeys: Array.from({ length: 1001 }, (_, i) => `rel:${i}`) })).status).toBe(400);
    expect((await request(app()).post("/internal/people/relations/latest-messages").send({})).status).toBe(401);
  });
});
