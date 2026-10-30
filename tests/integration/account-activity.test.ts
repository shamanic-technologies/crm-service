import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { accountActivities } from "../../src/db/schema.js";
import { processActivity } from "../../src/lib/account-activity/activity.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import accountActivityRoutes from "../../src/routes/account-activity.js";
import peopleRoutes from "../../src/routes/people.js";
import copilotRoutes from "../../src/routes/copilot.js";

/**
 * CLIENT-ACTIVITY-1030: a client's account actions reported by a producer, filed on their staff Unibox thread with
 * one owner Telegram each, against a real Postgres (gated on CRM_TEST_DB). Siblings, runs-service and Telegram are
 * stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "ac71a171-1030-4111-8111-000000000001";
const BRAND = "ac71a171-1030-4111-8111-000000000002";
const CLIENT_ORG = "ac71a171-1030-4111-8111-000000000003";
const CHAIM = "ac71a171-1030-4111-8111-000000000004";
const KEVIN = "ac71a171-1030-4111-8111-000000000005";
const CLIENT_BRAND = "ac71a171-1030-4111-8111-000000000006";
const STAFF_USER = "ac71a171-1030-4111-8111-000000000007";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "c";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "b";
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.TELEGRAM_BOT_TOKEN = "bot-token";
process.env.TELEGRAM_OWNER_CHAT_ID = "42";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sent: string[] = [];
let clientDown = false;

function installFetchStub() {
  sent = [];
  clientDown = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.telegram.org") {
      sent.push(JSON.parse(String(init!.body)).text);
      return json({ ok: true, result: { message_id: 2000 + sent.length } });
    }
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "client.test") {
      if (clientDown) return json({ error: "down" }, 503);
      if (url.pathname === `/internal/orgs/${STAFF_ORG}`) return json({ id: STAFF_ORG, externalId: "org_staff", name: "distribute.you" });
      if (url.pathname === `/internal/orgs/${CLIENT_ORG}`) return json({ id: CLIENT_ORG, externalId: "org_aba", name: "ABA Owners" });
      if (url.pathname === `/internal/users/${CHAIM}`) {
        return json({ user: { id: CHAIM, email: "Chaim@ABA-Owners.com", firstName: "Chaim", lastName: "Tesser" } });
      }
      if (url.pathname === `/internal/users/${KEVIN}`) {
        return json({ user: { id: KEVIN, email: "kevin@pressbeat.io", firstName: "Kevin", lastName: "Lourd" } });
      }
    }
    if (url.host === "brand.test" && url.pathname === `/internal/brands/${CLIENT_BRAND}`) return json({ brand: { name: "ABA" } });
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [] });
    if (url.host === "lead.test") return json({ leads: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(accountActivityRoutes);
  a.use(copilotRoutes);
  a.use(peopleRoutes);
  return a;
}

const recent = (minutesAgo = 1) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const created = (activityId: string, over: Record<string, unknown> = {}) => ({
  producer: "campaign-service",
  activityId,
  type: "campaign_created",
  title: "Campaign created",
  subject: { kind: "campaign", id: "camp-1", name: "ABA Owners Meetings" },
  via: "AI Copilot",
  brandId: CLIENT_BRAND,
  occurredAt: recent(),
  ...over,
});

const report = (body: unknown, user: string | null = CHAIM, org = CLIENT_ORG) => {
  const r = request(app()).post("/internal/account-activity").set("x-api-key", API_KEY).set("x-org-id", org);
  return user ? r.set("x-user-id", user).send(body as object) : r.send(body as object);
};

/** The route runs the filing after its answer: wait for the row to settle. */
async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const [row] = await db.select().from(accountActivities).where(eq(accountActivities.id, id));
    if (row.status !== "pending" && row.pingStatus !== "sending" && (row.status !== "filed" || row.pingStatus)) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`activity ${id} never settled`);
}

const timeline = (email: string) =>
  request(app())
    .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent(`email:${email}`)}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", STAFF_ORG)
    .set("x-user-id", STAFF_USER);

/** Chaim is a person of the staff Unibox (in prod: through the brand's Clerk, his Copilot chats...). */
async function seedChaim() {
  await request(app())
    .post("/internal/copilot/messages")
    .set("x-api-key", API_KEY)
    .send({
      orgId: CLIENT_ORG,
      userId: CHAIM,
      email: "chaim@aba-owners.com",
      sessionId: "s-1",
      messages: [{ messageId: "cm-1", role: "user", text: "Create my campaign please", at: recent(10) }],
    });
  const { scope } = await ensureScope(STAFF_ORG, BRAND, STAFF_USER);
  expect((await runScopeBuild(scope)).ok).toBe(true);
}

async function wipe() {
  await db.execute(sql`DELETE FROM account_activities WHERE account_org_id IN (${CLIENT_ORG}, ${STAFF_ORG})`);
  await db.execute(sql`DELETE FROM copilot_messages WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM person_ids WHERE org_id = ${STAFF_ORG}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
}

describe.skipIf(!RUN)("a client's account actions on the staff Unibox (CLIENT-ACTIVITY-1030)", () => {
  beforeEach(async () => {
    installFetchStub();
    await wipe();
    await ensureScope(STAFF_ORG, BRAND, STAFF_USER);
  });
  afterAll(wipe);

  it("created, edited, paused, resumed, budget changed: one line each on the actor's thread, one Telegram each", async () => {
    await seedChaim();
    sent = [];
    const bodies = [
      created("a-1", { occurredAt: recent(5) }),
      created("a-2", { type: "campaign_updated", title: "Campaign edited", occurredAt: recent(4) }),
      created("a-3", { type: "campaign_paused", title: "Campaign paused", occurredAt: recent(3) }),
      created("a-4", { type: "campaign_resumed", title: "Campaign resumed", occurredAt: recent(2) }),
      {
        producer: "billing-service",
        activityId: "b-1",
        type: "campaign_budget_changed",
        title: "Budget changed",
        subject: { kind: "campaign", id: "camp-1", name: "ABA Owners Meetings" },
        changes: [{ label: "Daily budget", before: "$20/day", after: "$50/day" }],
        brandId: CLIENT_BRAND,
        occurredAt: recent(1),
      },
    ];
    for (const b of bodies) {
      const r = await report(b);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ stored: true, duplicate: false });
      const row = await settled(r.body.id);
      expect(row).toMatchObject({ status: "filed", actorEmail: "chaim@aba-owners.com", actorName: "Chaim Tesser", pingStatus: "sent" });
    }

    const tl = await timeline("chaim@aba-owners.com");
    expect(tl.status).toBe(200);
    const items = tl.body.items.filter((i: { source: string }) => i.source === "activity");
    expect(items.map((i: { channel: string; kind: string; event: { step: string }; text: string }) => [i.channel, i.kind, i.event.step, i.text])).toEqual([
      ["account", "event", "campaign_created", 'Chaim Tesser · Campaign created: "ABA Owners Meetings"'],
      ["account", "event", "campaign_updated", 'Chaim Tesser · Campaign edited: "ABA Owners Meetings"'],
      ["account", "event", "campaign_paused", 'Chaim Tesser · Campaign paused: "ABA Owners Meetings"'],
      ["account", "event", "campaign_resumed", 'Chaim Tesser · Campaign resumed: "ABA Owners Meetings"'],
      ["account", "event", "campaign_budget_changed", 'Chaim Tesser · Budget changed: "ABA Owners Meetings" · Daily budget: $20/day to $50/day'],
    ]);
    expect(tl.body.sources.find((s: { source: string }) => s.source === "activity")).toMatchObject({ status: "ok", items: 5 });

    expect(sent).toHaveLength(5);
    expect(sent[0].split("\n")).toEqual([
      'Chaim Tesser · Campaign created: "ABA Owners Meetings"',
      "Who: Chaim Tesser (chaim@aba-owners.com)",
      "Org: ABA Owners",
      "Brand: ABA",
      "Via: AI Copilot",
      expect.stringMatching(/^Thread: https:\/\/dashboard\.distribute\.you\/v2\/orgs\/org_staff\/brands\/ac71a171-1030-4111-8111-000000000002\/unibox\?person=[0-9a-f-]{36}$/),
    ]);
    expect(sent[4]).toContain("Daily budget: $20/day to $50/day");
    for (const t of sent) expect(t).not.toMatch(/[—–]/);
  }, 30_000);

  it("the line sits in the same thread as the person's Copilot messages", async () => {
    await seedChaim();
    await settled((await report(created("a-1"))).body.id);
    const tl = await timeline("chaim@aba-owners.com");
    expect(tl.body.items.map((i: { source: string }) => i.source).filter((s: string) => s === "copilot" || s === "activity")).toEqual(["copilot", "activity"]);
  }, 30_000);

  it("the same fact reported twice: one line, one Telegram", async () => {
    await seedChaim();
    sent = [];
    const [a, b] = await Promise.all([report(created("dup-1")), report(created("dup-1"))]);
    expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
    expect(a.body.id).toBe(b.body.id);
    await settled(a.body.id);
    // A retry pass on the same row pings nothing more.
    await processActivity(a.body.id, "run-x");
    expect(sent).toHaveLength(1);
    const tl = await timeline("chaim@aba-owners.com");
    expect(tl.body.items.filter((i: { source: string }) => i.source === "activity")).toHaveLength(1);
  }, 30_000);

  it("staff and tests: no line, no Telegram (staff address, Kevin's test user, a user id ever staff, the staff org)", async () => {
    // Kevin's test user (kevin@pressbeat.io), resolved from client-service.
    const kevin = await settled((await report(created("s-1"), KEVIN)).body.id);
    expect(kevin).toMatchObject({ status: "skipped", reason: "staff" });
    // A staff address sent by the producer.
    const staffMail = await settled(
      (await request(app()).post("/internal/account-activity").set("x-api-key", API_KEY).set("x-org-id", CLIENT_ORG).set("x-user-id", STAFF_USER).set("x-email", "kevin@distribute.you").send(created("s-2"))).body.id,
    );
    expect(staffMail).toMatchObject({ status: "skipped", reason: "staff" });
    // Same user id later under an outside address: still him (seen with a staff address on the Copilot).
    await request(app())
      .post("/internal/copilot/messages")
      .set("x-api-key", API_KEY)
      .send({ orgId: CLIENT_ORG, userId: STAFF_USER, email: "kevin@distribute.you", sessionId: "s-k", messages: [{ messageId: "k-1", role: "user", text: "hi", at: recent(30) }] });
    const later = await settled(
      (await request(app()).post("/internal/account-activity").set("x-api-key", API_KEY).set("x-org-id", CLIENT_ORG).set("x-user-id", STAFF_USER).set("x-email", "kev@outside.io").send(created("s-3"))).body.id,
    );
    expect(later).toMatchObject({ status: "skipped", reason: "staff" });
    // An act inside the staff org itself.
    const staffOrg = await settled((await report(created("s-4"), CHAIM, STAFF_ORG)).body.id);
    expect(staffOrg).toMatchObject({ status: "skipped", reason: "staff_org" });
    // No user: nobody's line.
    const noUser = await settled((await report(created("s-5"), null)).body.id);
    expect(noUser).toMatchObject({ status: "skipped", reason: "no_actor" });

    expect(sent).toHaveLength(0);
    const filed = await db.select().from(accountActivities).where(eq(accountActivities.status, "filed"));
    expect(filed.filter((r) => r.accountOrgId === CLIENT_ORG || r.accountOrgId === STAFF_ORG)).toHaveLength(0);
  }, 30_000);

  it("client-service down: the reporter still gets its answer, the fact waits and is filed + pinged by the retry", async () => {
    clientDown = true;
    const r = await report(created("r-1"));
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    const [row] = await db.select().from(accountActivities).where(eq(accountActivities.id, r.body.id));
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(sent).toHaveLength(0);
    clientDown = false;
    expect(await processActivity(r.body.id, "run-retry")).toEqual({ status: "filed", ping: "sent" });
    expect(sent).toHaveLength(1);
  }, 30_000);

  it("never history: a fact older than 24 h is shown, never pinged", async () => {
    const row = await settled((await report(created("h-1", { occurredAt: recent(60 * 30) }))).body.id);
    expect(row).toMatchObject({ status: "filed", pingStatus: "skipped" });
    expect(sent).toHaveLength(0);
  }, 30_000);

  it("refuses a report with no client org", async () => {
    const r = await request(app()).post("/internal/account-activity").set("x-api-key", API_KEY).set("x-user-id", CHAIM).send(created("x-1"));
    expect(r.status).toBe(400);
  });
});
