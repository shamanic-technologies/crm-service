import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { apiCalls, people } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import apiCallsRoutes from "../../src/routes/api-calls.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * Calls to our API / MCP server as a source of the staff Unibox, against a real
 * Postgres (gated on CRM_TEST_DB). Siblings and runs-service are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "c0c0c0c0-2222-4222-8222-000000000001";
const BRAND = "c0c0c0c0-2222-4222-8222-000000000002";
const CUSTOMER_ORG = "c0c0c0c0-2222-4222-8222-000000000003";
const CALLER_ORG = "c0c0c0c0-2222-4222-8222-000000000004";
const CALLER_USER = "c0c0c0c0-2222-4222-8222-000000000005";
const CALLED_BRAND = "c0c0c0c0-2222-4222-8222-000000000006";
const USER = "user-staff-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "b";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [] });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads") return json({ leads: [] });
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${CALLED_BRAND}`) return json({ brand: { name: "AscendQE" } });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json({ limit: "16mb" }));
  a.use(apiCallsRoutes);
  a.use(peopleRoutes);
  return a;
}

const call = (over: Record<string, unknown> = {}) => ({
  callId: "call-1",
  channel: "api",
  mcpTool: null,
  orgId: CALLER_ORG,
  userId: CALLER_USER,
  email: "Jane@Prospect.io",
  displayName: "Jane Doe",
  keyFingerprint: "0123456789abcdef",
  brandIds: [CALLED_BRAND],
  method: "GET",
  path: "/v1/emails",
  query: { brandId: CALLED_BRAND },
  requestHeaders: { "user-agent": "claude-desktop" },
  requestBody: null,
  requestBodyBytes: 0,
  requestBodyTruncated: false,
  status: 200,
  responseContentType: "application/json; charset=utf-8",
  responseBody: JSON.stringify({ emails: [{ id: "e1" }, { id: "e2" }] }),
  responseBodyBytes: 34,
  responseBodyTruncated: false,
  durationMs: 120,
  at: "2026-10-12T10:00:00.000Z",
  requestId: "req-1",
  runId: "gw-run-1",
  ...over,
});
const push = (calls: unknown[]) => request(app()).post("/internal/api-calls").set("x-api-key", API_KEY).send({ calls });
const timeline = (org: string) =>
  request(app())
    .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:jane@prospect.io")}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("x-user-id", USER);
const detail = (org: string, callId: string) =>
  request(app()).get(`/orgs/people/api-calls/${callId}?brandId=${BRAND}`).set("x-api-key", API_KEY).set("x-org-id", org).set("x-user-id", USER);

async function wipe() {
  await db.execute(sql`DELETE FROM api_calls WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
}

describe.skipIf(!RUN)("API / MCP calls on the staff Unibox", () => {
  beforeEach(async () => {
    installFetchStub();
    await wipe();
  });
  afterAll(wipe);

  it("a call with no email (api-service could not resolve its user) is skipped and counted, never refusing its batch", async () => {
    // prod 2026-10-12: one such call made crm refuse the whole batch (400) and drop the good calls beside it.
    const mixed = await push([call({ callId: "call-null-email", email: null }), call({ callId: "call-next" })]);
    expect(mixed.status).toBe(200);
    expect(mixed.body).toEqual({ stored: 1, duplicates: 0, skippedNoEmail: 1 });
    expect((await db.select().from(apiCalls).where(eq(apiCalls.brandId, BRAND))).map((r) => r.callId)).toEqual(["call-next"]);
  }, 30_000);

  it("files calls under the staff scope only, shows ask + answer on the person's thread, never twice", async () => {
    const first = await push([
      call(),
      call({ callId: "call-2", channel: "mcp", mcpTool: "distribute_list_brands", brandIds: [], path: "/v1/brands", query: {}, responseBody: JSON.stringify({ brands: [{}] }), at: "2026-10-12T10:01:00.000Z" }),
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ stored: 2, duplicates: 0, skippedNoEmail: 0 });
    expect((await push([call()])).body).toEqual({ stored: 0, duplicates: 1, skippedNoEmail: 0 });

    const stored = await db.select().from(apiCalls).where(eq(apiCalls.brandId, BRAND));
    expect(stored.map((r) => [r.orgId, r.email, r.callerOrgId])).toEqual([
      [STAFF_ORG, "jane@prospect.io", CALLER_ORG],
      [STAFF_ORG, "jane@prospect.io", CALLER_ORG],
    ]);

    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    const [jane] = await db.select().from(people).where(eq(people.scopeId, scope.id));
    expect(jane).toMatchObject({ personKey: "email:jane@prospect.io", displayName: "Jane Doe", sources: ["api"] });

    const tl = await timeline(STAFF_ORG);
    expect(tl.status).toBe(200);
    expect(tl.body.items.map((i: Record<string, unknown>) => [i.source, i.channel, i.direction, i.from, i.to, i.text])).toEqual([
      ["api", "api", "inbound", "jane@prospect.io", ["distribute.you API"], "Listed emails for brand AscendQE"],
      ["api", "api", "outbound", "distribute.you API", ["jane@prospect.io"], "Answered: 2 emails (200, 120 ms)"],
      ["api", "mcp", "inbound", "jane@prospect.io", ["distribute.you API"], "Listed brands (MCP tool distribute_list_brands)"],
      ["api", "mcp", "outbound", "distribute.you API", ["jane@prospect.io"], "Answered: 1 brands (200, 120 ms)"],
    ]);
    expect(tl.body.items[0].ref).toMatchObject({ callId: "call-1", sessionId: "call-1", method: "GET", path: "/v1/emails", status: "200" });
    expect(tl.body.sources.find((s: { source: string }) => s.source === "api")).toMatchObject({ status: "ok", items: 4 });

    // A later call shows on the next open, before any rebuild, in the same session.
    await push([call({ callId: "call-3", at: "2026-10-12T10:10:00.000Z", status: 404, responseBody: JSON.stringify({ error: "Brand not found" }) })]);
    const later = await timeline(STAFF_ORG);
    expect(later.body.items.slice(-2).map((i: { text: string }) => i.text)).toEqual(["Listed emails for brand AscendQE", "Refused (404): Brand not found"]);
    expect(later.body.items.slice(-1)[0].ref.sessionId).toBe("call-1");

    const d = await detail(STAFF_ORG, "call-1");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      callId: "call-1",
      channel: "api",
      summary: { asked: "Listed emails for brand AscendQE", answered: "Answered: 2 emails (200, 120 ms)" },
      request: { method: "GET", path: "/v1/emails", query: { brandId: CALLED_BRAND }, headers: { "user-agent": "claude-desktop" }, body: null },
      response: { status: 200, body: JSON.stringify({ emails: [{ id: "e1" }, { id: "e2" }] }), bodyTruncated: false },
    });
  }, 30_000);

  it("a customer org carrying the same brand id sees nothing", async () => {
    await push([call({ callId: "call-9" })]);
    const { scope } = await ensureScope(CUSTOMER_ORG, BRAND, USER);
    const build = await runScopeBuild(scope);
    expect(build.ok).toBe(true);
    expect(build.summary!.sources.find((s) => s.source === "api")).toMatchObject({ status: "not_connected", presences: 0 });
    expect(await db.select().from(people).where(eq(people.scopeId, scope.id))).toHaveLength(0);
    expect((await timeline(CUSTOMER_ORG)).status).toBe(404);
    expect((await detail(CUSTOMER_ORG, "call-9")).status).toBe(404);
  }, 30_000);

  it("refuses a malformed batch", async () => {
    expect((await push([])).status).toBe(400);
    expect((await push([call({ channel: "fax" })])).status).toBe(400);
  });
});
