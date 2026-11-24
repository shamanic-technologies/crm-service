import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { apiCallPings } from "../../src/db/schema.js";
import { storeApiCalls, type ApiCallInput } from "../../src/lib/api-calls/calls.js";
import { apiCallPingPass } from "../../src/lib/api-calls/pings.js";
import { ApiCallsRequestSchema } from "../../src/schemas.js";

/**
 * TG-EVERY-CALL-1124: one owner Telegram line per external API / MCP call, grouped beyond the chat's budget, never
 * lost, never for staff. Real Postgres (gated on CRM_TEST_DB); Telegram, client-service, brand-service and
 * runs-service stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "a7a7a7a7-5555-4555-8555-000000000001";
const BRAND = "a7a7a7a7-5555-4555-8555-000000000002";
const CHAT_ORG = "a7a7a7a7-5555-4555-8555-000000000003";
const USER_JANE = "a7a7a7a7-5555-4555-8555-000000000004";
const USER_KEVIN = "a7a7a7a7-5555-4555-8555-000000000005";
const CALLED_BRAND = "a7a7a7a7-5555-4555-8555-000000000006";
const BUDGET = 6;

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

let base = Date.now();
const at = (seconds: number) => new Date(base + seconds * 1000);

const apiCall = (callId: string, seconds: number, over: Partial<ApiCallInput> = {}): ApiCallInput => ({
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
  at: at(seconds).toISOString(),
  ...over,
});

const pass = (seconds: number) => apiCallPingPass({ now: at(seconds), budget: BUDGET });
const pingsOf = (callId: string) => db.select().from(apiCallPings).where(eq(apiCallPings.callId, callId));

async function wipe() {
  await db.execute(sql`DELETE FROM api_calls WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM person_ids WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM api_call_pings`);
}

describe.skipIf(!RUN)("owner Telegram line for every external API / MCP call", () => {
  beforeEach(async () => {
    installFetchStub();
    await wipe();
    // Calls other suites left behind are history for this one.
    await db.execute(sql`UPDATE api_call_ping_watch SET since = now() WHERE id = 1`);
    base = Date.now() + 1000;
  });
  afterAll(wipe);

  it("a non-staff call: exactly one line naming who, what and the result", async () => {
    await storeApiCalls([apiCall("one-1", 0)], "run-1");
    await pass(1);
    await pass(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(
      [
        "API call · Jane Doe (jane@prospect.io) · Prospect Inc",
        "Did: Listed emails for brand AscendQE",
        "Result: ✅ Answered: 3 emails (200, 120 ms)",
        sent[0].split("\n")[3],
      ].join("\n"),
    );
    expect(sent[0].split("\n")[3]).toMatch(/^Thread: https:\/\/dashboard\.distribute\.you\/v2\/orgs\/org_staff\/brands\/.+\/unibox\?person=/);
    const [row] = await pingsOf("one-1");
    expect(row).toMatchObject({ status: "sent", mode: "line", telegramMessageId: 1001 });
  }, 30_000);

  it("an MCP call names the tool; an error names its status", async () => {
    await storeApiCalls(
      [apiCall("mcp-1", 0, { channel: "mcp", mcpTool: "distribute_list_emails", status: 403, responseBody: JSON.stringify({ error: "Not a member" }) })],
      "run-1",
    );
    await pass(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("MCP call · Jane Doe");
    expect(sent[0]).toContain("Did: tool distribute_list_emails · Listed emails");
    expect(sent[0]).toContain("Result: ❌ Refused (403): Not a member");
  }, 30_000);

  it("staff never pings: a staff address, kevin@pressbeat.io, a user id ever seen with one", async () => {
    await storeApiCalls(
      [
        apiCall("k-0", 0, { userId: USER_KEVIN, email: "kevin@distribute.you" }),
        apiCall("k-1", 1, { userId: "a7a7a7a7-5555-4555-8555-000000000007", email: "kevin@pressbeat.io" }),
        apiCall("k-2", 2, { userId: null, email: "kevin.lourd@gmail.com", path: "/v1/agent-signups/start", method: "POST" }),
      ],
      "run-1",
    );
    await pass(3);
    // The same person under an outside address later: still him.
    await storeApiCalls([apiCall("k-3", 4, { userId: USER_KEVIN, email: "kev@outside.io" })], "run-1");
    await pass(5);
    expect(sent).toHaveLength(0);
    for (const id of ["k-0", "k-1", "k-2", "k-3"]) expect((await pingsOf(id))[0]).toMatchObject({ status: "skipped", reason: "staff" });
  }, 30_000);

  it("50 calls in a minute from one person: grouped, all 50 accounted for, never more messages a minute than the budget", async () => {
    for (let i = 0; i < 50; i += 1) {
      await storeApiCalls([apiCall(`b-${String(i).padStart(2, "0")}`, i)], "run-1");
      await pass(i + 0.5);
    }
    // Within the first minute: at most the budget.
    expect(sent.length).toBeLessThanOrEqual(BUDGET);
    // The minute after: the rest arrives grouped.
    await pass(70);
    await pass(140);
    const rows = await db.select().from(apiCallPings);
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    const grouped = sent.filter((t) => /^\d+ API \/ MCP calls by 1 person/.test(t));
    expect(grouped.length).toBeGreaterThanOrEqual(1);
    const lines = sent.filter((t) => t.startsWith("API call · "));
    const listed = grouped.reduce((n, t) => n + Number(/^(\d+) API/.exec(t)![1]), 0);
    expect(lines.length + listed).toBe(50);
    // Every 60 s window holds at most BUDGET messages.
    const groups = new Map<string, number>();
    for (const r of rows) groups.set(r.messageGroup!, r.sentAt!.getTime());
    const times = [...groups.values()].sort((a, b) => a - b);
    for (const t of times) expect(times.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(BUDGET);
    expect(times.length).toBe(sent.length);
  }, 60_000);

  it("an agent signing up (email, no user yet) is accepted and pings", async () => {
    const parsed = ApiCallsRequestSchema.parse({
      calls: [
        {
          callId: "agent-1",
          channel: "api",
          orgId: null,
          email: "newbie@startup.io",
          method: "POST",
          path: "/v1/agent-signups/start",
          status: 200,
          durationMs: 80,
          at: at(0).toISOString(),
        },
      ],
    });
    const stored = await storeApiCalls(parsed.calls, "run-1");
    expect(stored.stored).toBe(1);
    await pass(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].split("\n").slice(0, 3)).toEqual([
      "API call · newbie@startup.io · no account yet",
      "Did: Agent signup: asked for a sign-in code by email",
      "Result: ✅ Answered (200, 80 ms)",
    ]);
  }, 30_000);

  it("a Telegram failure loses nothing: the call is sent on a later pass", async () => {
    telegramDown = true;
    await storeApiCalls([apiCall("f-1", 0)], "run-1");
    await expect(pass(1)).resolves.toBeDefined();
    expect((await pingsOf("f-1"))[0]).toMatchObject({ status: "pending", attempts: 1 });
    telegramDown = false;
    await pass(30);
    expect(sent).toHaveLength(1);
    expect((await pingsOf("f-1"))[0]).toMatchObject({ status: "sent" });
  }, 30_000);
});
