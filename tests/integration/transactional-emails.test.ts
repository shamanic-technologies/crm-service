import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { calendarFeedCursors, people, transactionalEmails } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { readLatestMessages } from "../../src/lib/people/latest-messages.js";
import type { PersonRelation } from "../../src/lib/people/relations.js";
import { transactionalItems } from "../../src/lib/people/timeline.js";
import { runTxEmailPass, TX_EMAIL_FEED, type FeedEmail } from "../../src/lib/transactional/sent-emails.js";
import copilotRoutes from "../../src/routes/copilot.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * TX-EMAIL-IN-UNIBOX-1024: transactional-email-service's sent-emails feed mirrored onto the staff Unibox
 * thread, against a real Postgres (gated on CRM_TEST_DB). The feed and every sibling are stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const STAFF_ORG = "7ec7ec7e-1111-4111-8111-000000000001";
const BRAND = "7ec7ec7e-1111-4111-8111-000000000002";
const CUSTOMER_ORG = "7ec7ec7e-1111-4111-8111-000000000003";
const CHAT_ORG = "7ec7ec7e-1111-4111-8111-000000000004";
const CHAT_USER = "7ec7ec7e-1111-4111-8111-000000000005";
const BILLED_ORG = "7ec7ec7e-1111-4111-8111-000000000006";
const USER = "user-staff-tx";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const CLIENT = "client@tx-unibox.test";

process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://tx.test";
process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "tx-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const email = (over: Partial<FeedEmail> & { id: string }): FeedEmail => ({
  eventType: "credit_exhausted",
  recipientEmail: "Client@TX-Unibox.test",
  orgId: BILLED_ORG,
  brandIds: null,
  from: "Kevin from distribute.you <kevin@distribute.you>",
  subject: "Your credit ran out",
  textBody: "Your campaigns are paused. Add credit to restart them.",
  htmlBody: "<p>Your campaigns are paused.</p>",
  sentAt: "2026-10-01T09:00:00.000Z",
  messageSource: "stored",
  ...over,
});

const E1 = email({ id: "7ec7ec7e-1111-4111-8111-0000000000e1" });
const E2 = email({
  id: "7ec7ec7e-1111-4111-8111-0000000000e2",
  eventType: "payment_receipt",
  subject: "Your receipt",
  textBody: null,
  htmlBody: "<html><head><style>p{color:red}</style></head><body><p>Thanks &amp; welcome!</p><p>Paid: $100</p></body></html>",
  sentAt: "2026-10-02T09:00:00.000Z",
  messageSource: "replayed",
});

/** The feed: `pages[cursor]` = what `after=cursor` answers; an unknown cursor answers empty, same cursor back. */
let pages: Record<string, { emails: FeedEmail[]; nextCursor: string | null }> = {};
const feedCalls: (string | null)[] = [];

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "tx.test" && url.pathname === "/internal/sent-emails") {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("tx-key");
      const after = url.searchParams.get("after");
      feedCalls.push(after);
      return json(pages[after ?? ""] ?? { emails: [], nextCursor: after });
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

const timeline = () =>
  request(app())
    .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent(`email:${CLIENT}`)}`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", STAFF_ORG)
    .set("x-user-id", USER);

async function wipe() {
  await db.execute(sql`DELETE FROM transactional_emails WHERE recipient_email LIKE '%@tx-unibox.test'`);
  await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, TX_EMAIL_FEED));
  await db.execute(sql`DELETE FROM copilot_messages WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_facts WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM lead_standing_observations WHERE brand_id = ${BRAND}`);
}

/** The client is a person of the staff scope (here through one Copilot message). */
async function clientIsAPerson() {
  const pushed = await request(app())
    .post("/internal/copilot/messages")
    .set("x-api-key", API_KEY)
    .send({
      orgId: CHAT_ORG,
      userId: CHAT_USER,
      email: CLIENT,
      sessionId: "s-tx",
      messages: [{ messageId: "tx-m-1", role: "user", text: "Why are my campaigns paused?", at: "2026-10-03T10:00:00Z" }],
    });
  expect(pushed.status).toBe(200);
  const { scope } = await ensureScope(STAFF_ORG, BRAND, USER);
  expect((await runScopeBuild(scope)).ok).toBe(true);
  return scope;
}

describe.skipIf(!RUN)("Transactional emails on the staff Unibox thread", () => {
  beforeEach(async () => {
    installFetchStub();
    feedCalls.length = 0;
    pages = {};
    await wipe();
  });
  afterAll(wipe);

  it("one feed email = exactly one outbound message on the thread; re-reading the same page records nothing twice", async () => {
    pages = { "": { emails: [E1, E2], nextCursor: "c1" } };
    const first = await runTxEmailPass(Date.parse("2026-10-24T12:00:00Z"));
    expect(first).toMatchObject({ read: 2, stored: 2, caughtUp: true, cursor: "c1" });
    expect(feedCalls).toEqual([null, "c1"]);

    // Next pass starts from the stored cursor: nothing new.
    const second = await runTxEmailPass(Date.parse("2026-10-24T12:01:00Z"));
    expect(second).toMatchObject({ read: 0, stored: 0, cursor: "c1" });

    // The same page served again (cursor moved back): no duplicate.
    await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, TX_EMAIL_FEED));
    const replay = await runTxEmailPass(Date.parse("2026-10-24T12:02:00Z"));
    expect(replay).toMatchObject({ read: 2, stored: 0 });
    const rows = await db.select().from(transactionalEmails).where(sql`recipient_email LIKE '%@tx-unibox.test'`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.recipientEmail === CLIENT)).toBe(true);

    const scope = await clientIsAPerson();
    const tl = await timeline();
    expect(tl.status).toBe(200);
    const tx = tl.body.items.filter((i: { source: string }) => i.source === "transactional");
    expect(tx.map((i: Record<string, unknown>) => [i.at, i.channel, i.kind, i.direction, i.from, i.to, i.subject, i.text])).toEqual([
      [
        "2026-10-01T09:00:00.000Z",
        "email",
        "message",
        "outbound",
        "Kevin from distribute.you <kevin@distribute.you>",
        [CLIENT],
        "Your credit ran out",
        "Your campaigns are paused. Add credit to restart them.",
      ],
      ["2026-10-02T09:00:00.000Z", "email", "message", "outbound", "Kevin from distribute.you <kevin@distribute.you>", [CLIENT], "Your receipt", "Thanks & welcome!\nPaid: $100"],
    ]);
    expect(tx[1].ref).toMatchObject({ emailId: E2.id, eventType: "payment_receipt", messageSource: "replayed", billedOrgId: BILLED_ORG });
    expect(tl.body.sources.find((s: { source: string }) => s.source === "transactional")).toMatchObject({ status: "ok", items: 2 });

    // The thread's latest message is the Copilot question (10-03), the receipt before it is not.
    const [person] = await db.select().from(people).where(eq(people.scopeId, scope.id));
    const relationKey = ((person.relations as PersonRelation[]) ?? [])[0]?.relationKey;
    expect(relationKey).toBeTruthy();
    const before = await readLatestMessages(STAFF_ORG, BRAND, [relationKey]);
    expect(before.relations[0].message).toMatchObject({ source: "copilot" });

    // A newer transactional email becomes the preview, from us, by a machine.
    pages = { c1: { emails: [email({ id: "7ec7ec7e-1111-4111-8111-0000000000e3", subject: "Budget changed", sentAt: "2026-10-04T08:00:00.000Z" })], nextCursor: "c2" } };
    expect(await runTxEmailPass(Date.parse("2026-10-24T12:03:00Z"))).toMatchObject({ stored: 1 });
    const after = await readLatestMessages(STAFF_ORG, BRAND, [relationKey]);
    expect(after.relations[0]).toMatchObject({
      status: "message",
      message: { source: "transactional", channel: "email", direction: "outbound", sentBy: "automation", subject: "Budget changed", textBasis: "original" },
    });
  }, 30_000);

  it("holds the cursor back over emails younger than the settle window (a late commit is re-read, never skipped)", async () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    pages = {
      "": { emails: [E1], nextCursor: "c1" },
      c1: { emails: [email({ id: "7ec7ec7e-1111-4111-8111-0000000000e4", sentAt: "2026-10-24T11:58:00.000Z" })], nextCursor: "c2" },
    };
    expect(await runTxEmailPass(now)).toMatchObject({ read: 2, stored: 2, cursor: "c1" });
    // Next pass re-reads from c1 (stored nothing twice).
    feedCalls.length = 0;
    expect(await runTxEmailPass(now + 60_000)).toMatchObject({ read: 1, stored: 0, cursor: "c1" });
    expect(feedCalls[0]).toBe("c1");
    // Settled 15 min later: the cursor moves on.
    expect(await runTxEmailPass(now + 20 * 60_000)).toMatchObject({ cursor: "c2" });
  }, 30_000);

  it("a customer org carrying the same brand id sees nothing; a malformed feed row fails the pass loud, storing nothing", async () => {
    pages = { "": { emails: [E1], nextCursor: "c1" } };
    await runTxEmailPass(Date.parse("2026-10-24T12:00:00Z"));
    expect(await transactionalItems({ orgId: CUSTOMER_ORG, brandId: BRAND, emails: [CLIENT] })).toMatchObject({ status: "not_connected", items: [] });
    expect((await transactionalItems({ orgId: STAFF_ORG, brandId: BRAND, emails: [CLIENT] })).items).toHaveLength(1);

    await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, TX_EMAIL_FEED));
    pages = { "": { emails: [{ ...E2, sentAt: "not a date" }], nextCursor: "c1" } };
    await expect(runTxEmailPass()).rejects.toThrow(/sentAt is not a date/);
    expect(await db.select().from(transactionalEmails).where(eq(transactionalEmails.id, E2.id))).toHaveLength(0);
  }, 30_000);
});
