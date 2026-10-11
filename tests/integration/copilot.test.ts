import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { copilotMessages, people } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import copilotRoutes from "../../src/routes/copilot.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * The Copilot's chat turns as a source of the staff Unibox, against a real
 * Postgres (gated on CRM_TEST_DB). Siblings and runs-service are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "c0c0c0c0-1111-4111-8111-000000000001";
const BRAND = "c0c0c0c0-1111-4111-8111-000000000002";
const CUSTOMER_ORG = "c0c0c0c0-1111-4111-8111-000000000003";
const CHAT_ORG = "c0c0c0c0-1111-4111-8111-000000000004";
const CHAT_USER = "c0c0c0c0-1111-4111-8111-000000000005";
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
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(copilotRoutes);
  a.use(peopleRoutes);
  return a;
}

const turn = (messages: { messageId: string; role: "user" | "assistant"; text: string; at: string }[]) => ({
  orgId: CHAT_ORG,
  userId: CHAT_USER,
  email: "Jane@Prospect.io",
  displayName: "Jane Doe",
  sessionId: "sess-1",
  messages,
});
const push = (body: unknown) => request(app()).post("/internal/copilot/messages").set("x-api-key", API_KEY).send(body);
const timeline = (org: string) =>
  request(app())
    .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:jane@prospect.io")}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("x-user-id", USER);

async function wipe() {
  await db.execute(sql`DELETE FROM copilot_messages WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
}

describe.skipIf(!RUN)("Copilot chat turns on the staff Unibox", () => {
  beforeEach(async () => {
    installFetchStub();
    await wipe();
  });
  afterAll(wipe);

  it("files a turn under the staff scope only, shows both directions on the person's thread, never twice", async () => {
    const first = await push(
      turn([
        { messageId: "m-1", role: "user", text: "How do I start a campaign?", at: "2026-10-11T10:00:00Z" },
        { messageId: "m-2", role: "assistant", text: "Tell me your budget and I set it up.", at: "2026-10-11T10:00:05Z" },
      ]),
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ stored: 2, duplicates: 0 });

    // The same turn again: nothing new.
    const again = await push(
      turn([
        { messageId: "m-1", role: "user", text: "How do I start a campaign?", at: "2026-10-11T10:00:00Z" },
        { messageId: "m-2", role: "assistant", text: "Tell me your budget and I set it up.", at: "2026-10-11T10:00:05Z" },
      ]),
    );
    expect(again.body).toEqual({ stored: 0, duplicates: 2 });

    const stored = await db.select().from(copilotMessages).where(eq(copilotMessages.brandId, BRAND));
    expect(stored.map((r) => [r.orgId, r.email])).toEqual([
      [STAFF_ORG, "jane@prospect.io"],
      [STAFF_ORG, "jane@prospect.io"],
    ]);

    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    const [jane] = await db.select().from(people).where(eq(people.scopeId, scope.id));
    expect(jane).toMatchObject({ personKey: "email:jane@prospect.io", displayName: "Jane Doe", sources: ["copilot"] });

    const tl = await timeline(STAFF_ORG);
    expect(tl.status).toBe(200);
    expect(tl.body.items.map((i: Record<string, unknown>) => [i.source, i.channel, i.direction, i.from, i.to, i.text])).toEqual([
      ["copilot", "chat", "inbound", "jane@prospect.io", ["AI Copilot"], "How do I start a campaign?"],
      ["copilot", "chat", "outbound", "AI Copilot", ["jane@prospect.io"], "Tell me your budget and I set it up."],
    ]);
    expect(tl.body.sources.find((s: { source: string }) => s.source === "copilot")).toMatchObject({ status: "ok", items: 2 });

    // A later turn shows on the next open, before any rebuild.
    await push(turn([{ messageId: "m-3", role: "user", text: "Thanks!", at: "2026-10-11T10:01:00Z" }]));
    const later = await timeline(STAFF_ORG);
    expect(later.body.items.map((i: { text: string }) => i.text)).toEqual([
      "How do I start a campaign?",
      "Tell me your budget and I set it up.",
      "Thanks!",
    ]);
  }, 30_000);

  it("a customer org carrying the same brand id sees nothing", async () => {
    await push(turn([{ messageId: "m-9", role: "user", text: "private", at: "2026-10-11T10:00:00Z" }]));
    const { scope } = await ensureScope(CUSTOMER_ORG, BRAND, USER);
    const build = await runScopeBuild(scope);
    expect(build.ok).toBe(true);
    expect(build.summary!.sources.find((s) => s.source === "copilot")).toMatchObject({ status: "not_connected", presences: 0 });
    expect(await db.select().from(people).where(eq(people.scopeId, scope.id))).toHaveLength(0);
    const tl = await timeline(CUSTOMER_ORG);
    expect(tl.status).toBe(404);
  }, 30_000);
});
