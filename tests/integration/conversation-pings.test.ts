import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversationPings } from "../../src/db/schema.js";
import { storeCopilotTurn } from "../../src/lib/copilot/messages.js";
import { storeApiCalls, type ApiCallInput } from "../../src/lib/api-calls/calls.js";
import { announceApiCallStarts, announceCopilotStarts, type CopilotPushed } from "../../src/lib/conversation-pings.js";
import copilotRoutes from "../../src/routes/copilot.js";

/**
 * The owner's Telegram ping at each conversation START (Copilot, API, MCP),
 * against a real Postgres (gated on CRM_TEST_DB). Telegram, client-service,
 * brand-service and runs-service are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "c0c0c0c0-3333-4333-8333-000000000001";
const BRAND = "c0c0c0c0-3333-4333-8333-000000000002";
const CHAT_ORG = "c0c0c0c0-3333-4333-8333-000000000003";
const USER_JANE = "c0c0c0c0-3333-4333-8333-000000000004";
const USER_KEVIN = "c0c0c0c0-3333-4333-8333-000000000005";
const CALLED_BRAND = "c0c0c0c0-3333-4333-8333-000000000006";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

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
let telegramDown = false;

function installFetchStub() {
  sent = [];
  telegramDown = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.telegram.org") {
      if (telegramDown) return json({ ok: false, description: "Bad Gateway" }, 502);
      sent.push(JSON.parse(String(init!.body)).text);
      return json({ ok: true, result: { message_id: 1000 + sent.length } });
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
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${CALLED_BRAND}`) return json({ brand: { name: "AscendQE" } });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, 0) + minutes * 60_000).toISOString();

const turn = (over: Partial<CopilotPushed> & { messages: CopilotPushed["messages"] }): CopilotPushed => ({
  orgId: CHAT_ORG,
  userId: USER_JANE,
  email: "jane@prospect.io",
  displayName: null,
  sessionId: "sess-1",
  ...over,
});

/** What the route does: store, then announce (awaited here). */
async function chat(t: CopilotPushed) {
  const { newMessageIds } = await storeCopilotTurn(t, "run-1");
  await announceCopilotStarts(t, newMessageIds, "run-1");
}

const apiCall = (callId: string, minutes: number, over: Partial<ApiCallInput> = {}): ApiCallInput => ({
  callId,
  channel: "api",
  orgId: CHAT_ORG,
  userId: USER_JANE,
  email: "jane@prospect.io",
  displayName: null,
  brandIds: [CALLED_BRAND],
  method: "GET",
  path: "/v1/emails",
  status: 200,
  responseBody: JSON.stringify({ emails: [{}, {}, {}] }),
  responseBodyBytes: 40,
  durationMs: 120,
  at: at(minutes),
  ...over,
});

async function calls(batch: ApiCallInput[]) {
  const { newCallIds } = await storeApiCalls(batch, "run-1");
  await announceApiCallStarts(newCallIds, "run-1");
}

async function wipe() {
  await db.execute(sql`DELETE FROM copilot_messages WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM api_calls WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM person_ids WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM conversation_pings WHERE email IN ('jane@prospect.io', 'kevin@distribute.you', 'kev@outside.io')`);
}

describe.skipIf(!RUN)("owner Telegram ping at each conversation start", () => {
  beforeEach(async () => {
    installFetchStub();
    await wipe();
  });
  afterAll(wipe);

  it("Copilot: one ping when a conversation starts, none for the next messages, none on a retried push", async () => {
    await chat(
      turn({
        messages: [
          { messageId: "m-1", role: "user", text: "Can you find me 50 dentists in Lyon?", at: at(0) },
          { messageId: "m-2", role: "assistant", text: "Sure.", at: at(0.1) },
        ],
      }),
    );
    expect(sent).toHaveLength(1);
    const [personRow] = (await db.execute(sql`SELECT person_id FROM person_ids WHERE org_id = ${STAFF_ORG} AND identity_key = 'email:jane@prospect.io'`)) as unknown as { person_id: string }[];
    expect(sent[0]).toBe(
      [
        "New conversation on AI chat",
        "Who: Jane Doe (jane@prospect.io)",
        "Org: Prospect Inc",
        'First message: "Can you find me 50 dentists in Lyon?"',
        `Thread: https://dashboard.distribute.you/v2/orgs/org_staff/brands/${BRAND}/unibox?person=${personRow.person_id}`,
      ].join("\n"),
    );

    // A second message of the same conversation: no ping.
    await chat(turn({ messages: [{ messageId: "m-3", role: "user", text: "In Lyon only", at: at(2) }] }));
    // The same turn pushed again (chat-service retry): no ping.
    const replay = turn({ messages: [{ messageId: "m-1", role: "user", text: "Can you find me 50 dentists in Lyon?", at: at(0) }] });
    await chat(replay);
    // Even a replay that claims the message is new (a restart mid-announce) does not ping twice.
    await announceCopilotStarts(replay, ["m-1"], "run-1");
    expect(sent).toHaveLength(1);

    const [ping] = await db.select().from(conversationPings).where(eq(conversationPings.startRef, "m-1"));
    expect(ping).toMatchObject({ source: "copilot", channel: "chat", status: "sent", telegramMessageId: 1001 });
  }, 30_000);

  it("Copilot: a new session, or the same session after 30 minutes of silence, is a new conversation", async () => {
    await chat(turn({ messages: [{ messageId: "a-1", role: "user", text: "hi", at: at(0) }] }));
    await chat(turn({ sessionId: "sess-2", messages: [{ messageId: "b-1", role: "user", text: "another topic", at: at(5) }] }));
    await chat(turn({ messages: [{ messageId: "a-2", role: "user", text: "back again", at: at(45) }] }));
    expect(sent.map((t) => t.split("\n").find((l) => l.startsWith("First message")))).toEqual([
      'First message: "hi"',
      'First message: "another topic"',
      'First message: "back again"',
    ]);
  }, 30_000);

  it("staff never pings: a staff address, or a user id ever seen with one", async () => {
    await chat(turn({ userId: USER_KEVIN, email: "kevin@distribute.you", messages: [{ messageId: "k-1", role: "user", text: "test", at: at(0) }] }));
    // The same person under an outside address later: still him.
    await chat(turn({ userId: USER_KEVIN, email: "kev@outside.io", sessionId: "sess-k2", messages: [{ messageId: "k-2", role: "user", text: "test", at: at(60) }] }));
    await calls([apiCall("kc-1", 120, { userId: USER_KEVIN, email: "kev@outside.io" })]);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(conversationPings).where(eq(conversationPings.email, "kev@outside.io"))).toHaveLength(0);
  }, 30_000);

  it("API: one ping per burst, MCP is its own conversation, concurrent and out-of-order batches ping once", async () => {
    // Later calls of the burst arrive first, then two batches at once.
    await calls([apiCall("c-3", 10)]);
    await Promise.all([calls([apiCall("c-1", 0)]), calls([apiCall("c-2", 5)])]);
    const api = sent.filter((t) => t.startsWith("New conversation on API"));
    expect(api).toHaveLength(1);
    expect(api[0]).toContain("Who: Jane Doe (jane@prospect.io)");
    expect(api[0]).toContain("Org: Prospect Inc");
    expect(api[0]).toContain("Brand: AscendQE");
    expect(api[0]).toMatch(/First call: Listed emails for brand AscendQE\. Answered: 3 emails \(200, 120 ms\)/);

    await calls([apiCall("mcp-1", 11, { channel: "mcp", mcpTool: "distribute_list_emails" })]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^New conversation on MCP\n/);
    expect(sent[1]).toContain("First call: tool distribute_list_emails: Listed emails");

    // 30 minutes of silence on the API: a new conversation.
    await calls([apiCall("c-9", 50)]);
    expect(sent).toHaveLength(3);
  }, 30_000);

  it("a Telegram failure is recorded and logged, never thrown, never retried", async () => {
    telegramDown = true;
    await expect(chat(turn({ messages: [{ messageId: "f-1", role: "user", text: "hi", at: at(0) }] }))).resolves.toBeUndefined();
    const [ping] = await db.select().from(conversationPings).where(eq(conversationPings.startRef, "f-1"));
    expect(ping).toMatchObject({ status: "failed", telegramMessageId: null });
    expect(ping.error).toContain("502");
  }, 30_000);

  it("the push route answers before the ping and keeps its shape", async () => {
    const a = express();
    a.use(express.json());
    a.use(copilotRoutes);
    const res = await request(a)
      .post("/internal/copilot/messages")
      .set("x-api-key", API_KEY)
      .send(turn({ messages: [{ messageId: "r-1", role: "user", text: "hello", at: at(0) }] }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 1, duplicates: 0 });
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  }, 30_000);
});
