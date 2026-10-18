import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversationPings } from "../../src/db/schema.js";
import { storeApiCalls, type ApiCallInput } from "../../src/lib/api-calls/calls.js";
import { announceApiCallStarts } from "../../src/lib/conversation-pings.js";

/**
 * The owner's Telegram ping at each conversation START (API, MCP; the Copilot is
 * pinged per message, tests/integration/assistant-pings.test.ts),
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

  it("staff never pings: a staff address, or a user id ever seen with one", async () => {
    await calls([apiCall("kc-0", 0, { userId: USER_KEVIN, email: "kevin@distribute.you" })]);
    // The same person under an outside address later: still him.
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
    await expect(calls([apiCall("f-1", 0)])).resolves.toBeUndefined();
    const [ping] = await db.select().from(conversationPings).where(eq(conversationPings.startRef, "f-1"));
    expect(ping).toMatchObject({ status: "failed", telegramMessageId: null });
    expect(ping.error).toContain("502");
  }, 30_000);
});
