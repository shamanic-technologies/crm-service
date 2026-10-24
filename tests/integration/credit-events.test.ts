import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { billingFeedCursors, creditEventReports, creditEvents, people, peopleFacts } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { CREDIT_FEED, runCreditWatchPass } from "../../src/lib/credit-events/feed.js";
import copilotRoutes from "../../src/routes/copilot.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * billing-service's credit events on the staff Unibox (CREDIT-RAN-OUT-UNIBOX-EVENT-1024), against a real Postgres
 * (gated on CRM_TEST_DB). billing / client / brand / campaign / runs services are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "c3ed1700-1111-4111-8111-000000000001";
const BRAND = "c3ed1700-1111-4111-8111-000000000002";
const CUSTOMER_ORG = "c3ed1700-1111-4111-8111-000000000003";
const CLIENT_ORG = "c3ed1700-1111-4111-8111-000000000004";
const EPISODE = "c3ed1700-1111-4111-8111-000000000005";
const OLD_EPISODE = "c3ed1700-1111-4111-8111-000000000006";
const OFFER = "c3ed1700-1111-4111-8111-000000000007";
const USER = "user-staff-credit";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.BILLING_SERVICE_URL = "http://billing.test";
process.env.BILLING_SERVICE_API_KEY = "b";
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "c";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "br";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "ca";
process.env.CREDIT_WATCH_REBUILD = "off";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let feed: unknown[] = [];
let doorCalls: Record<string, unknown>[] = [];

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "billing.test" && url.pathname === "/internal/credit-events") {
      // The cursor names the last event served: a re-read after it answers nothing new.
      const after = url.searchParams.get("cursor");
      const events = after ? feed.slice(Number(after)) : feed;
      return json({ events, nextCursor: feed.length ? String(feed.length) : after, hasMore: false });
    }
    if (url.host === "client.test" && url.pathname === "/internal/users") {
      expect(url.searchParams.get("orgId")).toBe(CLIENT_ORG);
      return json({ users: [{ email: "Jane@Prospect.io", phone: null }, { email: "kevin@distribute.you", phone: null }] });
    }
    if (url.host === "client.test" && url.pathname === `/internal/orgs/${CLIENT_ORG}`) return json({ externalId: "org_x", name: "Acme" });
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${BRAND}/offers`) {
      return json({ offers: [{ offerId: OFFER, name: "Product-led", status: "active" }] });
    }
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${BRAND}`) return json({ brand: { domain: "distribute.you" } });
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      doorCalls.push(body);
      return json({ event: { id: `ev-${doorCalls.length}`, status: "fired" }, replayed: false });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [], accounts: [] });
    if (url.host === "lead.test") return json({ leads: [] });
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

const timeline = (org: string) =>
  request(app())
    .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:jane@prospect.io")}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", org)
    .set("x-user-id", USER);

/** Jane, a member of the client org, is a person of the staff Unibox (she chatted with the Copilot). */
const seedJane = () =>
  request(app())
    .post("/internal/copilot/messages")
    .set("x-api-key", API_KEY)
    .send({
      orgId: CLIENT_ORG,
      userId: "c3ed1700-1111-4111-8111-000000000009",
      email: "Jane@Prospect.io",
      displayName: "Jane Doe",
      sessionId: "s-1",
      messages: [{ messageId: "credit-m-1", role: "user", text: "hi", at: "2026-10-20T10:00:00Z" }],
    });

async function wipe() {
  await db.execute(sql`TRUNCATE credit_events, credit_event_reports, billing_feed_cursors`);
  await db.execute(sql`DELETE FROM copilot_messages WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
}

const ranOut = (episode: string, at: string) => ({ eventId: `${episode}:ran_out`, type: "credit_ran_out", orgId: CLIENT_ORG, episodeId: episode, at });
const restored = (episode: string, at: string) => ({ eventId: `${episode}:restored`, type: "credit_restored", orgId: CLIENT_ORG, episodeId: episode, at });

describe.skipIf(!RUN)("credit events on the staff Unibox", () => {
  beforeEach(async () => {
    installFetchStub();
    feed = [];
    doorCalls = [];
    await wipe();
  });
  afterAll(wipe);

  it("ran out then restored: ONE event each on the member's thread, a fact each, a Lead event each; a re-read adds nothing", async () => {
    await seedJane();
    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    // The watch started before both events.
    await db.insert(billingFeedCursors).values({ feed: CREDIT_FEED, watchSince: new Date("2026-10-24T11:00:00Z") });
    const now = Date.parse("2026-10-24T13:00:00Z");

    feed = [ranOut(EPISODE, "2026-10-24T12:00:00.000Z")];
    const first = await runCreditWatchPass(now);
    expect(first).toMatchObject({ feed: { stored: 1 }, people: { resolved: 1, reports: 1 } });
    const [stored] = await db.select().from(creditEvents);
    // Staff is nobody: only Jane.
    expect(stored).toMatchObject({ memberEmails: ["jane@prospect.io"], orgLabel: "Acme" });

    feed = [...feed, restored(EPISODE, "2026-10-24T12:30:00.000Z")];
    const second = await runCreditWatchPass(now);
    expect(second).toMatchObject({ feed: { stored: 1 }, people: { resolved: 1 } });

    // Lead event: the GENERIC account_event trigger, once per event.
    expect(doorCalls.map((b) => [b.triggerId, b.offerId, (b.person as { email: string }).email, (b.item as { kind: string }).kind])).toEqual([
      ["account_event", OFFER, "jane@prospect.io", "credit_ran_out"],
      ["account_event", OFFER, "jane@prospect.io", "credit_restored"],
    ]);
    const reports = await db.select().from(creditEventReports);
    expect(reports.map((r) => r.status).sort()).toEqual(["reported", "reported"]);

    // Re-reading the whole feed from the start stores and reports nothing more.
    await db.update(billingFeedCursors).set({ cursor: null }).where(eq(billingFeedCursors.feed, CREDIT_FEED));
    const third = await runCreditWatchPass(now);
    expect(third).toMatchObject({ feed: { read: 2, stored: 0 }, people: { resolved: 0 } });
    expect(doorCalls).toHaveLength(2);

    // The thread.
    const tl = await timeline(STAFF_ORG);
    expect(tl.status).toBe(200);
    const billing = tl.body.items.filter((i: { source: string }) => i.source === "billing");
    expect(billing.map((i: Record<string, unknown>) => [i.kind, i.channel, i.text, i.at])).toEqual([
      ["event", "account", "Credit ran out · Acme", "2026-10-24T12:00:00.000Z"],
      ["event", "account", "Credit restored · Acme", "2026-10-24T12:30:00.000Z"],
    ]);

    // The facts, once each, never again on a rebuild.
    expect((await runScopeBuild(scope)).ok).toBe(true);
    const facts = async () =>
      db
        .select()
        .from(peopleFacts)
        .where(and(eq(peopleFacts.brandId, BRAND), eq(peopleFacts.source, "billing")));
    const f1 = await facts();
    expect(f1.map((f) => [f.type, f.personKey, f.sourceRef, f.dateBasis]).sort()).toEqual([
      ["credit_ran_out", "email:jane@prospect.io", `${EPISODE}:ran_out`, "credit_ran_out_at"],
      ["credit_restored", "email:jane@prospect.io", `${EPISODE}:restored`, "credit_restored_at"],
    ]);
    expect((await runScopeBuild(scope)).ok).toBe(true);
    expect(await facts()).toHaveLength(2);
  }, 60_000);

  it("history (before the first pass): shown and stated, never reported", async () => {
    await seedJane();
    const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
    await runScopeBuild(scope);
    feed = [ranOut(OLD_EPISODE, "2026-10-18T09:00:00.000Z")];
    const r = await runCreditWatchPass(Date.parse("2026-10-24T13:00:00Z"));
    expect(r).toMatchObject({ feed: { stored: 1 }, people: { resolved: 1, reports: 1 } });
    expect(doorCalls).toHaveLength(0);
    const [report] = await db.select().from(creditEventReports);
    expect(report).toMatchObject({ status: "skipped", reason: "before_watch" });
    const tl = await timeline(STAFF_ORG);
    expect(tl.body.items.filter((i: { source: string }) => i.source === "billing").map((i: { text: string }) => i.text)).toEqual(["Credit ran out · Acme"]);
  }, 60_000);

  it("a customer org carrying the same brand id sees nothing", async () => {
    feed = [ranOut(EPISODE, "2026-10-24T12:00:00.000Z")];
    await seedJane();
    const { scope: staff } = await ensureScope(STAFF_ORG, BRAND, USER);
    await runScopeBuild(staff);
    await runCreditWatchPass(Date.parse("2026-10-24T13:00:00Z"));
    const { scope } = await ensureScope(CUSTOMER_ORG, BRAND, USER);
    const build = await runScopeBuild(scope);
    expect(build.summary!.sources.find((s) => s.source === "billing")).toMatchObject({ status: "not_connected" });
    expect(await db.select().from(people).where(eq(people.scopeId, scope.id))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(peopleFacts)
        .where(and(eq(peopleFacts.orgId, CUSTOMER_ORG), eq(peopleFacts.source, "billing"))),
    ).toHaveLength(0);
  }, 60_000);
});
