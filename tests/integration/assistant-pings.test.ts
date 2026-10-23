import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  assistantMessagePings,
  contacts,
  conversations,
  matrixConnections,
  matrixLinks,
  matrixRawEvents,
  people,
  peopleScopes,
  voiceNoteTranscripts,
  whatsappSends,
  type MatrixConnection,
} from "../../src/db/schema.js";
import { storeCopilotTurn } from "../../src/lib/copilot/messages.js";
import { announceAssistantMatrixMessages, announceCopilotMessages, type CopilotPushed } from "../../src/lib/assistant-pings.js";
import copilotRoutes from "../../src/routes/copilot.js";

/**
 * SOPHIE-TG-PING-1018: one owner Telegram ping per message with our assistant,
 * both ways, on the web Copilot and on the staff scope's linked accounts with
 * automation on. Real Postgres (gated on CRM_TEST_DB); Telegram, client-service,
 * brand-service and runs-service stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "5afe5afe-1018-4018-8018-000000000001";
const BRAND = "5afe5afe-1018-4018-8018-000000000002";
const CHAT_ORG = "5afe5afe-1018-4018-8018-000000000003";
const USER_JANE = "5afe5afe-1018-4018-8018-000000000004";
const USER_KEVIN = "5afe5afe-1018-4018-8018-000000000005";
const OTHER_BRAND = "5afe5afe-1018-4018-8018-000000000006";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const OWN = "@crm_sophie:hs";
const GHOST = "@whatsapp_lid-1018:hs";
const ROOM = "!sophie-room:hs";
const GROUP_ROOM = "!sophie-group:hs";

process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "c";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "b";
process.env.TELEGRAM_BOT_TOKEN = "bot-token";
process.env.TELEGRAM_OWNER_CHAT_ID = "42";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sent: string[] = [];
let memberPhones: string[] = [];
let membersDown = false;
let salesRepPhone: string | null = null;

function installFetchStub() {
  sent = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.telegram.org") {
      sent.push(JSON.parse(String(init!.body)).text);
      return json({ ok: true, result: { message_id: 2000 + sent.length } });
    }
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "client.test" && url.pathname === `/internal/orgs/${STAFF_ORG}`) {
      return json({ id: STAFF_ORG, externalId: "org_staff", name: "distribute.you" });
    }
    if (url.host === "client.test" && url.pathname === `/internal/orgs/${CHAT_ORG}`) {
      return json({ id: CHAT_ORG, externalId: "org_prospect", name: "Prospect Inc" });
    }
    if (url.host === "client.test" && url.pathname === `/internal/users/${USER_JANE}`) {
      return json({ user: { id: USER_JANE, email: "jane@prospect.io", firstName: "Jane", lastName: "Doe" } });
    }
    if (url.host === "client.test" && url.pathname === "/internal/users") {
      if (membersDown) return json({ error: "down" }, 503);
      return json({ users: memberPhones.map((phone) => ({ email: null, phone })) });
    }
    if (url.host === "brand.test" && url.pathname === `/orgs/brands/${BRAND}/sales-rep`) return json({ salesRepPhone });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const at = (minutes: number) => new Date(Date.now() - 60 * 60_000 + minutes * 60_000).toISOString();

const turn = (over: Partial<CopilotPushed> & { messages: CopilotPushed["messages"] }): CopilotPushed => ({
  orgId: CHAT_ORG,
  userId: USER_JANE,
  email: "jane@prospect.io",
  displayName: null,
  sessionId: "sess-1",
  ...over,
});

async function chat(t: CopilotPushed) {
  const { newMessageIds } = await storeCopilotTurn(t, "run-1");
  await announceCopilotMessages(t, newMessageIds, "run-1");
}

let conn: MatrixConnection;
let contactId: string;

async function event(id: string, sender: string, body: string, room = ROOM) {
  const ts = Date.now();
  await db.insert(matrixRawEvents).values({
    orgId: STAFF_ORG, brandId: BRAND, connectionId: conn.id, eventId: id, roomId: room, sender, eventType: "m.room.message",
    originServerTs: new Date(ts), ingestedAt: new Date(), payload: { event_id: id, type: "m.room.message", sender, origin_server_ts: ts, content: { msgtype: "m.text", body } },
  });
}

async function wipe() {
  await db.delete(voiceNoteTranscripts).where(eq(voiceNoteTranscripts.orgId, STAFF_ORG));
  await db.execute(sql`DELETE FROM assistant_message_pings WHERE message_ref LIKE 'sp-%' OR message_ref LIKE '$sp-%'`);
  await db.execute(sql`DELETE FROM copilot_messages WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM person_ids WHERE org_id = ${STAFF_ORG}`);
  await db.delete(whatsappSends).where(eq(whatsappSends.orgId, STAFF_ORG));
  await db.delete(people).where(eq(people.orgId, STAFF_ORG));
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, STAFF_ORG));
  await db.delete(matrixLinks).where(eq(matrixLinks.orgId, STAFF_ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, STAFF_ORG));
  await db.delete(contacts).where(eq(contacts.orgId, STAFF_ORG));
}

describe.skipIf(!RUN)("owner Telegram ping per message with our assistant", () => {
  beforeEach(async () => {
    await wipe();
    installFetchStub();
    memberPhones = [];
    membersDown = false;
    salesRepPhone = null;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await wipe();
  });

  describe("web Copilot", () => {
    it("one ping per message, both ways, none on a re-delivered message", async () => {
      await chat(
        turn({
          messages: [
            { messageId: "sp-1", role: "user", text: "Can you find me 50 dentists in Lyon?", at: at(0) },
            { messageId: "sp-2", role: "assistant", text: "Sure, on it.", at: at(0.1) },
          ],
        }),
      );
      expect(sent).toHaveLength(2);
      const [personRow] = (await db.execute(sql`SELECT person_id FROM person_ids WHERE org_id = ${STAFF_ORG} AND identity_key = 'email:jane@prospect.io'`)) as unknown as { person_id: string }[];
      const thread = `Thread: https://dashboard.distribute.you/v2/orgs/org_staff/brands/${BRAND}/unibox?person=${personRow.person_id}`;
      expect(sent[0]).toBe(
        ["Jane Doe → AI Copilot (web chat)", "Who: Jane Doe, jane@prospect.io", "Org: Prospect Inc", 'Message: "Can you find me 50 dentists in Lyon?"', thread].join("\n"),
      );
      expect(sent[1]).toBe(["AI Copilot → Jane Doe (web chat)", "Who: Jane Doe, jane@prospect.io", "Org: Prospect Inc", 'Message: "Sure, on it."', thread].join("\n"));

      // chat-service retries the push, and a restart replays it as new: no second ping.
      const replay = turn({ messages: [{ messageId: "sp-1", role: "user", text: "Can you find me 50 dentists in Lyon?", at: at(0) }] });
      await chat(replay);
      await announceCopilotMessages(replay, ["sp-1"], "run-1");
      expect(sent).toHaveLength(2);
      const [ping] = await db.select().from(assistantMessagePings).where(eq(assistantMessagePings.messageRef, "sp-1"));
      expect(ping).toMatchObject({ source: "copilot", channel: "chat", direction: "inbound", status: "sent", telegramMessageId: 2001 });
    }, 30_000);

    it("staff never pings, under a staff address or any address of a user ever seen with one", async () => {
      await chat(turn({ userId: USER_KEVIN, email: "kevin@distribute.you", messages: [{ messageId: "sp-k1", role: "user", text: "test", at: at(0) }] }));
      await chat(turn({ userId: USER_KEVIN, email: "kev@outside.io", messages: [{ messageId: "sp-k2", role: "assistant", text: "hello", at: at(1) }] }));
      expect(sent).toHaveLength(0);
      // Scoped to this file's refs: other files leave their own copilot pings behind.
      const rows = (await db.select().from(assistantMessagePings).where(eq(assistantMessagePings.source, "copilot"))).filter((r) =>
        r.messageRef.startsWith("sp-"),
      );
      expect(rows.map((r) => [r.messageRef, r.status, r.reason]).sort()).toEqual([
        ["sp-k1", "skipped", "staff"],
        ["sp-k2", "skipped", "staff"],
      ]);
    }, 30_000);

    it("the push route answers first; the assistant is named from the linked account's persona", async () => {
      // The owner's own line (its number = the sales rep phone) carries a persona too: it names nothing (PERSO-TG-PING-1023).
      salesRepPhone = "+33 7 70 00 00 01";
      await db.insert(matrixLinks).values({
        orgId: STAFF_ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: "u", status: "linked", method: "qr", personaName: "Kevin", automationAllowed: true,
        remoteLoginId: "33770000001",
        connectionId: (
          await db.insert(matrixConnections).values({ orgId: STAFF_ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: "@crm_kevin:hs", counterpartPrefix: "@whatsapp_", createdByUserId: "u" }).returning()
        )[0].id,
      });
      await db.insert(matrixLinks).values({
        orgId: STAFF_ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: "u", status: "linked", method: "qr", personaName: "Sophie", automationAllowed: true,
        connectionId: (
          await db.insert(matrixConnections).values({ orgId: STAFF_ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: OWN, counterpartPrefix: "@whatsapp_", createdByUserId: "u" }).returning()
        )[0].id,
      });
      const a = express();
      a.use(express.json());
      a.use(copilotRoutes);
      const res = await request(a)
        .post("/internal/copilot/messages")
        .set("x-api-key", API_KEY)
        .send(turn({ messages: [{ messageId: "sp-r1", role: "user", text: "hello", at: at(0) }] }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stored: 1, duplicates: 0 });
      for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(sent).toHaveLength(1);
      expect(sent[0].split("\n")[0]).toBe("Jane Doe → Sophie (web chat)");
    }, 30_000);
  });

  describe("the assistant's linked account", () => {
    beforeEach(async () => {
      [conn] = await db
        .insert(matrixConnections)
        .values({ orgId: STAFF_ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: OWN, counterpartPrefix: "@whatsapp_", createdByUserId: "u" })
        .returning();
      await db.insert(matrixLinks).values({
        orgId: STAFF_ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: "u", status: "linked", method: "qr",
        personaName: "Sophie", automationAllowed: true, connectionId: conn.id,
      });
      const [contact] = await db
        .insert(contacts)
        .values({ orgId: STAFF_ORG, brandId: BRAND, phoneE164: "+15550101018", fullName: "Paul Test", rawAttributes: {}, source: "matrix", channel: "whatsapp", channelHandle: GHOST, sourceConnectionId: conn.id })
        .returning();
      contactId = contact.id;
      await db.insert(conversations).values({
        orgId: STAFF_ORG, brandId: BRAND, connectionId: conn.id, contactId, channel: "whatsapp", roomId: ROOM,
        firstMessageAt: new Date(), lastMessageAt: new Date(), messageCount: 1, inboundCount: 1, outboundCount: 0, lastEventId: "$x",
      });
      // The watch looks once: everything mirrored before is history.
      await announceAssistantMatrixMessages(conn);
      [conn] = await db.select().from(matrixConnections).where(eq(matrixConnections.id, conn.id));
    });

    it("the person's message and the assistant's reply each ping once; a re-delivery pings nothing", async () => {
      await event("$sp-in-1", GHOST, "Hi, how much is it?");
      await db.insert(whatsappSends).values({
        orgId: STAFF_ORG, brandId: BRAND, idempotencyKey: "sp-send-1", phone: "+15550101018", text: "It is free to start.", status: "sent",
        connectionId: conn.id, roomId: ROOM, ghostMxid: GHOST, eventId: "$sp-out-1", sentAt: new Date(),
      });
      await event("$sp-out-1", OWN, "It is free to start.");
      expect(await announceAssistantMatrixMessages(conn)).toBe(2);
      expect(sent).toHaveLength(2);
      const [personRow] = (await db.execute(sql`SELECT person_id FROM person_ids WHERE org_id = ${STAFF_ORG} AND identity_key = ${`matrix:${contactId}`}`)) as unknown as { person_id: string }[];
      const thread = `Thread: https://dashboard.distribute.you/v2/orgs/org_staff/brands/${BRAND}/unibox?person=${personRow.person_id}`;
      expect(sent[0]).toBe(["Paul Test → Sophie (WhatsApp)", "Who: Paul Test, +15550101018", 'Message: "Hi, how much is it?"', thread].join("\n"));
      expect(sent[1]).toBe(["Sophie → Paul Test (WhatsApp)", "Who: Paul Test, +15550101018", 'Message: "It is free to start."', thread].join("\n"));

      // The next pass (and the 5-min pass at the same time) sees the same events: nothing more.
      await Promise.all([announceAssistantMatrixMessages(conn), announceAssistantMatrixMessages(conn)]);
      expect(sent).toHaveLength(2);
    }, 30_000);

    it("a voice note pings what was SAID once transcribed; untranscribed it waits, then pings without words (SOPHIE-VOICE-1019)", async () => {
      const voice = async (id: string, ts: number) =>
        db.insert(matrixRawEvents).values({
          orgId: STAFF_ORG, brandId: BRAND, connectionId: conn.id, eventId: id, roomId: ROOM, sender: GHOST, eventType: "m.room.message",
          originServerTs: new Date(ts), ingestedAt: new Date(),
          payload: { event_id: id, type: "m.room.message", sender: GHOST, origin_server_ts: ts, content: { msgtype: "m.audio", body: "", url: `mxc://hs/${id.slice(1)}`, filename: "Voice message.ogg", info: { mimetype: "audio/ogg" } } },
        });
      await voice("$sp-voice-1", Date.now());
      // Not transcribed yet: nothing decided.
      expect(await announceAssistantMatrixMessages(conn)).toBe(0);
      expect(sent).toHaveLength(0);
      await db.insert(voiceNoteTranscripts).values({
        eventId: "$sp-voice-1", orgId: STAFF_ORG, brandId: BRAND, connectionId: conn.id, roomId: ROOM, status: "completed", text: "How many campaigns run on Distribute.you?",
      });
      expect(await announceAssistantMatrixMessages(conn)).toBe(1);
      expect(sent[0].split("\n")[2]).toBe('Message: "🎤 Voice note: How many campaigns run on Distribute.you?"');

      // Never transcribed (history, automation off) and past the wait: decided, no words to ping.
      await voice("$sp-voice-2", Date.now());
      await announceAssistantMatrixMessages(conn);
      expect(await db.select().from(assistantMessagePings).where(eq(assistantMessagePings.messageRef, "$sp-voice-2"))).toHaveLength(0);
      await announceAssistantMatrixMessages(conn, Date.now() + 11 * 60_000);
      expect(sent).toHaveLength(1);
      const [skip] = await db.select().from(assistantMessagePings).where(eq(assistantMessagePings.messageRef, "$sp-voice-2"));
      expect(skip).toMatchObject({ status: "skipped", reason: "no_text" });
    }, 30_000);

    it("the built person names the link; history before the watch never pings", async () => {
      const [scope] = await db.insert(peopleScopes).values({ orgId: STAFF_ORG, brandId: BRAND, createdByUserId: "u", status: "ready" }).returning();
      const [conversation] = await db.select().from(conversations).where(eq(conversations.connectionId, conn.id));
      await db.insert(people).values({
        scopeId: scope.id, orgId: STAFF_ORG, brandId: BRAND, personKey: "phone:+15550101018", identityKeys: ["phone:+15550101018"],
        displayName: "Paul Builder", emails: ["paul@builder.io"], phones: ["+15550101018"], sources: ["matrix"], mergeEvidence: [],
        presences: [{ source: "matrix", sourceRef: "x", displayName: "Paul", company: null, emails: [], phones: [], firstActivityAt: null, lastActivityAt: null, messageCount: 1, inboundCount: 1, outboundCount: 0, detail: { conversationId: conversation.id } }],
        state: "in_conversation", stateSource: "matrix", personId: "5afe5afe-1018-4018-8018-0000000000f1",
      });
      await db.insert(matrixRawEvents).values({
        orgId: STAFF_ORG, brandId: BRAND, connectionId: conn.id, eventId: "$sp-old", roomId: ROOM, sender: GHOST, eventType: "m.room.message",
        originServerTs: new Date(Date.now() - 3 * 3_600_000), ingestedAt: new Date(Date.now() - 3 * 3_600_000),
        payload: { event_id: "$sp-old", type: "m.room.message", sender: GHOST, origin_server_ts: 0, content: { msgtype: "m.text", body: "old" } },
      });
      await event("$sp-in-2", GHOST, "Still there?");
      await announceAssistantMatrixMessages(conn);
      expect(sent).toEqual([
        [
          "Paul Builder → Sophie (WhatsApp)",
          "Who: Paul Builder, +15550101018, paul@builder.io",
          'Message: "Still there?"',
          `Thread: https://dashboard.distribute.you/v2/orgs/org_staff/brands/${BRAND}/unibox?person=5afe5afe-1018-4018-8018-0000000000f1`,
        ].join("\n"),
      ]);
    }, 30_000);

    it("staff and own-team numbers, hand-typed messages and groups never ping", async () => {
      memberPhones = ["+15550101018"]; // the counterpart is a member of the staff org
      await event("$sp-team", GHOST, "test from my own phone");
      await event("$sp-hand", OWN, "typed by hand on the assistant's phone");
      await event("$sp-group", "@whatsapp_lid-9:hs", "hello group", GROUP_ROOM);
      await announceAssistantMatrixMessages(conn);
      expect(sent).toHaveLength(0);
      const rows = await db.select().from(assistantMessagePings).where(eq(assistantMessagePings.connectionId, conn.id));
      expect(rows.map((r) => [r.messageRef, r.status, r.reason]).sort()).toEqual([
        ["$sp-group", "skipped", "not_conversation"],
        ["$sp-hand", "skipped", "hand_typed"],
        ["$sp-team", "skipped", "staff"],
      ]);
    }, 30_000);

    it("a person's own line (its number = the sales rep's or a member's) pings nothing, pro or personal thread (PERSO-TG-PING-1023)", async () => {
      // The assistant line with a number of its own that is nobody's on the team: pings as before.
      await db.update(matrixLinks).set({ remoteLoginId: "77776879632" }).where(eq(matrixLinks.connectionId, conn.id));
      await event("$sp-line-1", GHOST, "Hi Sophie, is it free?");
      expect(await announceAssistantMatrixMessages(conn)).toBe(1);
      expect(sent).toHaveLength(1);

      // The same account is the owner's line once its number is the sales rep phone: a friend's message, a
      // prospect's message and the line's own outbound are each recorded, none sent.
      salesRepPhone = "+7 777 687 9632";
      await event("$sp-line-2", GHOST, "notre séjour a été raccourci");
      await db.insert(whatsappSends).values({
        orgId: STAFF_ORG, brandId: BRAND, idempotencyKey: "sp-send-line", phone: "+15550101018", text: "Happy to help.", status: "sent",
        connectionId: conn.id, roomId: ROOM, ghostMxid: GHOST, eventId: "$sp-line-3", sentAt: new Date(),
      });
      await event("$sp-line-3", OWN, "Happy to help.");
      expect(await announceAssistantMatrixMessages(conn)).toBe(0);
      expect(sent).toHaveLength(1);

      // Or a member's phone (the org's members, client-service).
      salesRepPhone = null;
      memberPhones = ["+77776879632"];
      await event("$sp-line-4", GHOST, "how much for 3 months?");
      expect(await announceAssistantMatrixMessages(conn)).toBe(0);
      expect(sent).toHaveLength(1);
      const rows = await db.select().from(assistantMessagePings).where(eq(assistantMessagePings.connectionId, conn.id));
      expect(rows.map((r) => [r.messageRef, r.status, r.reason, r.direction]).sort()).toEqual([
        ["$sp-line-1", "sent", null, "inbound"],
        ["$sp-line-2", "skipped", "own_line", "inbound"],
        ["$sp-line-3", "skipped", "own_line", "outbound"],
        ["$sp-line-4", "skipped", "own_line", "inbound"],
      ]);
    }, 30_000);

    it("own team unreadable: nothing decided, the next pass pings", async () => {
      membersDown = true;
      await event("$sp-in-3", GHOST, "hello?");
      await expect(announceAssistantMatrixMessages(conn)).resolves.toBe(0);
      expect(sent).toHaveLength(0);
      membersDown = false;
      expect(await announceAssistantMatrixMessages(conn)).toBe(1);
      expect(sent).toHaveLength(1);
    }, 30_000);

    it("an account with automation off, or of another brand, is not the assistant", async () => {
      await db.update(matrixLinks).set({ automationAllowed: false }).where(eq(matrixLinks.connectionId, conn.id));
      await event("$sp-in-4", GHOST, "hi");
      expect(await announceAssistantMatrixMessages(conn)).toBe(0);
      const [other] = await db
        .insert(matrixConnections)
        .values({ orgId: STAFF_ORG, brandId: OTHER_BRAND, channel: "whatsapp", matrixUserId: "@crm_other:hs", counterpartPrefix: "@whatsapp_", createdByUserId: "u" })
        .returning();
      expect(await announceAssistantMatrixMessages(other)).toBe(0);
      expect(sent).toHaveLength(0);
      await db.delete(matrixConnections).where(eq(matrixConnections.id, other.id));
    }, 30_000);
  });
});
