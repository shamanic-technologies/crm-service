import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixRawEvents,
  people,
  peopleScopes,
  replyTriggerReports,
  whatsappSends,
  type MatrixConnection,
} from "../../src/db/schema.js";
import { deliverDueReplies, detectReplies } from "../../src/lib/reply-trigger/watch.js";

/**
 * The reply trigger end to end against a real database: a thread our campaign
 * opened through the send route, the person answering, the burst recorded once
 * and reported once to campaign-service's trigger door. runs-service,
 * chat-service (Jev) and campaign-service are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "a7c1d2e3-2222-4222-8222-000000000001";
const BRAND = "a7c1d2e3-2222-4222-8222-000000000002";
const OFFER = "a7c1d2e3-2222-4222-8222-0000000000a1";
const CAMPAIGN = "a7c1d2e3-2222-4222-8222-0000000000c1";
const USER = "user-reply-1";
const OWN = "@crm_reply_own:hs";
const GHOST = "@whatsapp_lid-777:hs";
const ROOM = "!reply-room:hs";
const PERSONAL_ROOM = "!personal-room:hs";
const EMAIL = "prospect+wa@example.com";

process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let campaignCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
let jevChoice = "person";
let jevCalls = 0;

function installFetchStub() {
  campaignCalls = [];
  jevCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.pathname === "/orgs/judgments") {
      jevCalls += 1;
      return json({ model: "jev", answers: { sender: { type: "choice", choice: jevChoice, confidence: 0.93, probabilities: {} } } });
    }
    if (url.host === "campaign.test" && url.pathname === `/campaigns/${CAMPAIGN}`) {
      return json({ campaign: { id: CAMPAIGN, offerId: OFFER } });
    }
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      campaignCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json({ event: { id: `ev-${campaignCalls.length}`, status: "done", outcome: "ran" }, replayed: false }, 201);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// Relative to now: the delivery window is the last 24h of real time.
const T0 = Date.now() - 30 * 60_000;
const min = (n: number) => T0 + n * 60_000;

let conn: MatrixConnection;
let conversationId: string;

async function event(id: string, sender: string, at: number, body: string, room = ROOM, msgtype = "m.text") {
  await db.insert(matrixRawEvents).values({
    orgId: ORG, brandId: BRAND, connectionId: conn.id, eventId: id, roomId: room, sender, eventType: "m.room.message",
    originServerTs: new Date(at), ingestedAt: new Date(), payload: { event_id: id, type: "m.room.message", sender, origin_server_ts: at, content: { msgtype, body } },
  });
}

async function send(eventId: string, at: number, campaignId: string | null, room = ROOM) {
  await db.insert(whatsappSends).values({
    orgId: ORG, brandId: BRAND, idempotencyKey: `k-${eventId}`, email: EMAIL, phone: "+33770657585", text: "x", status: "sent",
    campaignId, connectionId: conn.id, roomId: room, ghostMxid: GHOST, eventId, sentAt: new Date(at), fromAccount: "+33680478702",
  });
}

async function fresh(): Promise<MatrixConnection> {
  const [c] = await db.select().from(matrixConnections).where(eq(matrixConnections.id, conn.id));
  return c;
}

async function reports() {
  return db.select().from(replyTriggerReports).where(eq(replyTriggerReports.brandId, BRAND));
}

async function cleanup() {
  await db.delete(replyTriggerReports).where(eq(replyTriggerReports.brandId, BRAND));
  await db.delete(whatsappSends).where(eq(whatsappSends.brandId, BRAND));
  await db.delete(people).where(eq(people.brandId, BRAND));
  await db.delete(peopleScopes).where(eq(peopleScopes.brandId, BRAND));
  await db.delete(matrixConnections).where(eq(matrixConnections.brandId, BRAND)); // cascades bronze + conversations
  await db.delete(contacts).where(eq(contacts.brandId, BRAND));
}

describe.skipIf(!RUN)("reply trigger", () => {
  beforeEach(async () => {
    await cleanup();
    [conn] = await db
      .insert(matrixConnections)
      .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: OWN, counterpartPrefix: "@whatsapp_", createdByUserId: USER })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({
        orgId: ORG, brandId: BRAND, phoneE164: "+33770657585", fullName: "Kevin (WA)", rawAttributes: {}, source: "matrix",
        channel: "whatsapp", channelHandle: GHOST, sourceConnectionId: conn.id,
      })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({
        orgId: ORG, brandId: BRAND, connectionId: conn.id, contactId: contact.id, channel: "whatsapp", roomId: ROOM,
        firstMessageAt: new Date(min(0)), lastMessageAt: new Date(min(0)), messageCount: 1, inboundCount: 0, outboundCount: 1, lastEventId: "$c",
      })
      .returning();
    conversationId = conversation.id;
    jevChoice = "person";
    installFetchStub();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  async function buildPerson() {
    const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "ready" }).returning();
    await db.insert(people).values({
      scopeId: scope.id, orgId: ORG, brandId: BRAND, personKey: `email:${EMAIL}`, identityKeys: [`email:${EMAIL}`, "phone:+33770657585"],
      displayName: "Kevin (WA)", emails: [EMAIL], phones: ["+33770657585"], sources: ["matrix"], mergeEvidence: [],
      presences: [{ source: "matrix", sourceRef: "x", displayName: "Kevin (WA)", company: null, emails: [], phones: ["+33770657585"],
        firstActivityAt: null, lastActivityAt: null, messageCount: 1, inboundCount: 1, outboundCount: 1, detail: { conversationId } }],
      state: "in_conversation", stateSource: "matrix", personId: "a7c1d2e3-2222-4222-8222-0000000000f1",
    });
  }

  it("the first look is a baseline; a burst of two after the campaign wrote is reported ONCE, with the person and the words", async () => {
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi, it's Kevin from Distribute.you");
    expect((await detectReplies(conn, "run-1", min(0))).baseline).toBe(true);
    conn = await fresh();
    await buildPerson();

    // History mirrored before the watch is never reported...
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 1000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await event("$a", GHOST, min(2), "Hi! Who is this?");
    await event("$b", GHOST, min(3), "And what does it cost?");
    const d = await detectReplies(conn, "run-1");
    expect(d).toMatchObject({ detected: 1, threadsRead: 1 });
    expect(jevCalls).toBe(1);
    // ...a second pass over the same burst records nothing more.
    expect((await detectReplies(conn, "run-1")).detected).toBe(0);

    await deliverDueReplies();
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
    const call = campaignCalls[0];
    expect(call.headers.get("x-org-id")).toBe(ORG);
    expect(call.headers.get("x-user-id")).toBe(USER);
    expect(call.body).toMatchObject({
      triggerId: "positive_reply_received",
      brandId: BRAND,
      offerId: OFFER,
      idempotencyKey: "crm:matrix:reply:$a",
      person: { email: EMAIL, name: "Kevin (WA)", phone: "+33770657585" },
      item: { kind: "reply", channel: "whatsapp", campaignId: CAMPAIGN, conversationId },
    });
    expect((call.body.item as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual(["Hi! Who is this?", "And what does it cost?"]);
    expect((await reports())[0]).toMatchObject({ status: "reported", campaignEventId: "ev-1", offerId: OFFER, email: EMAIL });

    // A third message in the same burst: still one report.
    await event("$d", GHOST, min(4), "Hello?");
    expect((await detectReplies(conn, "run-1")).detected).toBe(0);

    // We answer through the route; their next message is a new burst, a new report.
    await send("$r", min(6), "responder-campaign-id");
    await event("$r", OWN, min(6), "AI answer");
    await event("$n", GHOST, min(8), "Thanks, Friday works");
    expect((await detectReplies(conn, "run-1")).detected).toBe(1);
  });

  it("a thread no campaign opened is never read; a hand-typed message after the campaign wrote = taken over for good", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    // Personal room: a staff send with no campaign, then an answer.
    await send("$p", min(0), null, PERSONAL_ROOM);
    await event("$p", OWN, min(0), "hey", PERSONAL_ROOM);
    await event("$pa", GHOST, min(1), "hey you", PERSONAL_ROOM);
    // Campaign room taken by hand.
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi");
    await event("$h", OWN, min(1), "typed on my phone");
    await event("$x", GHOST, min(2), "ok!");
    const d = await detectReplies(conn, "run-1");
    expect(d.detected).toBe(0);
    expect(d.skipped).toEqual([{ reason: "human_took_over", roomId: ROOM }]);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(0);
  });

  it("an auto-reply is not an answer; a person writing after it in the same burst is", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi");
    await event("$auto", GHOST, min(1), "Thanks for contacting us! We will get back to you soon.");
    jevChoice = "automated";
    expect((await detectReplies(conn, "run-1")).skipped).toEqual([{ reason: "automated_reply", roomId: ROOM }]);
    jevChoice = "person";
    await event("$real", GHOST, min(9), "Hi, Kevin here, tell me more");
    expect((await detectReplies(conn, "run-1")).detected).toBe(1);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0].body.idempotencyKey).toBe("crm:matrix:reply:$real");
  });

  it("a person with no email is not reported, named in the log; a person not built yet waits for the rebuild", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi");
    await event("$a", GHOST, min(1), "yes?");
    expect((await detectReplies(conn, "run-1")).detected).toBe(1);

    // Not built: the rebuild is asked, then the report goes out.
    let rebuilt = 0;
    await deliverDueReplies(Date.now(), { rebuild: async () => { rebuilt += 1; await buildPerson(); } });
    expect(rebuilt).toBe(1);
    expect(campaignCalls).toHaveLength(1);

    // No email.
    await db.update(people).set({ emails: [], identityKeys: ["phone:+33770657585"] }).where(eq(people.brandId, BRAND));
    await db.update(whatsappSends).set({ email: null }).where(eq(whatsappSends.brandId, BRAND));
    await send("$r", min(3), null);
    await event("$r", OWN, min(3), "answer");
    await event("$b", GHOST, min(4), "and again");
    expect((await detectReplies(conn, "run-1")).detected).toBe(1);
    const warn = vi.spyOn(console, "warn");
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Kevin (WA)") && String(c[0]).includes("holds no email"))).toBe(true);
    expect((await reports()).find((r) => r.anchorEventId === "$b")).toMatchObject({ status: "skipped", reason: "no_email" });
  });
});
