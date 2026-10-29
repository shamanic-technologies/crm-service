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
  voiceNoteTranscripts,
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
process.env.MATRIX_HOMESERVER_URL = "http://hs.test";
process.env.VOICE_NOTE_RETRY_DELAY_MS = "0";
process.env.MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || "platform-token";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let campaignCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
let jevChoice = "interested";
let jevCalls = 0;
/** What brand-service states as the brand's sales rep phone; a number = brand-service answers that status. */
let repPhone: string | null | number = null;
let memberPhones: string[] = [];
/** chat-service's Copilot hand-off door (SOPHIE-COPILOT-WA-1018). */
let copilotCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
let copilotAnswer: { status: number; body: unknown } = { status: 202, body: { status: "accepted" } };
/** chat-service's transcription (SOPHIE-VOICE-1019) and the homeserver's media download. */
let transcriptionCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
const TRANSCRIBED = { status: 200, body: { text: "How many campaigns run on Distribute.you?", languages: ["en"], segments: [], model: "gemini-3.8-flash", tokensInput: 100, tokensOutput: 12, runId: "a7c1d2e3-2222-4222-8222-0000000000e1" } };
let transcriptionAnswer: { status: number; body: unknown } = TRANSCRIBED;
let mediaCalls: { url: string; auth: string | null }[] = [];

let createdRuns: Array<{ id: string; parent: string | null; body: { taskName?: string; support?: { kind: string } } }> = [];

function installFetchStub() {
  createdRuns = [];
  campaignCalls = [];
  copilotCalls = [];
  transcriptionCalls = [];
  transcriptionAnswer = TRANSCRIBED;
  mediaCalls = [];
  jevCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      const id = "run-" + Math.random().toString(16).slice(2);
      if (init?.method === "POST" && url.pathname === "/v1/runs") {
        createdRuns.push({ id, parent: new Headers(init.headers).get("x-run-id"), body: JSON.parse(String(init.body)) });
      }
      return json({ id });
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
    if (url.host === "hs.test" && url.pathname.startsWith("/_matrix/client/v1/media/download/")) {
      mediaCalls.push({ url: url.pathname, auth: new Headers(init?.headers).get("authorization") });
      return new Response(Buffer.from("OggS voice"), { status: 200, headers: { "content-type": "audio/ogg; codecs=opus" } });
    }
    if (url.pathname === "/orgs/transcriptions") {
      transcriptionCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json(transcriptionAnswer.body, transcriptionAnswer.status);
    }
    if (url.pathname === "/internal/copilot/channel-messages") {
      copilotCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json(copilotAnswer.body, copilotAnswer.status);
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
  await db.delete(voiceNoteTranscripts).where(eq(voiceNoteTranscripts.brandId, BRAND));
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
  describe("the Copilot's line: the assistant account of the brand the Copilot serves (SOPHIE-COPILOT-WA-1018)", () => {
    const SOPHIE = "77776879632";
    beforeEach(async () => {
      process.env.COPILOT_UNIBOX_ORG_ID = ORG;
      process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
      copilotAnswer = { status: 202, body: { status: "accepted" } };
      await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, conn.id));
      conn = await fresh();
    });
    afterAll(() => {
      delete process.env.COPILOT_UNIBOX_ORG_ID;
      delete process.env.COPILOT_UNIBOX_BRAND_ID;
    });

    async function link(automationAllowed = true) {
      await db.insert(matrixLinks).values({
        orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, matrixUserId: OWN, status: "linked", method: "qr",
        remoteLoginId: SOPHIE, connectionId: conn.id, linkedAt: new Date(), automationAllowed,
        personaName: "Sophie", personaRole: "Distribute.you Assistant", personaInstructions: null,
      });
    }

    it("every burst is handed to the Copilot ONCE with its thread, no Jev, no trigger; a retry reuses the messageId", async () => {
      await link();
      await send("$s0", min(0), CAMPAIGN);
      await event("$s0", OWN, min(0), "Hi, it's Sophie from Distribute.you");
      await event("$h1", GHOST, min(1), "No thanks");
      await event("$h2", GHOST, min(2), "Actually, what does it cost?");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      expect(jevCalls).toBe(0);

      copilotAnswer = { status: 503, body: { error: "down" } };
      await deliverDueReplies();
      expect((await reports())[0]).toMatchObject({ status: "handoff_failed", reason: "copilot_unreachable", attempts: 1 });
      copilotAnswer = { status: 200, body: { status: "duplicate" } };
      await deliverDueReplies(Date.now() + 2 * 60_000);
      await deliverDueReplies(Date.now() + 10 * 60_000);

      expect(campaignCalls).toHaveLength(0);
      expect(copilotCalls).toHaveLength(2);
      expect(copilotCalls[1].body.messageId).toBe(copilotCalls[0].body.messageId);
      expect(copilotCalls[0].headers.get("x-api-key")).toBe(process.env.CHAT_SERVICE_API_KEY);
      expect(copilotCalls[0].body).toEqual({
        channel: "whatsapp",
        messageId: "$h1",
        orgId: ORG,
        brandId: BRAND,
        accountUserId: USER,
        fromAccount: `+${SOPHIE}`,
        assistant: { name: "Sophie", role: "Distribute.you Assistant", instructions: null },
        // COPILOT-WA-REPEAT-1027: our campaign wrote to this number naming the person: the Copilot knows who they are.
        sender: { phone: "+33770657585", name: "Kevin (WA)", knownEmails: [EMAIL] },
        text: "No thanks\nActually, what does it cost?",
        at: new Date(min(2)).toISOString(),
        thread: [{ at: new Date(min(0)).toISOString(), direction: "outbound", kind: "message", text: "Hi, it's Sophie from Distribute.you" }],
      });
      expect((await reports())[0]).toMatchObject({ status: "handed_off", reason: "copilot", phone: "+33770657585" });
    });

    describe("a person writes to the founder line: Sophie answers from HER line (SOPHIE-ANSWERS-FROM-HER-LINE-1029)", () => {
      const FOUNDER = "33680478702";
      const PERSONAL = "33611111111";
      const SOPHIE_OWN = "@crm_sophie_line:hs";
      const PERSONAL_OWN = "@crm_personal_line:hs";
      const SOPHIE_ROOM = "!sophie-room:hs";
      const PERSONAL_LINE_ROOM = "!personal-line-room:hs";
      let sophieConn: MatrixConnection;
      let personalConn: MatrixConnection;

      async function line(c: MatrixConnection, own: string, remote: string, accountType: string, persona: { name: string; role: string } | null, automationAllowed = true) {
        await db.insert(matrixLinks).values({
          orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, matrixUserId: own, status: "linked", method: "qr",
          remoteLoginId: remote, connectionId: c.id, linkedAt: new Date(), automationAllowed, accountType,
          personaName: persona?.name ?? null, personaRole: persona?.role ?? null, personaInstructions: null,
        });
      }

      async function roomWith(c: MatrixConnection, room: string, events: [string, string, number, string][]) {
        const [contact] = await db
          .insert(contacts)
          .values({ orgId: ORG, brandId: BRAND, phoneE164: "+33770657585", fullName: "Kevin (WA)", rawAttributes: {}, source: "matrix", channel: "whatsapp", channelHandle: GHOST, sourceConnectionId: c.id })
          .returning();
        await db.insert(conversations).values({
          orgId: ORG, brandId: BRAND, connectionId: c.id, contactId: contact.id, channel: "whatsapp", roomId: room,
          firstMessageAt: new Date(events[0][2]), lastMessageAt: new Date(events[events.length - 1][2]), messageCount: events.length,
          inboundCount: 0, outboundCount: events.length, lastEventId: events[events.length - 1][0],
        });
        for (const [id, sender, at, body] of events) {
          await db.insert(matrixRawEvents).values({
            orgId: ORG, brandId: BRAND, connectionId: c.id, eventId: id, roomId: room, sender, eventType: "m.room.message",
            originServerTs: new Date(at), ingestedAt: new Date(), payload: { event_id: id, type: "m.room.message", sender, origin_server_ts: at, content: { msgtype: "m.text", body } },
          });
        }
      }

      beforeEach(async () => {
        [sophieConn] = await db
          .insert(matrixConnections)
          .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: SOPHIE_OWN, counterpartPrefix: "@whatsapp_", createdByUserId: USER })
          .returning();
        [personalConn] = await db
          .insert(matrixConnections)
          .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: PERSONAL_OWN, counterpartPrefix: "@whatsapp_", createdByUserId: USER })
          .returning();
        await line(conn, OWN, FOUNDER, "pro_human", { name: "Kevin", role: "Founder" });
        await line(sophieConn, SOPHIE_OWN, SOPHIE, "pro_ai", { name: "Sophie", role: "Distribute.you Assistant" });
        await line(personalConn, PERSONAL_OWN, PERSONAL, "personal_human", null, false);
        // The founder's private chat with the same person: never in Sophie's thread.
        await roomWith(personalConn, PERSONAL_LINE_ROOM, [["$priv", GHOST, min(-5), "see you at dinner"]]);
      });

      it("the founder hello's answer is handed off to answer from the pro_ai line with ITS persona, the founder line named, nothing from the personal line", async () => {
        await send("$hello", min(0), CAMPAIGN);
        await event("$hello", OWN, min(0), "Hi, Kevin from distribute.you here");
        await event("$ans1", GHOST, min(1), "Hi Kevin, tell me more");
        expect((await detectReplies(conn, run1)).detected).toBe(1);
        await deliverDueReplies();
        expect(copilotCalls).toHaveLength(1);
        expect(copilotCalls[0].body).toMatchObject({
          messageId: "$ans1",
          fromAccount: `+${SOPHIE}`,
          assistant: { name: "Sophie", role: "Distribute.you Assistant", instructions: null },
          receivedOn: { account: `+${FOUNDER}`, name: "Kevin", role: "Founder" },
          text: "Hi Kevin, tell me more",
          thread: [{ at: new Date(min(0)).toISOString(), direction: "outbound", kind: "message", text: "Hi, Kevin from distribute.you here", account: `+${FOUNDER}` }],
        });
        expect(JSON.stringify(copilotCalls[0].body)).not.toContain("see you at dinner");
        expect((await reports())[0]).toMatchObject({ status: "handed_off", reason: "copilot" });
      });

      it("the person's next message on Sophie's line still carries the founder-line conversation, in time order; the burst itself is unchanged", async () => {
        await send("$hello", min(0), CAMPAIGN);
        await db.insert(whatsappSends).values({
          orgId: ORG, brandId: BRAND, idempotencyKey: "copilot:$ans1", phone: "+33770657585", text: "Hi, Sophie here, Kevin's assistant", status: "sent",
          connectionId: sophieConn.id, roomId: SOPHIE_ROOM, ghostMxid: GHOST, eventId: "$soph1", sentAt: new Date(min(2)), fromAccount: `+${SOPHIE}`,
        });
        await event("$hello", OWN, min(0), "Hi, Kevin from distribute.you here");
        await event("$ans1", GHOST, min(1), "Hi Kevin, tell me more");
        await roomWith(sophieConn, SOPHIE_ROOM, [["$soph1", SOPHIE_OWN, min(2), "Hi, Sophie here, Kevin's assistant"]]);
        await db.insert(matrixRawEvents).values({
          orgId: ORG, brandId: BRAND, connectionId: sophieConn.id, eventId: "$ans2", roomId: SOPHIE_ROOM, sender: GHOST, eventType: "m.room.message",
          originServerTs: new Date(min(3)), ingestedAt: new Date(), payload: { event_id: "$ans2", type: "m.room.message", sender: GHOST, origin_server_ts: min(3), content: { msgtype: "m.text", body: "How much?" } },
        });
        await db.update(matrixConnections).set({ replyWatchSince: new Date(Date.now() - 60_000), openReplyWatchSince: new Date(Date.now() - 60_000) }).where(eq(matrixConnections.id, sophieConn.id));
        const [s] = await db.select().from(matrixConnections).where(eq(matrixConnections.id, sophieConn.id));
        expect((await detectReplies(s, run1)).detected).toBe(1);
        await deliverDueReplies();
        const body = copilotCalls.find((c) => c.body.messageId === "$ans2")!.body;
        expect(body.fromAccount).toBe(`+${SOPHIE}`);
        expect(body.receivedOn).toBeUndefined();
        expect(body.thread).toEqual([
          { at: new Date(min(0)).toISOString(), direction: "outbound", kind: "message", text: "Hi, Kevin from distribute.you here", account: `+${FOUNDER}` },
          { at: new Date(min(1)).toISOString(), direction: "inbound", kind: "message", text: "Hi Kevin, tell me more", account: `+${FOUNDER}` },
          { at: new Date(min(2)).toISOString(), direction: "outbound", kind: "message", text: "Hi, Sophie here, Kevin's assistant" },
        ]);
      });

      it("a brand with no pro_ai line answers from the line written to, as before", async () => {
        await db.delete(matrixLinks).where(eq(matrixLinks.connectionId, sophieConn.id));
        await send("$hello", min(0), CAMPAIGN);
        await event("$hello", OWN, min(0), "Hi, Kevin from distribute.you here");
        await event("$ans1", GHOST, min(1), "Hi Kevin");
        expect((await detectReplies(conn, run1)).detected).toBe(1);
        await deliverDueReplies();
        expect(copilotCalls[0].body).toMatchObject({ fromAccount: `+${FOUNDER}`, assistant: { name: "Kevin", role: "Founder", instructions: null } });
        expect(copilotCalls[0].body.receivedOn).toBeUndefined();
        expect((copilotCalls[0].body.thread as Record<string, unknown>[])[0].account).toBeUndefined();
      });
    });

    it("a call on the line reaches the next hand-off's thread as a kind call line in its time order (COPILOT-WA-REPEAT-1027)", async () => {
      await link();
      await send("$s0", min(0), CAMPAIGN);
      await event("$s0", OWN, min(0), "Kevin from distribute.you here.");
      // The bridge's real incoming-call event (prod 2026-10-25): m.text from the caller, marked as a call action.
      const call = {
        event_id: "$call", type: "m.room.message", sender: GHOST, origin_server_ts: min(1),
        content: { body: "Incoming call. Use the WhatsApp app to answer.", msgtype: "m.text", "m.mentions": {}, "com.beeper.action_message": { type: "call" }, "com.beeper.disappearing_timer": {} },
      };
      await db.insert(matrixRawEvents).values({
        orgId: ORG, brandId: BRAND, connectionId: conn.id, eventId: call.event_id, roomId: ROOM, sender: GHOST, eventType: "m.room.message",
        originServerTs: new Date(call.origin_server_ts), ingestedAt: new Date(), payload: call,
      });
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(copilotCalls).toHaveLength(1);
      // The call opened the burst: the Copilot reads it as the call, never the bridge's instruction.
      expect(copilotCalls[0].body.text).toBe("They called us on WhatsApp (voice call). Whether it was answered or missed is not known.");
      await db.insert(whatsappSends).values({
        orgId: ORG, brandId: BRAND, idempotencyKey: "copilot:$call", phone: "+33770657585", text: "Sorry I missed your call!", status: "sent",
        connectionId: conn.id, roomId: ROOM, ghostMxid: GHOST, eventId: "$ans", sentAt: new Date(min(2)), fromAccount: `+${SOPHIE}`,
      });
      await event("$ans", OWN, min(2), "Sorry I missed your call!");
      await event("$h3", GHOST, min(3), "Sorry I can't take calls at this moment");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies(Date.now() + 10 * 60_000);
      expect(copilotCalls).toHaveLength(2);
      expect(copilotCalls[1].body.thread).toEqual([
        { at: new Date(min(0)).toISOString(), direction: "outbound", kind: "message", text: "Kevin from distribute.you here." },
        { at: new Date(min(1)).toISOString(), direction: "inbound", kind: "call", text: "They called us on WhatsApp (voice call). Whether it was answered or missed is not known." },
        { at: new Date(min(2)).toISOString(), direction: "outbound", kind: "message", text: "Sorry I missed your call!" },
      ]);
    });

    it("a message WhatsApp could not decrypt (a notice, then the words as an edit of it) is handed off ONCE with the words (follow-up 3)", async () => {
      await link();
      // The prod shape of 2026-10-18 18:26 on the relinked line: both events carry the same timestamp.
      const notice = {
        event_id: "$undecrypted", type: "m.room.message", sender: GHOST, origin_server_ts: min(1),
        content: { msgtype: "m.notice", body: "Decrypting message from WhatsApp failed, waiting for sender to re-send... ([learn more](https://faq.whatsapp.com/))", "fi.mau.whatsapp.undecryptable": true },
      };
      const edit = {
        event_id: "$decrypted", type: "m.room.message", sender: GHOST, origin_server_ts: min(1),
        content: {
          msgtype: "m.text", body: "* How many campaigns run on Distribute.you?",
          "m.relates_to": { event_id: "$undecrypted", rel_type: "m.replace" },
          "m.new_content": { msgtype: "m.text", body: "How many campaigns run on Distribute.you?" },
        },
      };
      for (const e of [notice, edit]) {
        await db.insert(matrixRawEvents).values({
          orgId: ORG, brandId: BRAND, connectionId: conn.id, eventId: e.event_id, roomId: ROOM, sender: GHOST, eventType: "m.room.message",
          originServerTs: new Date(e.origin_server_ts), ingestedAt: new Date(), payload: e,
        });
      }
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect((await detectReplies(conn, run1)).detected).toBe(0);
      await deliverDueReplies(Date.now() + 10 * 60_000);
      expect(copilotCalls).toHaveLength(1);
      expect(copilotCalls[0].body).toMatchObject({ messageId: "$undecrypted", text: "How many campaigns run on Distribute.you?" });
      expect(await reports()).toHaveLength(1);
      expect((await reports())[0]).toMatchObject({ status: "handed_off", anchorEventId: "$undecrypted" });
    });

    async function voiceNote(id: string, at: number, ingestedAt = new Date()) {
      await db.insert(matrixRawEvents).values({
        orgId: ORG, brandId: BRAND, connectionId: conn.id, eventId: id, roomId: ROOM, sender: GHOST, eventType: "m.room.message",
        originServerTs: new Date(at), ingestedAt,
        payload: {
          event_id: id, type: "m.room.message", sender: GHOST, origin_server_ts: at,
          // The bridge's prod shape (2026-10-18): empty body, the file on the homeserver.
          content: { url: `mxc://hs.test/media-${id.slice(1)}`, body: "", info: { size: 5540, duration: 4000, mimetype: "audio/ogg; codecs=opus" }, msgtype: "m.audio", filename: "Voice message.ogg", "org.matrix.msc3245.voice": {} },
        },
      });
    }

    it("a voice note is transcribed ONCE, org-billed under the account, and handed to the Copilot as its words (SOPHIE-VOICE-1019)", async () => {
      await link();
      await voiceNote("$v1", min(1));
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      expect(transcriptionCalls).toHaveLength(1);
      expect(mediaCalls[0].url).toBe("/_matrix/client/v1/media/download/hs.test/media-v1");
      expect(transcriptionCalls[0].headers.get("x-org-id")).toBe(ORG);
      expect(transcriptionCalls[0].headers.get("x-user-id")).toBe(USER);
      // LEDGER-HISTORY-1024: on the Copilot's line a voice note serves the Copilot: its own child run of the pass, marked
      // support (copilot) at creation.
      const voiceRun = createdRuns.find((r) => r.id === transcriptionCalls[0].headers.get("x-run-id"));
      expect(voiceRun).toMatchObject({ parent: "run-1", body: { taskName: "copilot.voice-notes", support: { kind: "copilot" } } });
      expect(transcriptionCalls[0].headers.get("x-brand-id")).toBe(BRAND);
      expect(transcriptionCalls[0].body).toEqual({ audio: { base64: Buffer.from("OggS voice").toString("base64"), mimeType: "audio/ogg; codecs=opus" }, durationSeconds: 4 });

      await deliverDueReplies();
      expect(copilotCalls).toHaveLength(1);
      expect(copilotCalls[0].body).toMatchObject({ messageId: "$v1", text: "🎤 Voice note: How many campaigns run on Distribute.you?" });
      const [stored] = await db.select().from(voiceNoteTranscripts).where(eq(voiceNoteTranscripts.eventId, "$v1"));
      expect(stored).toMatchObject({ status: "completed", text: "How many campaigns run on Distribute.you?", runId: voiceRun!.id, chatRunId: "a7c1d2e3-2222-4222-8222-0000000000e1" });

      // Read again: never transcribed twice; the next text message carries the voice note in its thread.
      await db.insert(whatsappSends).values({
        orgId: ORG, brandId: BRAND, idempotencyKey: "copilot:$v1", phone: "+33770657585", text: "We run 12.", status: "sent",
        connectionId: conn.id, roomId: ROOM, ghostMxid: GHOST, eventId: "$cv", sentAt: new Date(min(2)), fromAccount: `+${SOPHIE}`,
      });
      await event("$cv", OWN, min(2), "We run 12.");
      await event("$v2", GHOST, min(3), "Thanks!");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(transcriptionCalls).toHaveLength(1);
      expect((copilotCalls[1].body.thread as { text: string }[]).map((t) => t.text)).toEqual(["🎤 Voice note: How many campaigns run on Distribute.you?", "We run 12."]);
    });

    it("a voice note that cannot be transcribed is still answered: the Copilot is told it could not be understood (SOPHIE-VOICE-1019)", async () => {
      await link();
      transcriptionAnswer = { status: 503, body: { error: "down" } };
      await voiceNote("$v3", min(1));
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      expect(transcriptionCalls).toHaveLength(2); // one retry, then decided
      await deliverDueReplies();
      expect(copilotCalls[0].body).toMatchObject({ messageId: "$v3", text: "🎤 Voice note (could not be understood)" });
      const [stored] = await db.select().from(voiceNoteTranscripts).where(eq(voiceNoteTranscripts.eventId, "$v3"));
      expect(stored).toMatchObject({ status: "failed", errorCode: "chat_service_unreachable" });
    });

    it("a voice note mirrored before the watch started is history: never transcribed (SOPHIE-VOICE-1019)", async () => {
      await link();
      await voiceNote("$v4", min(1), new Date(Date.now() - 10 * 60_000));
      await detectReplies(conn, run1);
      expect(transcriptionCalls).toHaveLength(0);
      expect(copilotCalls).toHaveLength(0);
    });

    it("a staff / own-team number writing to the assistant is handed off, never skipped as own team", async () => {
      await link();
      memberPhones = ["+33770657585"];
      repPhone = "+33770657585";
      await event("$t1", GHOST, min(1), "test from my own number");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(copilotCalls).toHaveLength(1);
      expect(campaignCalls).toHaveLength(0);
    });

    it("a message the person adds before the Copilot answered is handed too; the Copilot's own send ends the burst and is no human takeover", async () => {
      await link();
      await event("$a1", GHOST, min(1), "Hello?");
      await detectReplies(conn, run1);
      await deliverDueReplies();
      await event("$a2", GHOST, min(2), "Are you there?");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(copilotCalls.map((c) => c.body.messageId)).toEqual(["$a1", "$a2"]);
      expect((copilotCalls[1].body.thread as { text: string }[]).map((t) => t.text)).toEqual(["Hello?"]);

      // The Copilot answers through the send route (a whatsapp_sends row), mirrored as the account.
      await db.insert(whatsappSends).values({
        orgId: ORG, brandId: BRAND, idempotencyKey: "copilot:$a2", phone: "+33770657585", text: "Hi, Sophie here!", status: "sent",
        connectionId: conn.id, roomId: ROOM, ghostMxid: GHOST, eventId: "$cop", sentAt: new Date(min(3)), fromAccount: `+${SOPHIE}`,
      });
      await event("$cop", OWN, min(3), "Hi, Sophie here!");
      await event("$a3", GHOST, min(4), "Great, how much?");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(copilotCalls.map((c) => c.body.messageId)).toEqual(["$a1", "$a2", "$a3"]);
      expect((await reports()).find((r) => r.anchorEventId === "$a3")).toMatchObject({ status: "handed_off" });
    });

    it("a human of the brand typed to the person by hand: silence, one responder", async () => {
      await link();
      await event("$m1", OWN, min(0), "Hey it's Kevin, typed on the phone");
      await event("$m2", GHOST, min(1), "Hi Kevin!");
      expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "human_in_conversation", roomId: ROOM }]);
      await deliverDueReplies();
      expect(copilotCalls).toHaveLength(0);
    });

    it("one of the brand's own linked accounts the owner typed to by hand is no human takeover: handed off with linkedBy", async () => {
      await link();
      // +33770657585 (the person's number) is another linked account of the brand: the owner typed between his own numbers.
      await db.insert(matrixLinks).values({
        orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, status: "linked", method: "qr", remoteLoginId: "33770657585",
        linkedAt: new Date(),
      });
      await event("$own0", OWN, min(0), "typed by hand between my own two numbers");
      await event("$own1", GHOST, min(1), "Hi Sophie, how many campaigns run?");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(copilotCalls).toHaveLength(1);
      expect(copilotCalls[0].body.sender).toEqual({ phone: "+33770657585", name: "Kevin (WA)", linkedBy: { orgId: ORG, userId: USER } });
      expect((await reports())[0]).toMatchObject({ status: "handed_off", reason: "copilot" });
    });

    it("a skip recorded under older rules never swallows the person's later messages on the Copilot's line", async () => {
      await link();
      await event("$old1", GHOST, min(1), "test before the line was the Copilot's");
      await db.insert(replyTriggerReports).values({
        orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", connectionId: conn.id, roomId: ROOM, conversationId,
        anchorEventId: "$old1", campaignId: null, messages: [{ eventId: "$old1", at: new Date(min(1)).toISOString(), text: "test before the line was the Copilot's" }],
        firstMessageAt: new Date(min(1)), lastMessageAt: new Date(min(1)), judgment: null, detectedAt: new Date(), status: "skipped", reason: "own_team",
      });
      await event("$new1", GHOST, min(2), "Hello again?");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      await deliverDueReplies();
      expect(copilotCalls.map((c) => c.body.messageId)).toEqual(["$new1"]);
      expect((copilotCalls[0].body.thread as { text: string }[]).map((t) => t.text)).toEqual(["test before the line was the Copilot's"]);
    });

    it("no number known for the person: recorded copilot_phone_unknown, never silently", async () => {
      await link();
      await db.update(contacts).set({ phoneE164: null }).where(eq(contacts.brandId, BRAND));
      await event("$u1", GHOST, min(1), "hello");
      await detectReplies(conn, run1);
      await deliverDueReplies();
      expect(copilotCalls).toHaveLength(0);
      expect((await reports())[0]).toMatchObject({ status: "skipped", reason: "copilot_phone_unknown" });
    });

    describe("our own automated sends landing on the line from another linked account (SOPHIE-BOT-LOOP-1023)", () => {
      const KEVIN = "33770657585";
      const ECHO = "Sorry, something went wrong on my side. Please send your message again in a minute.";
      // The owner's other number, linked on the same brand: the Copilot answers on it too.
      async function linkKevin() {
        await db.insert(matrixLinks).values({
          orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: USER, status: "linked", method: "qr",
          remoteLoginId: KEVIN, linkedAt: new Date(Date.now() - 3_600_000), automationAllowed: true, personaName: "Kevin",
        });
      }
      // What crm recorded when the Copilot answered from Kevin's account TO this line (another connection, another room).
      async function ourSendToSophie(at: number, text = ECHO) {
        await db.insert(whatsappSends).values({
          orgId: ORG, brandId: BRAND, idempotencyKey: `copilot:$from-kevin-${at}`, phone: `+${SOPHIE}`, text, status: "sent",
          connectionId: "a7c1d2e3-2222-4222-8222-0000000000aa", roomId: "!kevin-side:hs", eventId: `$kevin-out-${at}`,
          sentAt: new Date(at), createdAt: new Date(at), fromAccount: `+${KEVIN}`,
        });
      }

      it("AC1: an automated send from linked account A arriving on the Copilot's line B: no hand-off, no trigger, a skipped row says why", async () => {
        await link();
        await linkKevin();
        await ourSendToSophie(min(1));
        await event("$echo1", GHOST, min(1) + 300, ECHO);
        const d = await detectReplies(conn, run1);
        expect(d.detected).toBe(0);
        expect(d.skipped).toEqual([{ reason: "own_automated_send", roomId: ROOM }]);
        await deliverDueReplies();
        await deliverDueReplies(Date.now() + 10 * 60_000);
        expect(copilotCalls).toHaveLength(0);
        expect(campaignCalls).toHaveLength(0);
        expect(jevCalls).toBe(0);
        expect(await reports()).toHaveLength(1);
        expect((await reports())[0]).toMatchObject({ status: "skipped", reason: "own_automated_send", anchorEventId: "$echo1" });
        // The next pass records nothing more for it.
        expect((await detectReplies(conn, run1)).skipped).toEqual([]);
      });

      it("AC2: the owner typing BY HAND from linked account A to line B is handed off, even right after our echo", async () => {
        await link();
        await linkKevin();
        await ourSendToSophie(min(1));
        await event("$echo1", GHOST, min(1), ECHO);
        expect((await detectReplies(conn, run1)).detected).toBe(0);
        await event("$hand1", GHOST, min(2), "Hi Sophie, how many campaigns are running?");
        expect((await detectReplies(conn, run1)).detected).toBe(1);
        await deliverDueReplies();
        expect(copilotCalls).toHaveLength(1);
        expect(copilotCalls[0].body).toMatchObject({ messageId: "$hand1", text: "Hi Sophie, how many campaigns are running?" });
        expect(copilotCalls[0].body.sender).toMatchObject({ phone: `+${KEVIN}` });
      });

      it("AC2: the same words typed by hand long after our send are a person's words, handed off", async () => {
        await link();
        await linkKevin();
        await ourSendToSophie(min(-25));
        await event("$late", GHOST, min(1), ECHO);
        expect((await detectReplies(conn, run1)).detected).toBe(1);
        await deliverDueReplies();
        expect(copilotCalls.map((c) => c.body.messageId)).toEqual(["$late"]);
      });

      it("AC3: a stranger's message is handed off as today; our send to ANOTHER number never silences it", async () => {
        await link();
        await db.insert(whatsappSends).values({
          orgId: ORG, brandId: BRAND, idempotencyKey: "copilot:$elsewhere", phone: "+15550001111", text: "Hello there", status: "sent",
          connectionId: conn.id, roomId: "!elsewhere:hs", eventId: "$elsewhere", sentAt: new Date(min(1)), createdAt: new Date(min(1)), fromAccount: `+${SOPHIE}`,
        });
        await event("$s1", GHOST, min(1), "Hello there");
        expect((await detectReplies(conn, run1)).detected).toBe(1);
        await deliverDueReplies();
        expect(copilotCalls.map((c) => c.body.messageId)).toEqual(["$s1"]);
      });

      it("a hand-off recorded before the fix that is only our echo is settled skipped at delivery, never sent to the Copilot", async () => {
        await link();
        await ourSendToSophie(min(1));
        await event("$old-echo", GHOST, min(1), ECHO);
        await db.insert(replyTriggerReports).values({
          orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", connectionId: conn.id, roomId: ROOM, conversationId,
          anchorEventId: "$old-echo", campaignId: null, messages: [{ eventId: "$old-echo", at: new Date(min(1)).toISOString(), text: ECHO }],
          firstMessageAt: new Date(min(1)), lastMessageAt: new Date(min(1)), judgment: null, detectedAt: new Date(), status: "handoff_failed", reason: "copilot_unreachable",
        });
        await deliverDueReplies();
        expect(copilotCalls).toHaveLength(0);
        expect((await reports())[0]).toMatchObject({ status: "skipped", reason: "own_automated_send" });
      });

      it("off the Copilot's line too: our echo never fires the reply trigger nor a Jev call", async () => {
        await link();
        process.env.COPILOT_UNIBOX_BRAND_ID = "a7c1d2e3-2222-4222-8222-0000000000ff";
        await buildPerson();
        await ourSendToSophie(min(1), "Great, let's book a call tomorrow?");
        await event("$wf-echo", GHOST, min(1), "Great, let's book a call tomorrow?");
        expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "own_automated_send", roomId: ROOM }]);
        await deliverDueReplies();
        expect(jevCalls).toBe(0);
        expect(campaignCalls).toHaveLength(0);
      });
    });

    it("the brand's mirror-only account and any other brand behave as before", async () => {
      await link(false);
      await event("$o1", GHOST, min(1), "Hey, how much is it?");
      expect((await detectReplies(conn, run1)).skipped).toEqual([{ reason: "automation_not_allowed", roomId: ROOM }]);
      await db.delete(matrixLinks).where(eq(matrixLinks.brandId, BRAND));
      await link(true);
      process.env.COPILOT_UNIBOX_BRAND_ID = "a7c1d2e3-2222-4222-8222-0000000000ff";
      await buildPerson();
      await event("$o2", GHOST, min(2), "Still interested, can we talk?");
      expect((await detectReplies(conn, run1)).detected).toBe(1);
      expect(jevCalls).toBe(1);
      await deliverDueReplies();
      expect(campaignCalls).toHaveLength(1);
      expect(copilotCalls).toHaveLength(0);
    });
  });
});
