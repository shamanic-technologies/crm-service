import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { copilotMessages, people, peopleFacts, webChatHandoffs } from "../../src/db/schema.js";
import { emitScopeFacts } from "../../src/lib/people/facts.js";
import { afterNextScopeBuild, ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { runWebHandoffPass } from "../../src/lib/copilot/web-handoffs.js";
import copilotRoutes from "../../src/routes/copilot.js";
import peopleRoutes from "../../src/routes/people.js";
import { noLeadsByAddress } from "../helpers/lead-by-address.js";

/**
 * DISTRY-WEB-CHAT-EMAIL-1117: a visitor of our public site gives their email in the chat window; the page conversation
 * becomes part of their person's thread and ONE Lead event is reported. Real Postgres (gated on CRM_TEST_DB); siblings
 * stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "eb0eb0eb-1111-4111-8111-000000000001";
const BRAND = "eb0eb0eb-1111-4111-8111-000000000002";
const OFFER = "eb0eb0eb-1111-4111-8111-000000000003";
const USER = "user-staff-web";
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
process.env.BRAND_SERVICE_API_KEY = "br";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "ca";
process.env.HUMAN_SERVICE_URL = "http://human.test";
process.env.HUMAN_SERVICE_API_KEY = "h";
process.env.WEB_CHAT_HANDOFF_WATCH = "off";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let doorCalls: Record<string, unknown>[] = [];

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "lead.test" && url.pathname.endsWith("/leads/by-address")) return noLeadsByAddress(init);
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${BRAND}/offers`) {
      return json({ offers: [{ offerId: OFFER, name: "Revenue made easy", status: "active" }] });
    }
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${BRAND}`) return json({ brand: { domain: "distribute.you" } });
    if (url.host === "brand.test" && url.pathname === "/orgs/brands") return json({ brands: [] });
    if (url.host === "brand.test" && url.pathname.endsWith("/extracted-fields")) return json({ fields: [] });
    if (url.host === "brand.test" && url.pathname.endsWith("/user-fields")) return json({ fields: {} });
    if (url.host === "human.test" && url.pathname === `/internal/brands/${BRAND}/memberships/by-email`) {
      const body = JSON.parse(String(init?.body)) as { emails: string[] };
      return json({ brandId: BRAND, byEmail: Object.fromEntries(body.emails.map((e) => [e, null])) });
    }
    if (url.pathname === "/orgs/judgments") return json({}, 500);
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      doorCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ event: { id: `ev-${doorCalls.length}`, status: "fired" }, replayed: false });
    }
    // The org connected no Gmail mailbox (the brand's own addresses are its domain + sending mailboxes).
    if (url.host === "google.test" && url.pathname === "/orgs/google/accounts") return json({ accounts: [] });
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [], accounts: [] });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads/unibox") return json({ rows: [], nextCursor: null });
    if (url.host === "lead.test") return json({ leads: [] });
    if (url.host === "human.test") return json({}, 503);
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

const conversation = {
  conversationId: "webconv-1",
  visitorId: "visitor-abc",
  email: "Visitor@Prospect.io",
  displayName: "Vera Visitor",
  messages: [
    { messageId: "w-1", role: "user", text: "Can you book me sales meetings with dentists?", at: "2026-11-17T10:00:00Z" },
    { messageId: "w-2", role: "assistant", text: "Yes. What is your email so I can send you the details?", at: "2026-11-17T10:00:04Z" },
    { messageId: "w-3", role: "user", text: "visitor@prospect.io", at: "2026-11-17T10:00:30Z" },
  ],
};
const push = (body: unknown) => request(app()).post("/internal/copilot/web-conversations").set("x-api-key", API_KEY).send(body);

async function wipe() {
  await db.execute(sql`DELETE FROM copilot_messages WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM web_chat_handoffs WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
}

describe.skipIf(!RUN)("web chat hand-off: the page conversation joins the person's thread and fires one Lead event", () => {
  beforeEach(async () => {
    installFetchStub();
    doorCalls = [];
    await wipe();
  });
  afterAll(wipe);

  it("refuses when the staff scope has no people scope yet (nothing stored)", async () => {
    const res = await push(conversation);
    expect(res.status).toBe(503);
    expect(await db.select().from(copilotMessages).where(eq(copilotMessages.brandId, BRAND))).toHaveLength(0);
  });

  it("stores the conversation on the address, builds the person, states the facts, reports ONE message_received", async () => {
    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);

    const res = await push(conversation);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ stored: 3, duplicates: 0, duplicate: false, status: "pending" });

    const stored = await db.select().from(copilotMessages).where(eq(copilotMessages.brandId, BRAND));
    expect(stored.map((r) => [r.channel, r.email, r.visitorId, r.sessionId, r.chatOrgId])).toEqual([
      ["web", "visitor@prospect.io", "visitor-abc", "webconv-1", null],
      ["web", "visitor@prospect.io", "visitor-abc", "webconv-1", null],
      ["web", "visitor@prospect.io", "visitor-abc", "webconv-1", null],
    ]);

    // Not a person yet: the pass records why and waits for the build.
    const early = await runWebHandoffPass();
    expect(early).toMatchObject({ delivered: [{ status: "failed", reason: "person_not_built" }] });
    expect(doorCalls).toHaveLength(0);

    expect((await runScopeBuild(scope)).ok).toBe(true);
    const [vera] = await db.select().from(people).where(eq(people.scopeId, scope.id));
    expect(vera).toMatchObject({ personKey: "email:visitor@prospect.io", displayName: "Vera Visitor", sources: ["copilot"] });

    // The page conversation is on the person's thread, channel web.
    const tl = await request(app())
      .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:visitor@prospect.io")}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", STAFF_ORG)
      .set("x-user-id", USER);
    expect(tl.status).toBe(200);
    expect(tl.body.items.map((i: Record<string, unknown>) => [i.source, i.channel, i.direction, i.text])).toEqual([
      ["copilot", "web", "inbound", "Can you book me sales meetings with dentists?"],
      ["copilot", "web", "outbound", "Yes. What is your email so I can send you the details?"],
      ["copilot", "web", "inbound", "visitor@prospect.io"],
    ]);

    // On the fact feed, so lead-service knows the person.
    await emitScopeFacts(scope);
    const facts = await db
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.source, "copilot")));
    expect(facts.map((f) => [f.type, (f.payload as { channel: string }).channel, f.ownerPersonKey]).sort()).toEqual([
      ["message_in", "web", "email:visitor@prospect.io"],
      ["message_in", "web", "email:visitor@prospect.io"],
      ["message_out", "web", "email:visitor@prospect.io"],
    ]);

    // Retry after its backoff: the person is built now.
    const pass = await runWebHandoffPass(Date.now() + 5 * 60_000);
    expect(pass).toMatchObject({ delivered: [{ status: "reported", reason: null }] });
    expect(doorCalls).toHaveLength(1);
    const body = doorCalls[0] as { triggerId: string; offerId: string; idempotencyKey: string; person: Record<string, unknown>; item: Record<string, unknown> };
    expect(body.triggerId).toBe("message_received");
    expect(body.offerId).toBe(OFFER);
    expect(body.idempotencyKey).toMatch(/^crm:web_chat:webconv-1:[0-9a-f]{16}$/);
    expect(body.person).toEqual({ email: "visitor@prospect.io", name: "Vera Visitor" });
    expect(body.item).toMatchObject({ kind: "web_chat", channel: "web", conversationId: "webconv-1", visitorId: "visitor-abc", personId: vera.personId });
    expect((body.item.thread as { direction: string; text: string }[]).map((l) => l.direction)).toEqual(["inbound", "outbound", "inbound"]);
    expect((body.item.messages as { text: string }[]).map((m) => m.text)).toEqual(["visitor@prospect.io"]);

    const [h] = await db.select().from(webChatHandoffs).where(eq(webChatHandoffs.brandId, BRAND));
    expect(h).toMatchObject({ status: "reported", offerId: OFFER, campaignEventId: "ev-1" });

    // The same conversation handed over again with one more message: stored, no second Lead event.
    const again = await push({
      ...conversation,
      messages: [...conversation.messages, { messageId: "w-4", role: "assistant", text: "Thanks Vera, check your inbox.", at: "2026-11-17T10:00:35Z" }],
    });
    expect(again.body).toMatchObject({ stored: 1, duplicates: 3, duplicate: true, status: "reported", handoffId: h.id });
    expect(await runWebHandoffPass(Date.now() + 10 * 60_000)).toEqual({ skipped: "nothing_due" });
    expect(doorCalls).toHaveLength(1);
  }, 60_000);

  // DISTRY-WEB-CHAT-EMAIL-1117-PERSON (prod 2026-11-17): k.lourd+distryweb1118@distribute.you waited `person_not_built`
  // until its window closed: an address on the brand's own domain is never a person (withoutOwnAddresses).
  it("an address of the brand itself ends `skipped / own_address`, never waits for a build", async () => {
    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
    expect((await push({ ...conversation, conversationId: "webconv-own", email: "k.lourd+test@distribute.you" })).status).toBe(202);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    expect(await db.select().from(people).where(eq(people.scopeId, scope.id))).toHaveLength(0);

    const pass = await runWebHandoffPass();
    expect(pass).toMatchObject({ delivered: [{ status: "skipped", reason: "own_address" }] });
    const [h] = await db.select().from(webChatHandoffs).where(eq(webChatHandoffs.brandId, BRAND));
    expect(h).toMatchObject({ status: "skipped", reason: "own_address", attempts: 1 });
    expect(h.lastError).toContain("address of the brand itself");
    expect(doorCalls).toHaveLength(0);
    expect(await runWebHandoffPass(Date.now() + 60 * 60_000)).toEqual({ skipped: "nothing_due" });
  }, 60_000);

  // kevin.lourd+distryweb1118b@gmail.com took 7 min: the pass "after the build" ran the moment a build was QUEUED behind
  // the running one, found no person, then waited on backoff while the follow-up build made them one.
  it("a hand-off waiting for its person is reported by the pass that runs when the next build ENDS", async () => {
    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
    expect((await push(conversation)).status).toBe(202);
    expect(await runWebHandoffPass()).toMatchObject({ delivered: [{ status: "failed", reason: "person_not_built" }] });

    // A build already running: a waiter registered now fires only after the FOLLOW-UP build (the one that can hold it).
    const running = runScopeBuild(scope);
    let called = false;
    afterNextScopeBuild(scope.id, () => {
      called = true;
    });
    expect(await runScopeBuild(scope, { followUp: true })).toMatchObject({ skipped: true });
    await running;
    expect(called).toBe(false);
    await vi.waitFor(() => expect(called).toBe(true), { timeout: 30_000, interval: 50 });

    // Its backoff is not over, but it waited for exactly this build: the after-build pass delivers it now.
    expect(await runWebHandoffPass(Date.now())).toEqual({ skipped: "nothing_due" });
    expect(await runWebHandoffPass(Date.now(), { afterBuild: true })).toMatchObject({ delivered: [{ status: "reported", reason: null }] });
    expect(doorCalls).toHaveLength(1);
  }, 60_000);
});
