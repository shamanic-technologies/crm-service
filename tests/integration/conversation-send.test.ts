import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, conversations, matrixConnections, matrixLinks, matrixRawEvents, people, peopleScopes, whatsappSends } from "../../src/db/schema.js";

/**
 * LEAD-REPLY-CHANNEL-1127: automation answers a person IN their own conversation, on the app they wrote on, from the
 * account they wrote to, through ONE path for every bridged app. Against a real database; the homeserver and the
 * bridges are mocked at their module boundary. The fixture app is Telegram on purpose: nothing here is WhatsApp's.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "c1c1c1c1-1111-4111-8111-000000000001";
const BRAND = "c1c1c1c1-1111-4111-8111-000000000002";
const CAMPAIGN = "c1c1c1c1-1111-4111-8111-0000000000c1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const PRO_MXID = "@crm_tg_pro:hs";
const PERSO_MXID = "@crm_tg_perso:hs";
const WA_MXID = "@crm_wa_ai:hs";
const GHOST_TG = "@telegram_777000111:hs";
const GHOST_TG_PERSO = "@telegram_777000222:hs";
const GHOST_WA = "@whatsapp_33611112222:hs";

const sent: { token: string; room: string; text: string; replyTo: string | null }[] = [];
const bridge = { state: "CONNECTED" as string };

vi.mock("../../src/lib/matrix/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/client.js")>()),
  setTyping: vi.fn(async () => undefined),
  sendText: vi.fn(async (token: string, room: string, txnId: string, text: string, replyTo: string | null) => {
    sent.push({ token, room, text, replyTo });
    return `$sent-${txnId}`;
  }),
}));
vi.mock("../../src/lib/matrix/bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/bridge.js")>()),
  bridgeLogins: vi.fn(async () => [
    { id: "777000999", name: "pro", state: { state_event: bridge.state, message: bridge.state === "BAD_CREDENTIALS" ? "You were logged out" : undefined } },
    { id: "777000888", name: "perso", state: { state_event: "CONNECTED" } },
    { id: "33700000003", name: "wa", state: { state_event: "CONNECTED" } },
  ]),
}));

const { default: conversationRoutes } = await import("../../src/routes/conversations.js");
const { default: whatsappRoutes } = await import("../../src/routes/whatsapp.js");
const { accountRefusal, latestInbound } = await import("../../src/lib/matrix/conversation-send.js");

const app = express();
app.use(express.json());
app.use(conversationRoutes);
app.use(whatsappRoutes);

const ids: Record<string, string> = {};

async function wipe() {
  await db.delete(whatsappSends).where(eq(whatsappSends.orgId, ORG));
  await db.delete(people).where(eq(people.orgId, ORG));
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  await db.delete(matrixRawEvents).where(eq(matrixRawEvents.orgId, ORG));
  await db.delete(conversations).where(eq(conversations.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
  await db.delete(matrixLinks).where(eq(matrixLinks.orgId, ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, ORG));
  await db.execute(sql`DELETE FROM people_corrections WHERE org_id = ${ORG}`);
}

async function line(name: string, channel: string, mxid: string, prefix: string, loginId: string, accountType: string, automationAllowed: boolean) {
  const [conn] = await db
    .insert(matrixConnections)
    .values({ orgId: ORG, brandId: BRAND, channel, matrixUserId: mxid, counterpartPrefix: prefix, createdByUserId: "u", accessToken: `tok-${name}` })
    .returning();
  await db.insert(matrixLinks).values({
    orgId: ORG, brandId: BRAND, channel, createdByUserId: "u", status: "linked", method: "qr", connectionId: conn.id,
    remoteLoginId: loginId, accountType, automationAllowed, personaName: name === "tgpro" ? "Kevin" : null, linkedAt: new Date(),
  });
  ids[name] = conn.id;
  return conn.id;
}

async function conversation(name: string, connectionId: string, channel: string, ghost: string, room: string, inboundAt: number, phone: string | null = null) {
  const [c] = await db
    .insert(contacts)
    .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel, channelHandle: ghost, fullName: "Paul Client", phoneE164: phone, rawAttributes: {}, sourceConnectionId: connectionId })
    .returning();
  const [v] = await db
    .insert(conversations)
    .values({
      orgId: ORG, brandId: BRAND, connectionId, contactId: c.id, channel, roomId: room,
      firstMessageAt: new Date(inboundAt), lastMessageAt: new Date(inboundAt), messageCount: 1, inboundCount: 1, outboundCount: 0, lastEventId: `$in-${name}`,
    })
    .returning();
  await db.insert(matrixRawEvents).values({
    orgId: ORG, brandId: BRAND, connectionId, eventId: `$in-${name}`, roomId: room, sender: ghost, eventType: "m.room.message",
    originServerTs: new Date(inboundAt), payload: { event_id: `$in-${name}`, type: "m.room.message", sender: ghost, origin_server_ts: inboundAt, content: { msgtype: "m.text", body: "Hi, how much is it?" } },
  });
  ids[name] = v.id;
  return { contactId: c.id, conversationId: v.id };
}

describe("conversation send rules (pure)", () => {
  const ok = { accessToken: "t", loginId: "1", linkStatus: "linked", connStatus: "active", account: "+1" };
  it("refuses a personal line and a line with automation off, by name, whatever the app", () => {
    expect(accountRefusal({ ...ok, accountType: "personal_human", automationAllowed: true }, "telegram", null)?.code).toBe("automation_not_allowed");
    expect(accountRefusal({ ...ok, accountType: "personal_human", automationAllowed: true }, "telegram", null)?.error).toMatch(/telegram account \+1, a personal line/);
    expect(accountRefusal({ ...ok, accountType: "pro_human", automationAllowed: false }, "linkedin", null)?.code).toBe("automation_not_allowed");
  });
  it("a hand-typed message takes a human's account, never a pro_ai one", () => {
    expect(accountRefusal({ ...ok, accountType: "pro_human", automationAllowed: true }, "telegram", "2026-11-27T10:00:00Z")?.code).toBe("human_in_conversation");
    expect(accountRefusal({ ...ok, accountType: "pro_ai", automationAllowed: true }, "telegram", "2026-11-27T10:00:00Z")).toBeNull();
  });
  it("an unlinked account is no writer", () => {
    expect(accountRefusal({ ...ok, linkStatus: "unlinked", accountType: "pro_ai", automationAllowed: true }, "telegram", null)?.code).toBe("account_not_linked");
    expect(accountRefusal({ ...ok, accessToken: null, accountType: "pro_ai", automationAllowed: true }, "telegram", null)?.code).toBe("account_not_linked");
  });
  it("the conversation of their latest message wins, never one they never wrote in", () => {
    expect(
      latestInbound([
        { conversationId: "a", lastInboundAt: "2026-11-26T10:00:00Z" },
        { conversationId: "b", lastInboundAt: "2026-11-27T10:00:00Z" },
        { conversationId: "c", lastInboundAt: null },
      ])?.conversationId,
    ).toBe("b");
    expect(latestInbound([{ conversationId: "c", lastInboundAt: null }])).toBeNull();
  });
});

describe.skipIf(!RUN)("conversation reach + send, any bridged app (DB)", () => {
  const now = Date.now();
  beforeAll(async () => {
    await wipe();
    // runs-service stubbed at fetch (every org route opens its run); the mirror refresh after a send is off.
    process.env.WHATSAPP_SEND_REFRESH = "off";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/runs")) return new Response(JSON.stringify({ id: "run-cs" }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch ${url.toString()}`);
    });
  });
  beforeEach(async () => {
    await wipe();
    sent.length = 0;
    bridge.state = "CONNECTED";
    const tgPro = await line("tgpro", "telegram", PRO_MXID, "@telegram_", "777000999", "pro_human", true);
    const tgPerso = await line("tgperso", "telegram", PERSO_MXID, "@telegram_", "777000888", "personal_human", false);
    const wa = await line("waai", "whatsapp", WA_MXID, "@whatsapp_", "33700000003", "pro_ai", true);
    const tg = await conversation("conv-tg", tgPro, "telegram", GHOST_TG, "!tg-room:hs", now - 60_000);
    const waConv = await conversation("conv-wa", wa, "whatsapp", GHOST_WA, "!wa-room:hs", now - 3_600_000, "+33611112222");
    await conversation("conv-perso", tgPerso, "telegram", GHOST_TG_PERSO, "!perso-room:hs", now - 30_000);
    // One person, known by email, holding the Telegram and the WhatsApp conversations (the people index).
    const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "u", status: "ready" }).returning();
    await db.insert(people).values({
      scopeId: scope.id, orgId: ORG, brandId: BRAND, personKey: "email:paul@client.test", displayName: "Paul Client",
      emails: ["paul@client.test"], phones: ["+33611112222"], identityKeys: ["email:paul@client.test", "phone:+33611112222"],
      sources: ["matrix"], mergeEvidence: [], state: "open", stateSource: "matrix",
      presences: [
        { source: "matrix", ref: tg.contactId, emails: [], phones: [], detail: { conversationId: tg.conversationId, channel: "telegram", channelHandle: GHOST_TG } },
        { source: "matrix", ref: waConv.contactId, emails: [], phones: ["+33611112222"], detail: { conversationId: waConv.conversationId, channel: "whatsapp", channelHandle: GHOST_WA } },
      ],
    } as never);
  });
  afterAll(async () => {
    await wipe();
    vi.unstubAllGlobals();
  });

  it("the person wrote last on the pro Telegram account: reach names THAT conversation and account, never WhatsApp", async () => {
    const res = await request(app).post("/orgs/conversations/reach").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, email: "paul@client.test" });
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.conversation).toMatchObject({ conversationId: ids["conv-tg"], channel: "telegram", roomId: "!tg-room:hs" });
    expect(res.body.fromAccount).toMatchObject({ account: "+777000999", accountType: "pro_human", persona: { name: "Kevin" } });
  });

  it("an automated send reaches them in that same Telegram conversation, from that account, recorded with its app", async () => {
    const res = await request(app)
      .post("/orgs/conversations/messages")
      .set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-campaign-id", CAMPAIGN)
      .send({ brandId: BRAND, conversationId: ids["conv-tg"], text: "It is $99 a month.", idempotencyKey: "k-tg-1", replyToEventId: "$in-conv-tg" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "sent", duplicate: false, conversation: { channel: "telegram" }, replyTo: { quoted: true } });
    expect(res.body.connectionId).toBeUndefined();
    expect(sent).toEqual([{ token: "tok-tgpro", room: "!tg-room:hs", text: "It is $99 a month.", replyTo: "$in-conv-tg" }]);
    const [row] = await db.select().from(whatsappSends).where(eq(whatsappSends.idempotencyKey, "k-tg-1"));
    expect(row).toMatchObject({ status: "sent", channel: "telegram", connectionId: ids.tgpro, roomId: "!tg-room:hs", campaignId: CAMPAIGN, email: "paul@client.test", phone: null });
    // A retry never sends twice.
    const again = await request(app)
      .post("/orgs/conversations/messages").set("x-api-key", API_KEY).set("x-org-id", ORG)
      .send({ brandId: BRAND, conversationId: ids["conv-tg"], text: "It is $99 a month.", idempotencyKey: "k-tg-1" });
    expect(again.body.duplicate).toBe(true);
    expect(sent).toHaveLength(1);
    // Not a WhatsApp send: the WhatsApp list by email stays empty.
    const wa = await request(app).get(`/orgs/whatsapp/messages?brandId=${BRAND}&email=paul@client.test`).set("x-api-key", API_KEY).set("x-org-id", ORG);
    expect(wa.body.sends).toEqual([]);
  });

  it("bubbles go out in order into the same conversation", async () => {
    const res = await request(app)
      .post("/orgs/conversations/messages").set("x-api-key", API_KEY).set("x-org-id", ORG)
      .send({ brandId: BRAND, email: "paul@client.test", messages: ["Hi Paul", "It is $99"], idempotencyKey: "k-tg-b" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(sent.map((s) => [s.room, s.text])).toEqual([["!tg-room:hs", "Hi Paul"], ["!tg-room:hs", "It is $99"]]);
  }, 30_000);

  it("a personal account is refused with a named reason, and nothing goes out from any other account or app", async () => {
    const reach = await request(app).post("/orgs/conversations/reach").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, conversationId: ids["conv-perso"] });
    expect(reach.body).toMatchObject({ reachable: false, code: "automation_not_allowed", conversation: { channel: "telegram" }, fromAccount: { accountType: "personal_human" } });
    expect(reach.body.error).toMatch(/personal line/);
    const send = await request(app)
      .post("/orgs/conversations/messages").set("x-api-key", API_KEY).set("x-org-id", ORG)
      .send({ brandId: BRAND, conversationId: ids["conv-perso"], text: "hello", idempotencyKey: "k-perso" });
    expect(send.status).toBe(422);
    expect(send.body).toMatchObject({ type: "refused", code: "automation_not_allowed" });
    expect(sent).toEqual([]);
    const [row] = await db.select().from(whatsappSends).where(eq(whatsappSends.idempotencyKey, "k-perso"));
    expect(row).toMatchObject({ status: "refused", errorCode: "automation_not_allowed", channel: "telegram" });
  });

  it("a hand-typed message on a pro_human account takes it; the app logging the account out is named", async () => {
    await db.insert(matrixRawEvents).values({
      orgId: ORG, brandId: BRAND, connectionId: ids.tgpro, eventId: "$hand", roomId: "!tg-room:hs", sender: PRO_MXID, eventType: "m.room.message",
      originServerTs: new Date(now - 10_000), payload: { event_id: "$hand", type: "m.room.message", sender: PRO_MXID, origin_server_ts: now - 10_000, content: { msgtype: "m.text", body: "Let me check and come back" } },
    });
    const human = await request(app).post("/orgs/conversations/reach").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, conversationId: ids["conv-tg"] });
    expect(human.body).toMatchObject({ reachable: false, code: "human_in_conversation" });
    await db.delete(matrixRawEvents).where(eq(matrixRawEvents.eventId, "$hand"));
    bridge.state = "BAD_CREDENTIALS";
    const out = await request(app).post("/orgs/conversations/reach").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, conversationId: ids["conv-tg"] });
    expect(out.body).toMatchObject({ reachable: false, code: "account_not_connected" });
    expect(out.body.error).toMatch(/You were logged out/);
  });

  it("a person who never wrote on a linked account, or a conversation of another brand, is no_conversation", async () => {
    const nobody = await request(app).post("/orgs/conversations/reach").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, email: "nobody@client.test" });
    expect(nobody.body).toMatchObject({ reachable: false, code: "no_conversation" });
    const foreign = await request(app)
      .post("/orgs/conversations/reach").set("x-api-key", API_KEY).set("x-org-id", ORG)
      .send({ brandId: "c1c1c1c1-1111-4111-8111-000000000099", conversationId: ids["conv-tg"] });
    expect(foreign.body).toMatchObject({ reachable: false, code: "no_conversation" });
  });
});
