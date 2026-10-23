import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { whatsappSends } from "../../src/db/schema.js";

/**
 * WA-BUBBLES-1023: one send request delivers several short WhatsApp messages,
 * in order, paced, each its own send row, against a real database. The bridge,
 * the homeserver and the accounts are mocked at their module boundary.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "babababa-1111-4111-8111-000000000001";
const BRAND = "babababa-1111-4111-8111-000000000002";
const CAMPAIGN = "babababa-1111-4111-8111-0000000000c1";
const CONNECTION = "babababa-1111-4111-8111-0000000000d1";
const PHONE = "+33612345678";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const calls: string[] = [];
const state = { humanTyped: false, failSendAt: -1, sendCount: 0 };

vi.mock("../../src/lib/matrix/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/client.js")>()),
  joinRoom: vi.fn(async () => undefined),
  readRoomBridgeInfo: vi.fn(async () => []),
  setTyping: vi.fn(async (_t: string, _r: string, _u: string, typing: boolean) => {
    calls.push(`typing:${typing}`);
  }),
  sendText: vi.fn(async (_t: string, _room: string, txnId: string, text: string) => {
    state.sendCount += 1;
    if (state.sendCount === state.failSendAt) throw new Error("homeserver down");
    calls.push(`send:${text}`);
    return `$ev-${txnId}`;
  }),
}));
vi.mock("../../src/lib/matrix/bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/bridge.js")>()),
  resolveIdentifier: vi.fn(async () => {
    calls.push("resolve");
    return { id: "lid-1", mxid: "@whatsapp_lid-1:hs", dmRoomId: "!room:hs" };
  }),
  createDm: vi.fn(async () => ({ id: "lid-1", mxid: "@whatsapp_lid-1:hs", dmRoomId: "!room:hs" })),
}));
vi.mock("../../src/lib/whatsapp/room-check.js", () => ({
  expectedChannelIds: () => new Set<string>(),
  roomDeliversTo: () => ({ ok: true }),
}));
vi.mock("../../src/lib/whatsapp/accounts.js", async (orig) => {
  const account = {
    linkId: "link-1",
    connectionId: CONNECTION,
    matrixUserId: "@acct:hs",
    accessToken: "tok",
    loginId: "33700000001",
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
  humanTypedTo: vi.fn(async () => {
    calls.push("human-check");
    return state.humanTyped ? { at: "2026-10-22T10:00:00Z" } : null;
  }),
}));
vi.mock("../../src/lib/whatsapp/staff-alert.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/whatsapp/staff-alert.js")>()),
  alertRefusal: vi.fn(async () => undefined),
}));

const { sendWhatsAppBubbles, bubbleDelayMs, bubbleKey } = await import("../../src/lib/whatsapp/send.js");
const { default: whatsappRoutes } = await import("../../src/routes/whatsapp.js");

const sleeps: number[] = [];
const pacing = {
  sleep: async (ms: number) => {
    sleeps.push(ms);
    calls.push(`sleep:${ms}`);
  },
  random: () => 0.5,
};

function req(key: string, text = "hi") {
  return {
    orgId: ORG,
    brandId: BRAND,
    runId: "run-1",
    campaignId: CAMPAIGN,
    idempotencyKey: key,
    text,
    email: null,
    phone: PHONE,
    fromAccount: null,
    skipIfReplied: false,
    userId: null,
  };
}

async function rows() {
  return db.select().from(whatsappSends).where(and(eq(whatsappSends.orgId, ORG), eq(whatsappSends.brandId, BRAND)));
}

async function wipe() {
  await db.delete(whatsappSends).where(inArray(whatsappSends.orgId, [ORG]));
}

describe("bubble pacing (pure)", () => {
  it("pauses like someone typing: 2 s floor, 6 s ceiling, scaled to length, plus jitter", () => {
    expect(bubbleDelayMs("ok", () => 0)).toBe(2000);
    expect(bubbleDelayMs("x".repeat(50), () => 0)).toBe(3000);
    expect(bubbleDelayMs("x".repeat(500), () => 0)).toBe(6000);
    expect(bubbleDelayMs("x".repeat(500), () => 1)).toBe(6800);
  });
  it("keeps the caller's key for bubble 1", () => {
    expect(bubbleKey("k", 0)).toBe("k");
    expect(bubbleKey("k", 2)).toBe("k#bubble-3");
  });
});

describe.skipIf(!RUN)("multi-bubble WhatsApp send (DB)", () => {
  beforeEach(async () => {
    await wipe();
    calls.length = 0;
    sleeps.length = 0;
    state.humanTyped = false;
    state.failSendAt = -1;
    state.sendCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/runs")) {
        void init;
        return new Response(JSON.stringify({ id: "run-b" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });
  });
  afterAll(wipe);

  it("delivers N bubbles in order, checks decided once before bubble 1, typing + pause before each later one", async () => {
    const res = await sendWhatsAppBubbles(req("k1"), ["Hi Ann!", "Saw you visited our site.", "Want a quick tip?"], pacing);

    expect(calls).toEqual([
      "resolve",
      "human-check",
      "send:Hi Ann!",
      "typing:true",
      `sleep:${bubbleDelayMs("Saw you visited our site.", () => 0.5)}`,
      "send:Saw you visited our site.",
      "typing:true",
      `sleep:${bubbleDelayMs("Want a quick tip?", () => 0.5)}`,
      "send:Want a quick tip?",
    ]);
    expect(sleeps.every((ms) => ms >= 2000)).toBe(true);
    expect(res.status).toBe("sent");
    expect(res.duplicate).toBe(false);
    expect(res.messages.map((m) => [m.index, m.duplicate])).toEqual([[0, false], [1, false], [2, false]]);
    expect(res.sendId).toBe(res.messages[0].sendId);
    expect(res.eventId).toBe(res.messages[0].eventId);

    const stored = (await rows()).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(stored.map((r) => [r.idempotencyKey, r.status, r.text, r.campaignId, r.phone])).toEqual([
      ["k1", "sent", "Hi Ann!", CAMPAIGN, PHONE],
      ["k1#bubble-2", "sent", "Saw you visited our site.", CAMPAIGN, PHONE],
      ["k1#bubble-3", "sent", "Want a quick tip?", CAMPAIGN, PHONE],
    ]);
    expect(new Set(stored.map((r) => r.eventId)).size).toBe(3);
  });

  it("a refusal is decided once, before bubble 1, with today's code: nothing sent, no later row", async () => {
    state.humanTyped = true;
    await expect(sendWhatsAppBubbles(req("k2"), ["a", "b"], pacing)).rejects.toMatchObject({ code: "human_in_conversation" });
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual([]);
    const stored = await rows();
    expect(stored.map((r) => [r.idempotencyKey, r.status, r.errorCode])).toEqual([["k2", "refused", "human_in_conversation"]]);
    // A retry answers the same refusal.
    await expect(sendWhatsAppBubbles(req("k2"), ["a", "b"], pacing)).rejects.toMatchObject({ code: "human_in_conversation" });
  });

  it("a retry never re-sends a bubble already sent and finishes the rest, without re-checking", async () => {
    state.failSendAt = 2; // bubble 2 fails on the first call
    await expect(sendWhatsAppBubbles(req("k3"), ["one", "two", "three"], pacing)).rejects.toThrow("homeserver down");
    let stored = (await rows()).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(stored.map((r) => r.status)).toEqual(["sent", "failed", "failed"]);

    calls.length = 0;
    state.humanTyped = true; // would refuse a fresh send: a continuation must not ask again
    const res = await sendWhatsAppBubbles(req("k3"), ["one", "two", "three"], pacing);
    expect(calls.filter((c) => c.startsWith("send:") || c === "human-check" || c === "resolve")).toEqual(["send:two", "send:three"]);
    expect(res.duplicate).toBe(false);
    expect(res.messages.map((m) => m.duplicate)).toEqual([true, false, false]);

    stored = (await rows()).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    expect(stored.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);

    // A third call sends nothing at all.
    calls.length = 0;
    const again = await sendWhatsAppBubbles(req("k3"), ["one", "two", "three"], pacing);
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual([]);
    expect(again.duplicate).toBe(true);
    expect(again.messages.every((m) => m.duplicate)).toBe(true);
  });

  it("a concurrent call answers send_in_progress instead of racing the pacing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = { sleep: async () => gate, random: () => 0 };
    const first = sendWhatsAppBubbles(req("k4"), ["a", "b"], slow);
    await vi.waitFor(async () => expect((await rows()).find((r) => r.idempotencyKey === "k4")?.status).toBe("sent"));
    await expect(sendWhatsAppBubbles(req("k4"), ["a", "b"], pacing)).rejects.toMatchObject({ code: "send_in_progress" });
    release();
    await first;
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:a", "send:b"]);
  });

  it("route: `messages` answers every bubble; GET lists every bubble as a sent row; `text` keeps today's shape", async () => {
    process.env.WHATSAPP_SEND_REFRESH = "off";
    const app = express();
    app.use(express.json());
    app.use(whatsappRoutes);
    const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": "user-b-1", "x-campaign-id": CAMPAIGN };

    const one = await request(app).post("/orgs/whatsapp/messages").set(headers).send({ brandId: BRAND, phone: PHONE, idempotencyKey: "r1", text: "solo" });
    expect(one.status).toBe(200);
    expect(Object.keys(one.body).sort()).toEqual(
      ["sendId", "status", "duplicate", "to", "phoneSource", "fromAccount", "persona", "roomId", "eventId", "sentAt", "previousSends"].sort(),
    );

    const multi = await request(app)
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: PHONE, idempotencyKey: "r2", messages: ["just one bubble"] });
    expect(multi.status).toBe(200);
    expect(multi.body).toMatchObject({ status: "sent", duplicate: false, previousSends: 1 });
    expect(multi.body.messages).toHaveLength(1);

    const both = await request(app).post("/orgs/whatsapp/messages").set(headers).send({ brandId: BRAND, phone: PHONE, idempotencyKey: "r3", text: "x", messages: ["y"] });
    expect(both.status).toBe(400);
    const tooMany = await request(app)
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: PHONE, idempotencyKey: "r4", messages: ["1", "2", "3", "4", "5", "6"] });
    expect(tooMany.status).toBe(400);

    await sendWhatsAppBubbles(req("r5"), ["first", "second"], pacing);
    const list = await request(app).get(`/orgs/whatsapp/messages?brandId=${BRAND}&phone=${encodeURIComponent(PHONE)}`).set(headers);
    expect(list.status).toBe(200);
    const sent = list.body.sends.filter((s: { status: string }) => s.status === "sent");
    expect(sent.map((s: { text: string }) => s.text).sort()).toEqual(["first", "just one bubble", "second", "solo"]);
    expect(sent.every((s: { eventId: string | null; campaignId: string }) => !!s.eventId && s.campaignId === CAMPAIGN)).toBe(true);
  });
});
