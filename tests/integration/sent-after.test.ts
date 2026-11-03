import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixGhostPhones,
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
 * POST /internal/people/sent-after against a real Postgres (gated on CRM_TEST_DB): did the brand write to
 * each person after T, any channel, any sender (UNSENT-ANSWERED-ELSEWHERE-1103). Scopes, people, the message
 * store and the Matrix mirror are written directly: the read is what is tested.
 */
const RUN = !!process.env.CRM_TEST_DB;
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const ORG = "5e47af7e-1111-4111-8111-000000000001";
const BRAND = "5e47af7e-1111-4111-8111-00000000000b";
const BRAND_EMPTY = "5e47af7e-1111-4111-8111-00000000000c";

const P_SENTHIL = "5e47af7e-1111-4111-8111-0000000000a1";
const P_EMAIL = "5e47af7e-1111-4111-8111-0000000000a2";
const P_PHONE = "5e47af7e-1111-4111-8111-0000000000a3";
const P_LID = "5e47af7e-1111-4111-8111-0000000000a4";
const P_FAILED = "5e47af7e-1111-4111-8111-0000000000a5";
const P_MERGED = "5e47af7e-1111-4111-8111-0000000000a6";
const P_RETIRED = "5e47af7e-1111-4111-8111-0000000000a7";
const H_SENTHIL = "5e47af7e-1111-4111-8111-0000000000d1";
const COMPANY_A = "5e47af7e-1111-4111-8111-0000000000c1";
const COMPANY_B = "5e47af7e-1111-4111-8111-0000000000c2";
const LID_GHOST = "@whatsapp_lid-777:hs";

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
const post = (body: unknown) => request(app()).post("/internal/people/sent-after").set("x-api-key", API_KEY).send(body);

let scopeId = "";

async function wipe() {
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  await db.delete(personIdAliases).where(eq(personIdAliases.orgId, ORG));
  await db.delete(whatsappSends).where(eq(whatsappSends.orgId, ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
  await db.delete(matrixGhostPhones).where(eq(matrixGhostPhones.ghostMxid, LID_GHOST));
}

const matrixPresence = (contactId: string, conversationId: string, handle: string) => ({
  source: "matrix",
  sourceRef: contactId,
  displayName: null,
  company: null,
  emails: [],
  phones: [],
  firstActivityAt: null,
  lastActivityAt: null,
  messageCount: 2,
  inboundCount: 1,
  outboundCount: 1,
  detail: { conversationId, channel: "whatsapp", channelHandle: handle },
});
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

async function seed() {
  const [s] = await db
    .insert(peopleScopes)
    .values({
      orgId: ORG,
      brandId: BRAND,
      createdByUserId: "u",
      status: "built",
      lastBuiltAt: new Date(),
      sourceReads: { sources: ["gmail", "instantly", "matrix"].map((source) => ({ source, status: source === "gmail" ? "not_connected" : "ok" })) },
    })
    .returning();
  scopeId = s.id;

  const [mx] = await db
    .insert(matrixConnections)
    .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: "@me:hs", counterpartPrefix: "@whatsapp_", createdByUserId: "u", lastSyncedAt: new Date() })
    .returning();

  // One DM per WhatsApp person: their message, then the brand's account answering (or not).
  async function dm(handle: string, room: string, events: { id: string; sender: string; at: string; body: string; content?: Record<string, unknown> }[]) {
    const [c] = await db
      .insert(contacts)
      .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: handle, rawAttributes: {}, sourceConnectionId: mx.id })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ orgId: ORG, brandId: BRAND, connectionId: mx.id, contactId: c.id, channel: "whatsapp", roomId: room, firstMessageAt: new Date(events[0].at), lastMessageAt: new Date(events[events.length - 1].at), messageCount: events.length, inboundCount: 1, outboundCount: 1, lastEventId: events[events.length - 1].id })
      .returning();
    await db.insert(matrixRawEvents).values(
      events.map((e) => ({
        orgId: ORG,
        brandId: BRAND,
        connectionId: mx.id,
        eventId: e.id,
        roomId: room,
        sender: e.sender,
        eventType: "m.room.message",
        originServerTs: new Date(e.at),
        payload: { content: e.content ?? { msgtype: "m.text", body: e.body } },
      })),
    );
    return { contactId: c.id, conversationId: conv.id };
  }

  const senthil = await dm("@whatsapp_lid-senthil:hs", "!senthil", [
    { id: "$s1", sender: "@whatsapp_lid-senthil:hs", at: "2026-11-02T14:34:04Z", body: "reaching to the heads in those companies." },
    { id: "$s2", sender: "@me:hs", at: "2026-11-02T15:08:13.678Z", body: "Love that, mid-size and smaller is where proof gets built fast" },
    { id: "$s3", sender: "@me:hs", at: "2026-11-02T15:08:17.740Z", body: "I'll set up a mid-size audience on all three brands" },
  ]);
  await db.insert(whatsappSends).values({ orgId: ORG, brandId: BRAND, idempotencyKey: "k-s2", roomId: "!senthil", eventId: "$s2", text: "Love that, mid-size and smaller is where proof gets built fast", status: "sent", sentAt: new Date("2026-11-02T15:08:13.678Z") });
  const phone = await dm("@whatsapp_33612345678:hs", "!phone", [
    { id: "$p1", sender: "@whatsapp_33612345678:hs", at: "2026-11-01T10:00:00Z", body: "Hello?" },
    // The brand typed it by hand: no send row.
    { id: "$p2", sender: "@me:hs", at: "2026-11-01T11:00:00Z", body: "Hi Paul, here." },
    // An edit later is no new message; a bridge notice is none either.
    { id: "$p3", sender: "@me:hs", at: "2026-11-01T12:00:00Z", body: "* Hi Paul, here!", content: { msgtype: "m.text", body: "* Hi Paul, here!", "m.relates_to": { rel_type: "m.replace", event_id: "$p2" } } },
    { id: "$p4", sender: "@me:hs", at: "2026-11-01T12:30:00Z", body: "Failed to bridge", content: { msgtype: "m.notice", body: "Failed to bridge" } },
  ]);
  const lid = await dm(LID_GHOST, "!lid", [
    { id: "$l1", sender: LID_GHOST, at: "2026-11-01T10:00:00Z", body: "Is it you?" },
    { id: "$l2", sender: "@me:hs", at: "2026-11-01T10:05:00Z", body: "Yes, it is." },
  ]);
  await db.insert(matrixGhostPhones).values({ ghostMxid: LID_GHOST, phone: "+447700900123" });

  const person = (personId: string, key: string, keys: string[], presences: unknown[], emails: string[], relations: unknown[] = [], phones: string[] = [], humanId: string | null = null) => ({
    scopeId,
    orgId: ORG,
    brandId: BRAND,
    personId,
    personKey: key,
    identityKeys: keys,
    emails,
    phones,
    sources: ["matrix"],
    presences,
    mergeEvidence: [],
    state: "in_conversation",
    stateSource: "matrix",
    relations,
    humanId,
  });
  const email = "erin@acme.io";
  const failed = "fay@acme.io";
  const merged = "max@acme.io";
  await db.insert(people).values([
    // Senthil: his relation was rebuilt since (now two org relations), the asked `:pro` key names none.
    person(
      P_SENTHIL,
      "email:senthil@novemiq.com",
      ["email:senthil@novemiq.com", `matrix:${senthil.contactId}`],
      [matrixPresence(senthil.contactId, senthil.conversationId, "@whatsapp_lid-senthil:hs")],
      ["senthil@novemiq.com"],
      [{ relationKey: `rel:${P_SENTHIL}:org:${COMPANY_A}` }, { relationKey: `rel:${P_SENTHIL}:org:${COMPANY_B}` }],
      [],
      H_SENTHIL,
    ),
    person(P_EMAIL, `email:${email}`, [`email:${email}`], [instantlyPresence(email)], [email]),
    person(P_PHONE, "phone:+33612345678", ["phone:+33612345678", `matrix:${phone.contactId}`], [matrixPresence(phone.contactId, phone.conversationId, "@whatsapp_33612345678:hs")], [], [], ["+33612345678"]),
    person(P_LID, `matrix:${lid.contactId}`, [`matrix:${lid.contactId}`], [matrixPresence(lid.contactId, lid.conversationId, LID_GHOST)], []),
    person(P_FAILED, `email:${failed}`, [`email:${failed}`], [instantlyPresence(failed)], [failed]),
    person(P_MERGED, `email:${merged}`, [`email:${merged}`], [instantlyPresence(merged)], [merged]),
  ]);
  await db.insert(personIdAliases).values({ orgId: ORG, brandId: BRAND, retiredId: P_RETIRED, personId: P_MERGED });

  const stored = (address: string, at: string, direction: string, body: string) => ({
    scopeId,
    source: "instantly",
    unit: `camp-1:${address}`,
    address,
    messageKey: `${direction}|${at}|x|${address}`,
    at: new Date(at),
    direction,
    subject: "Quick question",
    body,
    searchText: body,
    item: { at, source: "instantly", channel: "email", direction, from: direction === "outbound" ? "kevin@getdistribute.com" : address, ref: { campaignId: "camp-1" }, outreachFact: direction === "outbound" ? { subjectKey: "x", step: 1, position: "first" } : null },
  });
  await db.insert(peopleMessageTexts).values([
    stored(email, "2026-10-20T09:00:00.000Z", "outbound", "Hi Erin"),
    stored(email, "2026-10-21T09:00:00.000Z", "inbound", "Tell me more"),
    stored(email, "2026-10-22T09:00:00.000Z", "outbound", "Sure, here it is"),
    stored(email, "2026-10-25T09:00:00.000Z", "outbound", "Following up"),
    stored(merged, "2026-10-26T09:00:00.000Z", "outbound", "Hi Max"),
  ]);
  const unit = (address: string, status: string, error: string | null = null) => ({ scopeId, source: "instantly", unit: `camp-1:${address}`, address, status, error, runId: "r", format: 4 });
  await db.insert(peopleMessageUnits).values([unit(email, "ok"), unit(failed, "failed", "instantly-service returned 502"), unit(merged, "ok")]);
}

describe.skipIf(!RUN)("POST /internal/people/sent-after", () => {
  beforeAll(async () => {
    stubRuns();
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it("a stale relation key still finds the person: the AI line answered on WhatsApp after T", async () => {
    const res = await post({ orgId: ORG, brandId: BRAND, people: [{ ref: "8b3c5bb1", relationKey: `rel:${P_SENTHIL}:pro`, humanId: H_SENTHIL, after: "2026-11-02T14:47:14Z" }] });
    expect(res.status).toBe(200);
    const [a] = res.body.people;
    expect(a).toMatchObject({ index: 0, ref: "8b3c5bb1", status: "sent", reason: null, personIds: [P_SENTHIL], lastSentAt: "2026-11-02T15:08:17.740Z", gaps: [] });
    expect(a.firstSent).toMatchObject({ at: "2026-11-02T15:08:13.678Z", source: "matrix", channel: "whatsapp", sentBy: "automation", ref: { eventId: "$s2" } });
    expect(a.bySource).toEqual([{ source: "matrix", channel: "whatsapp", firstAt: "2026-11-02T15:08:13.678Z", lastAt: "2026-11-02T15:08:17.740Z" }]);
    expect(res.body.counts).toEqual({ sent: 1, nothing_sent: 0, unreadable: 0, unknown: 0 });
  });

  it("the same person by human id alone, and nothing after the brand's last message", async () => {
    const res = await post({ orgId: ORG, brandId: BRAND, people: [{ humanId: H_SENTHIL, after: "2026-11-02T15:08:17.740Z" }] });
    expect(res.body.people[0]).toMatchObject({ status: "nothing_sent", reason: null, firstSent: null, lastSentAt: null, gaps: [] });
  });

  it("an email-only person: the first cold email after T, and nothing_sent after the last", async () => {
    const res = await post({
      orgId: ORG,
      brandId: BRAND,
      people: [
        { email: " Erin@Acme.io ", after: "2026-10-21T09:00:00Z" },
        { email: "erin@acme.io", after: "2026-10-25T09:00:00Z" },
      ],
    });
    const [a, b] = res.body.people;
    expect(a).toMatchObject({ status: "sent", personIds: [P_EMAIL], lastSentAt: "2026-10-25T09:00:00.000Z" });
    expect(a.firstSent).toMatchObject({ at: "2026-10-22T09:00:00.000Z", source: "instantly", channel: "email", sentBy: "automation", text: "Sure, here it is" });
    expect(b).toMatchObject({ status: "nothing_sent", firstSent: null, gaps: [] });
  });

  it("a phone-only person: by their phone key, and by the WhatsApp ghost the bridge resolved the number to", async () => {
    const res = await post({
      orgId: ORG,
      brandId: BRAND,
      people: [
        { phone: "+33612345678", after: "2026-11-01T10:00:00Z" },
        { phone: "+447700900123", after: "2026-11-01T10:00:00Z" },
        // After the hand-typed answer: the later edit and bridge notice are no messages.
        { phone: "+33612345678", after: "2026-11-01T11:00:00Z" },
      ],
    });
    const [a, b, c] = res.body.people;
    expect(a).toMatchObject({ status: "sent", personIds: [P_PHONE] });
    expect(a.firstSent).toMatchObject({ at: "2026-11-01T11:00:00.000Z", channel: "whatsapp", sentBy: "person", text: "Hi Paul, here." });
    expect(a.lastSentAt).toBe("2026-11-01T11:00:00.000Z");
    expect(b).toMatchObject({ status: "sent", personIds: [P_LID] });
    expect(b.firstSent).toMatchObject({ at: "2026-11-01T10:05:00.000Z", sentBy: "person" });
    expect(c).toMatchObject({ status: "nothing_sent" });
  });

  it("a merged person's retired id resolves; an unknown person and a bad key read unknown, a failed thread unreadable", async () => {
    const res = await post({
      orgId: ORG,
      brandId: BRAND,
      people: [
        { personId: P_RETIRED, after: "2026-10-01T00:00:00Z" },
        { email: "nobody@acme.io", phone: "+14155550000", after: "2026-10-01T00:00:00Z" },
        { relationKey: "rel:nope", after: "2026-10-01T00:00:00Z" },
        { email: "fay@acme.io", after: "2026-10-01T00:00:00Z" },
      ],
    });
    const [merged, nobody, bad, failed] = res.body.people;
    expect(merged).toMatchObject({ status: "sent", personIds: [P_MERGED] });
    expect(nobody).toMatchObject({ status: "unknown", reason: "person_not_found", personIds: [] });
    expect(bad).toMatchObject({ status: "unknown", reason: "not_a_relation_key" });
    expect(failed).toMatchObject({ status: "unreadable", reason: "source_unreadable" });
    expect(failed.gaps).toEqual([{ source: "instantly", address: "fay@acme.io", connectionId: null, reason: "read_failed", error: "instantly-service returned 502" }]);
    expect(res.body.counts).toEqual({ sent: 1, nothing_sent: 0, unreadable: 1, unknown: 2 });
  });

  it("a stale WhatsApp mirror is a gap, never nothing_sent", async () => {
    await db.update(matrixConnections).set({ lastSyncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(matrixConnections.orgId, ORG));
    try {
      const res = await post({ orgId: ORG, brandId: BRAND, people: [{ phone: "+33612345678", after: "2026-11-01T11:00:00Z" }] });
      expect(res.body.people[0]).toMatchObject({ status: "unreadable", reason: "source_unreadable" });
      expect(res.body.people[0].gaps[0]).toMatchObject({ source: "matrix", reason: "mirror_stale" });
    } finally {
      await db.update(matrixConnections).set({ lastSyncedAt: new Date() }).where(eq(matrixConnections.orgId, ORG));
    }
  });

  it("a brand with no people scope reads unknown scope_not_built; a nameless ask is refused", async () => {
    const res = await post({ orgId: ORG, brandId: BRAND_EMPTY, people: [{ email: "erin@acme.io", after: "2026-10-01T00:00:00Z" }] });
    expect(res.body.people[0]).toMatchObject({ status: "unknown", reason: "scope_not_built" });
    const bad = await post({ orgId: ORG, brandId: BRAND, people: [{ after: "2026-10-01T00:00:00Z" }] });
    expect(bad.status).toBe(400);
  });
});
