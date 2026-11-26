import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import copilotRoutes from "../../src/routes/copilot.js";
import peopleRoutes from "../../src/routes/people.js";
import { noLeadsByAddress } from "../helpers/lead-by-address.js";

/**
 * UNIBOX-TRANSLATE-1126: `GET /orgs/people/timeline?translate=en` against a real Postgres (gated on CRM_TEST_DB).
 * chat-service, runs-service and every sibling are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "7a7a7a7a-1111-4111-8111-000000000001";
const BRAND = "7a7a7a7a-1111-4111-8111-000000000002";
const CHAT_ORG = "7a7a7a7a-1111-4111-8111-000000000004";
const CHAT_USER = "7a7a7a7a-1111-4111-8111-000000000005";
const USER = "user-staff-translate";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const CLIENT = "kunde@translate-unibox.test";

process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.CHAT_SERVICE_URL = "http://chat.test";
process.env.CHAT_SERVICE_API_KEY = "test-chat-key";
process.env.CRM_TRANSLATION_CHAT_CONFIG = "zai/glm-flash";

const GERMAN = "Guten Tag\n\nWarum sind meine Kampagnen pausiert? Ich habe gestern Guthaben aufgeladen.\n\nFreundliche Grüsse";
const ENGLISH_ANSWER = "Your campaigns are paused because your credit ran out yesterday afternoon. Add credit and they restart at once.";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let chatCalls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let runCreates: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let chatFails = false;

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "lead.test" && url.pathname.endsWith("/leads/by-address")) return noLeadsByAddress(init);
    if (url.pathname === "/v1/runs" && init?.method === "POST") {
      runCreates.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return json({ id: "7a7a7a7a-1111-4111-8111-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0") });
    }
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "7a7a7a7a-1111-4111-8111-00000000beef" });
    }
    if (url.host === "chat.test" && url.pathname === "/complete") {
      const body = JSON.parse(String(init?.body));
      chatCalls.push({ headers: init?.headers as Record<string, string>, body });
      if (chatFails) return json({ error: "vendor down" }, 502);
      const asked = JSON.parse(body.message).messages[0];
      return json({
        content: "",
        json: {
          messages: [
            {
              id: asked.id,
              sourceLanguage: "de",
              alreadyInTarget: false,
              subject: asked.subject,
              text: "Good day\n\nWhy are my campaigns paused? I topped up my credit yesterday.\n\nKind regards",
            },
          ],
        },
        tokensInput: 500,
        tokensOutput: 40,
        model: "glm-5.3-flash",
      });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [] });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads/unibox") return json({ rows: [], nextCursor: null });
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

const timeline = (query = "") =>
  request(app())
    .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent(`email:${CLIENT}`)}${query}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", STAFF_ORG)
    .set("x-user-id", USER);

async function wipe() {
  await db.execute(sql`DELETE FROM message_translations WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM copilot_messages WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
}

async function clientIsAPerson() {
  const pushed = await request(app())
    .post("/internal/copilot/messages")
    .set("x-api-key", API_KEY)
    .send({
      orgId: CHAT_ORG,
      userId: CHAT_USER,
      email: CLIENT,
      sessionId: "s-translate",
      messages: [
        { messageId: "tr-m-1", role: "user", text: GERMAN, at: "2026-11-26T10:00:00Z" },
        { messageId: "tr-m-2", role: "assistant", text: ENGLISH_ANSWER, at: "2026-11-26T10:00:05Z" },
      ],
    });
  expect(pushed.status).toBe(200);
  const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
  expect((await runScopeBuild(scope)).ok).toBe(true);
}

describe.skipIf(!RUN)("Unibox thread in English (translate=en)", () => {
  beforeEach(async () => {
    installFetchStub();
    chatCalls = [];
    runCreates = [];
    chatFails = false;
    await wipe();
  });
  afterAll(wipe);

  it("translates the German message once, on the reader's org; the English one never reaches the model; a 2nd read asks nothing", async () => {
    await clientIsAPerson();
    const plain = await timeline();
    expect(plain.status).toBe(200);
    expect(plain.body.translation).toBeUndefined();
    expect(plain.body.items.every((i: Record<string, unknown>) => !("translation" in i))).toBe(true);
    expect(chatCalls).toHaveLength(0);

    const first = await timeline("&translate=en");
    expect(first.status).toBe(200);
    const byText = (body: { items: Record<string, any>[] }, text: string) => body.items.find((i) => i.text === text)!;
    const de = byText(first.body, GERMAN);
    expect(de.text).toBe(GERMAN); // the original stays
    expect(de.translation).toEqual({
      language: "en",
      status: "translated",
      sourceLanguage: "de",
      basis: "model",
      subject: null,
      text: "Good day\n\nWhy are my campaigns paused? I topped up my credit yesterday.\n\nKind regards",
    });
    expect(byText(first.body, ENGLISH_ANSWER).translation).toMatchObject({ status: "already_english", basis: "detector", text: ENGLISH_ANSWER });
    expect(first.body.translation).toEqual({
      language: "en", messages: 2, translated: 1, alreadyEnglish: 1, failed: 0, fromStore: 0, modelCalls: 1, model: "glm-5.3-flash",
    });

    // Exactly one model call: the German message, on the READER's org, on a people.translate child run.
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].body).toMatchObject({ provider: "zai", model: "glm-flash", responseFormat: "json" });
    expect(JSON.parse(chatCalls[0].body.message as string).messages[0].text).toBe(GERMAN);
    expect(chatCalls[0].headers["x-org-id"]).toBe(STAFF_ORG);
    expect(chatCalls[0].headers["x-user-id"]).toBe(USER);
    const translateRun = runCreates.find((r) => r.body.taskName === "people.translate")!;
    expect(translateRun.headers["x-org-id"]).toBe(STAFF_ORG);
    expect(translateRun.body.support).toMatchObject({ kind: "product_feature" });

    const second = await timeline("&translate=en");
    expect(chatCalls).toHaveLength(1);
    expect(byText(second.body, GERMAN).translation).toEqual(de.translation);
    expect(second.body.translation).toMatchObject({ fromStore: 1, modelCalls: 0, model: null });

    // A paged read translates only its page, from the store.
    const paged = await timeline("&limit=10&translate=en");
    expect(paged.status).toBe(200);
    expect(byText(paged.body, GERMAN).translation.status).toBe("translated");
    expect(chatCalls).toHaveLength(1);
  });

  it("chat-service down: the item says failed with the reason, nothing stored, the original still served", async () => {
    await clientIsAPerson();
    chatFails = true;
    const res = await timeline("&translate=en");
    expect(res.status).toBe(200);
    const de = res.body.items.find((i: Record<string, any>) => i.text === GERMAN);
    expect(de.translation).toMatchObject({ status: "failed", subject: null, text: null });
    expect(de.translation.error).toMatch(/502/);
    expect(res.body.translation).toMatchObject({ failed: 1, translated: 0 });
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM message_translations WHERE org_id = ${STAFF_ORG}`);
    expect((rows as unknown as { n: number }[])[0].n).toBe(0);
  });

  it("refuses an unknown language", async () => {
    const res = await timeline("&translate=xx");
    expect(res.status).toBe(400);
  });
});
