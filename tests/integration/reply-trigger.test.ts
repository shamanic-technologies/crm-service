import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  conversationVerdicts,
  matrixConnections,
  matrixLinks,
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
const run1 = async () => "run-1";

const ORG = "a7c1d2e3-2222-4222-8222-000000000001";
const BRAND = "a7c1d2e3-2222-4222-8222-000000000002";
const OFFER = "a7c1d2e3-2222-4222-8222-0000000000a1";
const TAGGED_OFFER = "a7c1d2e3-2222-4222-8222-0000000000a2";
const ONLY_OFFER = "a7c1d2e3-2222-4222-8222-0000000000a3";
const CAMPAIGN = "a7c1d2e3-2222-4222-8222-0000000000c1";
const USER = "user-reply-1";
const OWN = "@crm_reply_own:hs";
const GHOST = "@whatsapp_lid-777:hs";
const ROOM = "!reply-room:hs";
const PERSONAL_ROOM = "!personal-room:hs";
const EMAIL = "prospect+wa@example.com";

process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "client-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let campaignCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
let jevChoice = "interested";
let jevCalls = 0;
/** What brand-service states as the brand's sales rep phone; a number = brand-service answers that status. */
let repPhone: string | null | number = null;
let memberPhones: string[] = [];

function installFetchStub() {
  campaignCalls = [];
  jevCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "brand.test" && url.pathname === `/orgs/brands/${BRAND}/sales-rep`) {
      if (typeof repPhone === "number") return json({ error: "down" }, repPhone);
      return json({ salesRepEmail: null, salesRepPhone: repPhone, salesRepFirstName: null, salesRepRole: null });
    }
    if (url.host === "client.test" && url.pathname === "/internal/users") {
      expect(url.searchParams.get("allMembers")).toBe("true");
      return json({ users: memberPhones.map((phone) => ({ email: null, phone })), total: memberPhones.length });
    }
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${BRAND}/offers`) {
      return json({ offers: [{ offerId: ONLY_OFFER, name: "Only", status: "active" }, { offerId: OFFER, name: "Old", status: "archived" }] });
    }
    if (url.pathname === "/orgs/judgments") {
      jevCalls += 1;
      return json({ model: "jev", answers: { reply: { type: "choice", choice: jevChoice, confidence: 0.93, probabilities: { [jevChoice]: 0.93 } } } });
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
  await db.delete(conversationVerdicts).where(eq(conversationVerdicts.brandId, BRAND));
  await db.delete(whatsappSends).where(eq(whatsappSends.brandId, BRAND));
  await db.delete(people).where(eq(people.brandId, BRAND));
  await db.delete(matrixLinks).where(eq(matrixLinks.brandId, BRAND));
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
    jevChoice = "interested";
    repPhone = null;
    memberPhones = [];
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
    expect((await detectReplies(conn, run1, min(0))).baseline).toBe(true);
    conn = await fresh();
    await buildPerson();

    // History mirrored before the watch is never reported...
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 1000), openReplyWatchSince: new Date(Date.now() - 1000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await event("$a", GHOST, min(2), "Hi! Who is this?");
    await event("$b", GHOST, min(3), "And what does it cost?");
    const d = await detectReplies(conn, run1);
    expect(d).toMatchObject({ detected: 1, threadsRead: 1 });
    expect(jevCalls).toBe(1);
    // ...a second pass over the same burst records nothing more.
    expect((await detectReplies(conn, run1)).detected).toBe(0);

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
    expect((await detectReplies(conn, run1)).detected).toBe(0);

    // We answer through the route; their next message is a new burst, a new report.
    await send("$r", min(6), "responder-campaign-id");
    await event("$r", OWN, min(6), "AI answer");
    await event("$n", GHOST, min(8), "Thanks, Friday works");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
  });

  it("a thread no campaign opened is reported (the person wrote first), offer = the one Jev tagged the conversation about", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    await event("$q", GHOST, min(1), "Hi, do you have customer references?");
    const d = await detectReplies(conn, run1);
    expect(d.detected).toBe(1);
    await db.insert(conversationVerdicts).values({
      orgId: ORG, brandId: BRAND, conversationKey: `matrix:${conversationId}`, source: "matrix", topic: "this_brand",
      offerScores: { [OFFER]: 0.6, [TAGGED_OFFER]: 0.9 }, offerIds: [OFFER, TAGGED_OFFER], contextHash: "h", judgedThrough: "$q", input: {}, runId: "r",
    });
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0].body).toMatchObject({
      offerId: TAGGED_OFFER,
      idempotencyKey: "crm:matrix:reply:$q",
      item: { campaignId: null, openedBy: "not_campaign", conversationId },
    });
    expect((await reports())[0]).toMatchObject({ status: "reported", campaignId: null, offerBasis: "conversation" });
  });

  it("no campaign and no offer tag: the brand's only active offer", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    await event("$q", GHOST, min(1), "Who are your customers?");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    await deliverDueReplies();
    expect(campaignCalls[0].body).toMatchObject({ offerId: ONLY_OFFER, item: { campaignId: null } });
    expect((await reports())[0]).toMatchObject({ offerBasis: "only_offer" });
  });

  it("a human of the brand typing by hand takes the conversation: no automated reply fires there again, named skip (HUMAN-IN-THREAD-1016)", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi");
    await event("$a", GHOST, min(1), "who is this?");
    // Only automated messages of ours so far: the answer is reported.
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    await event("$h", OWN, min(2), "Hey Noah, it's Kevin, typed on my phone");
    expect((await detectReplies(conn, run1)).detected).toBe(0); // answered by hand: nobody waiting
    await event("$x", GHOST, min(3), "ok, send me references");
    const jevBefore = jevCalls;
    const d = await detectReplies(conn, run1);
    expect(d).toMatchObject({ detected: 0, skipped: [{ reason: "human_in_conversation", roomId: ROOM }] });
    expect(jevCalls).toBe(jevBefore);
    // Later on, still the human's conversation.
    await event("$y", OWN, min(4), "sure, here they are");
    await event("$z", GHOST, min(5), "great, can we book a call?");
    expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "human_in_conversation", roomId: ROOM }]);
    await deliverDueReplies();
    expect(campaignCalls.map((c) => c.body.idempotencyKey)).toEqual(["crm:matrix:reply:$a"]);
    expect((await reports()).find((r) => r.anchorEventId === "$x")).toMatchObject({ status: "skipped", reason: "human_in_conversation" });
  });

  it("history of a thread no campaign opened (mirrored before the open watch started) is never reported; a later message is", async () => {
    await event("$old", GHOST, min(-5), "an old unanswered message");
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() + 1000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "before_watch", roomId: ROOM }]);
    await db.update(matrixConnections).set({ openReplyWatchSince: new Date(Date.now() - 1000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await event("$new", GHOST, min(1), "hello again");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
    expect((campaignCalls[0].body.item as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual(["hello again"]);
  });

  it("a message received on an account the brand keeps out of automation fires no automated reply; allowed again, the next one does (SOPHIE-WA-1016)", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    const [link] = await db
      .insert(matrixLinks)
      .values({
        orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, matrixUserId: OWN, status: "linked", method: "qr",
        remoteLoginId: "33680478702", connectionId: conn.id, linkedAt: new Date(), automationAllowed: false,
      })
      .returning();
    await event("$p", GHOST, min(1), "Hey, how much is it?");
    expect(await detectReplies(conn, run1)).toMatchObject({ detected: 0, skipped: [{ reason: "automation_not_allowed", roomId: ROOM }] });
    expect(jevCalls).toBe(0);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(0);
    expect((await reports())[0]).toMatchObject({ status: "skipped", reason: "automation_not_allowed" });

    await db.update(matrixLinks).set({ automationAllowed: true }).where(eq(matrixLinks.id, link.id));
    await event("$p2", GHOST, min(2), "Still interested, can we talk?");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
  });

  it("only one-to-one threads are read: a room with no conversation (a group) is not", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await event("$g", GHOST, min(1), "hello group", PERSONAL_ROOM);
    expect(await detectReplies(conn, run1)).toMatchObject({ detected: 0, threadsRead: 0 });
  });

  it("a negative answer is no positive reply; a positive one later in the same burst is (owner 2026-10-16)", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    await send("$n0", min(0), CAMPAIGN);
    await event("$n0", OWN, min(0), "Hi");
    await event("$no", GHOST, min(1), "No thanks, not interested");
    jevChoice = "not_interested";
    expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "not_positive", roomId: ROOM }]);
    expect(campaignCalls).toHaveLength(0);
    jevChoice = "info_requested";
    await event("$yes", GHOST, min(9), "Actually, how much is it?");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    const [row] = await db.select().from(replyTriggerReports).where(eq(replyTriggerReports.anchorEventId, "$yes"));
    expect(row.status).toBe("pending");
    expect((row.judgment as { positive?: number }).positive).toBeCloseTo(0.93);
  });

  it("an auto-reply is not an answer; a person writing after it in the same burst is", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await buildPerson();
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi");
    await event("$auto", GHOST, min(1), "Thanks for contacting us! We will get back to you soon.");
    jevChoice = "automated";
    expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "automated_reply", roomId: ROOM }]);
    jevChoice = "interested";
    await event("$real", GHOST, min(9), "Hi, Kevin here, tell me more");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0].body.idempotencyKey).toBe("crm:matrix:reply:$real");
  });

  it("a person with no email is reported by phone + name (REPLY-PHONE-ONLY-1015); neither = skipped, named in the log; a person not built yet waits for the rebuild", async () => {
    await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
    conn = await fresh();
    await send("$c", min(0), CAMPAIGN);
    await event("$c", OWN, min(0), "Hi");
    await event("$a", GHOST, min(1), "yes?");
    expect((await detectReplies(conn, run1)).detected).toBe(1);

    // Not built: the rebuild is asked, then the report goes out.
    let rebuilt = 0;
    await deliverDueReplies(Date.now(), { rebuild: async () => { rebuilt += 1; await buildPerson(); } });
    expect(rebuilt).toBe(1);
    expect(campaignCalls).toHaveLength(1);

    // No email, a phone: reported by phone + name, never a made-up email.
    await db.update(people).set({ emails: [], identityKeys: ["phone:+33770657585"] }).where(eq(people.brandId, BRAND));
    await db.update(whatsappSends).set({ email: null }).where(eq(whatsappSends.brandId, BRAND));
    await send("$r", min(3), null);
    await event("$r", OWN, min(3), "answer");
    await event("$b", GHOST, min(4), "and again");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(2);
    expect(campaignCalls[1].body.triggerId).toBe("positive_reply_received");
    expect(campaignCalls[1].body.person).toEqual({ name: "Kevin (WA)", phone: "+33770657585" });
    expect((await reports()).find((r) => r.anchorEventId === "$b")).toMatchObject({ status: "reported", email: null, phone: "+33770657585" });

    // Neither an email nor a phone: a named skip, never sent.
    await db
      .update(people)
      .set({ phones: [], identityKeys: [], presences: [{ source: "matrix", sourceRef: "x", displayName: "Kevin (WA)", company: null, emails: [], phones: [],
        firstActivityAt: null, lastActivityAt: null, messageCount: 1, inboundCount: 1, outboundCount: 1, detail: { conversationId } }] })
      .where(eq(people.brandId, BRAND));
    await send("$r2", min(5), null);
    await event("$r2", OWN, min(5), "answer");
    await event("$n", GHOST, min(6), "still me");
    expect((await detectReplies(conn, run1)).detected).toBe(1);
    const warn = vi.spyOn(console, "warn");
    await deliverDueReplies();
    expect(campaignCalls).toHaveLength(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Kevin (WA)") && String(c[0]).includes("neither an email nor an international phone"))).toBe(true);
    expect((await reports()).find((r) => r.anchorEventId === "$n")).toMatchObject({ status: "skipped", reason: "no_email_or_phone" });
  });

  describe("the brand's own team is never a prospect", () => {
    async function campaignThreadAnswered() {
      await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
      conn = await fresh();
      await buildPerson();
      await send("$c", min(0), CAMPAIGN); // addressed to +33770657585
      await event("$c", OWN, min(0), "Needs your call: X asked Y, please reply yourself");
      await event("$ok", GHOST, min(1), "ok");
    }

    it("a burst from one of the brand's linked WhatsApp accounts is skipped as own_team, named in the log", async () => {
      await db.insert(matrixLinks).values({
        orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, status: "linked", method: "qr", remoteLoginId: "33770657585",
      });
      await campaignThreadAnswered();
      const log = vi.spyOn(console, "log");
      const d = await detectReplies(conn, run1);
      expect(d.detected).toBe(0);
      expect(d.skipped).toEqual([{ reason: "own_team", roomId: ROOM }]);
      expect(jevCalls).toBe(0);
      expect(log.mock.calls.some((c) => String(c[0]).includes("+33770657585 is one of the brand's linked WhatsApp accounts"))).toBe(true);
      await deliverDueReplies();
      expect(campaignCalls).toHaveLength(0);
      expect((await reports())[0]).toMatchObject({ status: "skipped", reason: "own_team" });
    });

    it("a burst from the brand's sales rep phone (read from brand-service, any spelling) is skipped as own_team", async () => {
      repPhone = "+33 7 70 65 75 85";
      await campaignThreadAnswered();
      const d = await detectReplies(conn, run1);
      expect(d.skipped).toEqual([{ reason: "own_team", roomId: ROOM }]);
      await deliverDueReplies();
      expect(campaignCalls).toHaveLength(0);
    });

    it("a burst from the phone of any member of the org (client-service) is skipped as own_team (OWN-TEAM-GMAIL-1016)", async () => {
      memberPhones = ["+33 7 70 65 75 85"];
      await campaignThreadAnswered();
      const d = await detectReplies(conn, run1);
      expect(d.skipped).toEqual([{ reason: "own_team", roomId: ROOM }]);
      await deliverDueReplies();
      expect(campaignCalls).toHaveLength(0);
    });

    it("a burst from any other number is still reported", async () => {
      repPhone = "+33611223344";
      await db.insert(matrixLinks).values({
        orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, status: "linked", method: "qr", remoteLoginId: "33680478702",
      });
      await campaignThreadAnswered();
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(campaignCalls).toHaveLength(1);
    });

    it("brand-service unable to say who the rep is: nothing recorded this pass, the next pass reads it again", async () => {
      repPhone = 503;
      await campaignThreadAnswered();
      await expect(detectReplies(conn, run1)).rejects.toThrow(/sales-rep returned 503/);
      expect(await reports()).toHaveLength(0);
      repPhone = null;
      expect((await detectReplies(conn, run1)).detected).toBe(1);
    });
  });
});
