import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { matrixConnections, matrixRawEvents, whatsappSends } from "../../src/db/schema.js";

/**
 * SOPHIE-WA-HUMAN-1106 against a real database: a send quotes a message of its room (WhatsApp « Reply »), the
 * answering AI holds « typing… » through the route, and a photo's bytes are served to the brand that received it.
 * The bridge, the homeserver and the accounts are mocked at their module boundary.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "5a1e5a1e-1106-4106-8106-000000000001";
const BRAND = "5a1e5a1e-1106-4106-8106-000000000002";
const OTHER_BRAND = "5a1e5a1e-1106-4106-8106-000000000003";
const CONNECTION = "5a1e5a1e-1106-4106-8106-0000000000d1";
const PHONE = "+33612345678";
const ROOM = "!room:hs";
const OWN = "@acct:hs";
const GHOST = "@whatsapp_lid-1:hs";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const calls: string[] = [];
const state = { humanTyped: false };

vi.mock("../../src/lib/matrix/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/client.js")>()),
  joinRoom: vi.fn(async () => undefined),
  readRoomBridgeInfo: vi.fn(async () => []),
  setTyping: vi.fn(async (_t: string, room: string, _u: string, typing: boolean) => {
    calls.push(`typing:${room}:${typing}`);
  }),
  sendText: vi.fn(async (_t: string, _room: string, txnId: string, text: string, replyTo: string | null = null) => {
    calls.push(`send:${text}${replyTo ? `>${replyTo}` : ""}`);
    return `$ev-${txnId}`;
  }),
}));
vi.mock("../../src/lib/matrix/bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/bridge.js")>()),
  resolveIdentifier: vi.fn(async () => ({ id: "lid-1", mxid: GHOST, dmRoomId: ROOM })),
  createDm: vi.fn(async () => ({ id: "lid-1", mxid: GHOST, dmRoomId: ROOM })),
}));
vi.mock("../../src/lib/whatsapp/room-check.js", () => ({
  expectedChannelIds: () => new Set<string>(),
  roomDeliversTo: () => ({ ok: true }),
}));
vi.mock("../../src/lib/whatsapp/accounts.js", async (orig) => {
  const account = {
    linkId: "link-1",
    connectionId: CONNECTION,
    matrixUserId: OWN,
    accessToken: "tok",
    loginId: "77776879632",
    outreachDefault: true,
    automationAllowed: true,
    persona: null,
  };
  return {
    ...(await orig<typeof import("../../src/lib/whatsapp/accounts.js")>()),
    linkedWhatsappAccounts: vi.fn(async () => [account]),
    sendReadiness: vi.fn(async (accounts: unknown[]) => ({ connected: accounts, reconnecting: [], loggedOut: [] })),
  };
});
vi.mock("../../src/lib/whatsapp/phone-resolution.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/whatsapp/phone-resolution.js")>()),
  recordGhostPhone: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/matrix/human-takeover.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/human-takeover.js")>()),
  humanTypedTo: vi.fn(async () => (state.humanTyped ? { at: "2026-11-06T10:00:00Z" } : null)),
}));
vi.mock("../../src/lib/whatsapp/staff-alert.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/whatsapp/staff-alert.js")>()),
  alertRefusal: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/matrix/voice-notes.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/voice-notes.js")>()),
  downloadMedia: vi.fn(async (_c: unknown, mxc: string) => {
    calls.push(`download:${mxc}`);
    return Buffer.from("JPEGBYTES");
  }),
}));

const { sendWhatsApp, sendWhatsAppBubbles } = await import("../../src/lib/whatsapp/send.js");
const { clearTypingHolds } = await import("../../src/lib/whatsapp/typing.js");
const { default: whatsappRoutes } = await import("../../src/routes/whatsapp.js");
const { default: matrixRoutes } = await import("../../src/routes/matrix.js");

function req(key: string, replyToEventId: string | null) {
  return {
    orgId: ORG,
    brandId: BRAND,
    runId: "run-1",
    campaignId: null,
    idempotencyKey: key,
    text: "Monday works",
    email: null,
    phone: PHONE,
    fromAccount: null,
    skipIfReplied: false,
    userId: null,
    replyToEventId,
  };
}

async function event(id: string, sender: string, content: Record<string, unknown>, room = ROOM) {
  const at = Date.parse("2026-11-06T10:00:00Z");
  await db.insert(matrixRawEvents).values({
    orgId: ORG, brandId: BRAND, connectionId: CONNECTION, eventId: id, roomId: room, sender, eventType: "m.room.message",
    originServerTs: new Date(at), ingestedAt: new Date(), payload: { event_id: id, type: "m.room.message", sender, origin_server_ts: at, content },
  });
}

async function wipe() {
  await db.delete(whatsappSends).where(inArray(whatsappSends.orgId, [ORG]));
  await db.delete(matrixRawEvents).where(eq(matrixRawEvents.orgId, ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, ORG));
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(whatsappRoutes);
  a.use(matrixRoutes);
  return a;
}
const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": "user-1" };

describe.skipIf(!RUN)("SOPHIE-WA-HUMAN-1106 (DB)", () => {
  beforeEach(async () => {
    await wipe();
    calls.length = 0;
    state.humanTyped = false;
    clearTypingHolds();
    process.env.WHATSAPP_SEND_REFRESH = "off";
    await db.insert(matrixConnections).values({
      id: CONNECTION, orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: OWN, counterpartPrefix: "@whatsapp_", createdByUserId: "user-1", accessToken: "tok",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/runs")) {
        return new Response(JSON.stringify({ id: "run-s" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });
  });
  afterAll(async () => {
    clearTypingHolds();
    await wipe();
  });

  it("a send quotes a message of its room as a WhatsApp « Reply »", async () => {
    await event("$asked", GHOST, { msgtype: "m.text", body: "Monday or Tuesday?" });
    const res = await sendWhatsApp(req("q1", "$asked"));
    expect(calls).toContain("send:Monday works>$asked");
    expect(res.replyTo).toEqual({ eventId: "$asked", quoted: true, reason: null });
    // The same key again: nothing sent, the answer says why no quote now.
    const again = await sendWhatsApp(req("q1", "$asked"));
    expect(again.duplicate).toBe(true);
    expect(again.replyTo).toEqual({ eventId: "$asked", quoted: false, reason: "already_sent" });
  });

  it("a message of another room is not quoted: the text still goes out, the answer says so", async () => {
    await event("$elsewhere", GHOST, { msgtype: "m.text", body: "hi" }, "!other:hs");
    const res = await sendWhatsApp(req("q2", "$elsewhere"));
    expect(calls).toContain("send:Monday works");
    expect(res.replyTo).toEqual({ eventId: "$elsewhere", quoted: false, reason: "not_in_room" });
  });

  it("no quote asked = today's send, no `replyTo` in the answer", async () => {
    const res = await sendWhatsApp(req("q3", null));
    expect(calls).toContain("send:Monday works");
    expect(res.replyTo).toBeUndefined();
  });

  it("several bubbles: the first one quotes", async () => {
    await event("$asked2", GHOST, { msgtype: "m.text", body: "price?" });
    const res = await sendWhatsAppBubbles(req("q4", "$asked2"), ["$49 a month", "Want the link?"], { sleep: async () => undefined, random: () => 0 });
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:$49 a month>$asked2", "send:Want the link?"]);
    expect(res.replyTo).toEqual({ eventId: "$asked2", quoted: true, reason: null });
  });

  it("route: `replyToEventId` reaches the send", async () => {
    await event("$asked3", GHOST, { msgtype: "m.text", body: "ok?" });
    const res = await request(app()).post("/orgs/whatsapp/messages").set(headers).send({ brandId: BRAND, phone: PHONE, idempotencyKey: "q5", text: "yes", replyToEventId: "$asked3" });
    expect(res.status).toBe(200);
    expect(res.body.replyTo).toEqual({ eventId: "$asked3", quoted: true, reason: null });
    expect(calls).toContain("send:yes>$asked3");
  });

  it("typing: start shows it in the send's room, a send ends it; stop ends it at once; a refused person sees nothing", async () => {
    const start = await request(app()).post("/orgs/whatsapp/typing").set(headers).send({ brandId: BRAND, phone: PHONE, state: "start" });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ typing: true, fromAccount: "+77776879632", roomId: ROOM });
    expect(calls).toContain(`typing:${ROOM}:true`);

    // The answer goes out: the hold ends with it.
    calls.length = 0;
    await sendWhatsApp(req("t1", null));
    expect(calls).toEqual(["send:Monday works", `typing:${ROOM}:false`]);
    const afterSend = await request(app()).post("/orgs/whatsapp/typing").set(headers).send({ brandId: BRAND, phone: PHONE, state: "stop" });
    expect(afterSend.body).toMatchObject({ typing: false, wasTyping: false });

    // The AI decides not to write now.
    await request(app()).post("/orgs/whatsapp/typing").set(headers).send({ brandId: BRAND, phone: PHONE, state: "start" });
    calls.length = 0;
    const stop = await request(app()).post("/orgs/whatsapp/typing").set(headers).send({ brandId: BRAND, phone: PHONE, state: "stop" });
    expect(stop.body).toMatchObject({ typing: false, wasTyping: true });
    expect(calls).toEqual([`typing:${ROOM}:false`]);

    state.humanTyped = true;
    calls.length = 0;
    const refused = await request(app()).post("/orgs/whatsapp/typing").set(headers).send({ brandId: BRAND, phone: PHONE, state: "start" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("human_in_conversation");
    expect(calls).toEqual([]);

    const bad = await request(app()).post("/orgs/whatsapp/typing").set(headers).send({ brandId: BRAND, phone: PHONE, state: "maybe" });
    expect(bad.status).toBe(400);
  });

  it("media: a photo's bytes for the brand that received it; not a photo 422; another brand 404", async () => {
    await event("$photo", GHOST, {
      msgtype: "m.image", body: "image.jpg", filename: "image.jpg", url: "mxc://hs/abc", info: { mimetype: "image/jpeg", size: 9 },
    });
    await event("$words", GHOST, { msgtype: "m.text", body: "hello" });
    const ok = await request(app()).get(`/orgs/matrix/media?brandId=${BRAND}&eventId=${encodeURIComponent("$photo")}`).set(headers);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ eventId: "$photo", roomId: ROOM, direction: "inbound", mimeType: "image/jpeg", sizeBytes: 9, caption: null });
    expect(Buffer.from(ok.body.base64, "base64").toString()).toBe("JPEGBYTES");
    expect(calls).toContain("download:mxc://hs/abc");

    const words = await request(app()).get(`/orgs/matrix/media?brandId=${BRAND}&eventId=${encodeURIComponent("$words")}`).set(headers);
    expect(words.status).toBe(422);
    expect(words.body.code).toBe("not_an_image");
    const other = await request(app()).get(`/orgs/matrix/media?brandId=${OTHER_BRAND}&eventId=${encodeURIComponent("$photo")}`).set(headers);
    expect(other.status).toBe(404);
  });
});
