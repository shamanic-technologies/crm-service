/**
 * POSTHOG-429-1107: PostHog refused every read for 5 days (distribute.you, project 171095) because our own reads spent
 * the project's hourly read budget, and every retry spent more. Pinned here:
 *  - a 429 leaves the connection active (never error, never paused), records when PostHog said reads come back, and
 *    NO PostHog call happens before then: full pass, fast mirror, phone watch, after a restart too (stored state);
 *  - the client sees "catching up, next read at <time>", distinct from a failure;
 *  - every read is bounded: no activity read filters on the persons table, persons are re-listed every 6 h only;
 *  - the history backlog (persons mirrored while PostHog refused) is read paced by the bytes PostHog reports, never
 *    a second burst.
 * PostHog is stubbed at `fetch`, with its real 429 body and headers (captured 2026-11-07).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { posthogConnections, posthogRawRecords } from "../../src/db/schema.js";
import { resetPosthogBudgetState } from "../../src/lib/posthog/client.js";
import { mirrorRecentPersons, POSTHOG_BACKFILL_HOURLY_BYTES, runPosthogSyncPass } from "../../src/lib/posthog/sync.js";
import { runPhoneWatchPass } from "../../src/lib/phone-trigger/watch.js";
import posthogStripeRoutes from "../../src/routes/posthog-stripe.js";

const RUN = process.env.CRM_TEST_DB === "1";
const API_KEY = process.env.CRM_SERVICE_API_KEY!;
const ORG = "9a9a9a9a-1111-4111-8111-000000000001";
const BRAND = "9a9a9a9a-1111-4111-8111-000000000002";
const USER = "user-ph-budget";

process.env.PHONE_TRIGGER_REFRESH = "off";
process.env.KEY_SERVICE_URL = "http://keys.test";
process.env.KEY_SERVICE_API_KEY = "k";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** PostHog's own 429, verbatim (2026-11-07, eu.posthog.com). */
const REFUSAL = {
  type: "throttled_error",
  code: "api_queries_budget_exceeded",
  detail:
    "This project used its hourly budget of data read by API queries. To stay under it, read less data per query or run queries less often. See https://posthog.com/docs/sql/optimizing-queries for ways to read less. Expected available in 300 seconds.",
  attr: null,
};

let refuse = false;
/** When set, the events window answers one full page then refuses the next one. */
let eventsPageThenRefuse: Record<string, unknown>[] | null = null;
/** Bytes PostHog reports for every read (`X-PostHog-Query-Bytes-Read`). */
let bytesPerRead = 1000;
let hogql: string[] = [];
let runsOpened = 0;
const PERSON = {
  id: "ph-known",
  email: "known@acme.io",
  name: "Known Person",
  first_name: null,
  last_name: null,
  created_at: "2026-11-06T09:00:00Z",
  is_identified: 1,
  distinct_ids: ["did-known"],
};

function installFetchStub() {
  hogql = [];
  runsOpened = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      if ((init?.method ?? "GET") === "POST" && /\/v1\/runs\/?$/.test(url.pathname)) runsOpened++;
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "keys.test") return json({ key: "phx_good", provider: "posthog", keySource: "org" });
    if (url.host === "eu.posthog.com") {
      const q = (JSON.parse(String(init?.body)) as { query: { query: string } }).query.query;
      hogql.push(q);
      if (refuse) return json(REFUSAL, 429, { "retry-after": "300" });
      const headers = { "x-posthog-query-bytes-read": String(bytesPerRead), "x-posthog-query-budget-remaining-bytes": "1" };
      const rows = (cols: string[], data: Record<string, unknown>[]) =>
        json({ columns: cols, results: data.map((d) => cols.map((c) => d[c] ?? null)) }, 200, headers);
      if (q.includes("SELECT DISTINCT toString(person_id) AS id")) return rows(["id"], [{ id: PERSON.id }]);
      if (q.includes("FROM persons AS p")) return rows(Object.keys(PERSON), q.includes("toString(p.id) >") ? [] : [PERSON]);
      if (q.includes("FROM person_distinct_ids") && q.includes("groupArray")) {
        const ids = [...q.matchAll(/'(ph-[a-z0-9-]+)'/g)].map((m) => m[1]);
        return rows(["person_id", "ids"], [...new Set(ids)].map((id) => ({ person_id: id, ids: [`did-${id}`] })));
      }
      if (q.includes("FROM person_distinct_ids")) return rows(["person_id"], []);
      if (q.includes("event = '$pageview'")) return rows(["session_id"], []);
      if (q.includes("NOT LIKE '$%'") && eventsPageThenRefuse) {
        if (q.includes("(timestamp, toString(uuid)) >")) return json(REFUSAL, 429, { "retry-after": "300" });
        return rows(["id", "event", "timestamp", "person_id"], eventsPageThenRefuse);
      }
      if (q.includes("NOT LIKE '$%'")) return rows(["id"], []);
      throw new Error(`unexpected HogQL ${q}`);
    }
    if (url.host === "campaign.test") return json({ events: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(posthogStripeRoutes);
  return a;
}

async function wipe() {
  await db.execute(sql`DELETE FROM posthog_activities WHERE brand_id = ${BRAND}`);
  await db.execute(sql`DELETE FROM contacts WHERE brand_id = ${BRAND}`);
  // Every PostHog connection: these tests assert that NO PostHog read happens fleet-wide while one waits, so a
  // connection another suite left in the shared database must not read either (suites run serially).
  await db.execute(sql`DELETE FROM posthog_connections`);
}

async function connection(values: Partial<typeof posthogConnections.$inferInsert> = {}) {
  const [conn] = await db
    .insert(posthogConnections)
    .values({
      orgId: ORG,
      brandId: BRAND,
      projectId: "171095",
      region: "eu",
      status: "active",
      createdByUserId: USER,
      lastSyncedAt: new Date(Date.now() - 10 * 60_000),
      syncedThrough: new Date(Date.now() - 10 * 60_000),
      personsListedAt: new Date(Date.now() - 10 * 60_000),
      ...values,
    })
    .returning();
  return conn;
}

const row = async (id: string) => (await db.select().from(posthogConnections).where(eq(posthogConnections.id, id)))[0];

describe.skipIf(!RUN)("PostHog read budget (POSTHOG-429-1107)", () => {
  beforeEach(async () => {
    refuse = false;
    eventsPageThenRefuse = null;
    bytesPerRead = 1000;
    resetPosthogBudgetState();
    installFetchStub();
    await wipe();
  });
  afterAll(async () => {
    await wipe();
  });

  it("a 429 is a wait: the connection stays active, records when reads come back, and nothing reads PostHog before then", async () => {
    // Prod on 2026-11-07: the connection had been flipped to error by the same refusal.
    const conn = await connection({ status: "error", lastError: "PostHog query returned 429: old refusal" });
    refuse = true;
    const t0 = Date.now();
    const first = await runPosthogSyncPass(conn.id);
    expect(first.failures).toEqual([]);
    // The first refusal stopped every read of the pass: one call, not one per step.
    expect(hogql).toHaveLength(1);
    const waiting = await row(conn.id);
    expect(waiting).toMatchObject({ status: "active", lastError: null });
    expect(waiting.rateLimitedUntil!.getTime()).toBeGreaterThanOrEqual(t0 + 299_000);
    expect(waiting.rateLimitedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 301_000);
    expect(waiting.rateLimitedSince).not.toBeNull();
    expect(waiting.rateLimitMessage).toContain("hourly budget");
    // The last good sync is not moved by a pass that read nothing.
    expect(waiting.lastSyncedAt).toEqual(conn.lastSyncedAt);

    // A restart forgets the in-process gate: the STORED wait alone holds every path.
    resetPosthogBudgetState();
    hogql = [];
    runsOpened = 0;
    const second = await runPosthogSyncPass();
    expect(second.results).toEqual([]);
    expect(second.deferred).toEqual([{ connectionId: conn.id, waitingUntil: waiting.rateLimitedUntil!.toISOString() }]);
    expect(await mirrorRecentPersons(waiting, new Date(Date.now() - 600_000))).toMatchObject({
      changed: [],
      waitingUntil: waiting.rateLimitedUntil!.toISOString(),
    });
    const watch = await runPhoneWatchPass();
    expect(watch.mirrored.find((m) => m.connectionId === conn.id)).toMatchObject({ changed: 0, waitingUntil: waiting.rateLimitedUntil!.toISOString() });
    expect(hogql).toEqual([]);
    expect(runsOpened).toBe(0);

    // What the client reads: catching up, next read at <time>; not a failure.
    const view = await request(app())
      .get(`/orgs/posthog/connections?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(view.status).toBe(200);
    expect(view.body.connections[0]).toMatchObject({
      status: "active",
      lastError: null,
      sync: { state: "catching_up", reason: "posthog_read_budget", retryAt: waiting.rateLimitedUntil!.toISOString() },
    });
    expect(view.body.connections[0].sync.message).toContain("hourly budget");

    // Once the wait is over, the next pass reads and clears it.
    await db.update(posthogConnections).set({ rateLimitedUntil: new Date(Date.now() - 1000) }).where(eq(posthogConnections.id, conn.id));
    refuse = false;
    const third = await runPosthogSyncPass(conn.id);
    expect(third.failures).toEqual([]);
    expect(third.results[0].state).toMatchObject({ windowRead: true, waitingUntil: null });
    const caughtUp = await row(conn.id);
    expect(caughtUp).toMatchObject({ status: "active", rateLimitedUntil: null, rateLimitedSince: null, rateLimitMessage: null });
    expect(caughtUp.lastSyncedAt!.getTime()).toBeGreaterThan(conn.lastSyncedAt!.getTime());
  });

  it("a refusal half-way through a long gap keeps the progress: the next pass resumes after the last row read", async () => {
    const gapStart = new Date("2026-11-02T16:32:03Z");
    const conn = await connection({ syncedThrough: gapStart, lastSyncedAt: new Date("2026-11-02T16:32:24Z") });
    const t = (i: number) => new Date(Date.parse("2026-11-03T00:00:00Z") + i * 1000).toISOString();
    eventsPageThenRefuse = Array.from({ length: 5000 }, (_, i) => ({ id: `ev-${i}`, event: "newsletter_link_identified", timestamp: t(i), person_id: "ph-anon" }));
    const pass = await runPosthogSyncPass(conn.id);
    expect(pass.results[0].state).toMatchObject({ windowRead: false });
    expect(pass.results[0].state.waitingUntil).not.toBeNull();
    const after = await row(conn.id);
    // Next window starts at syncedThrough - 1h = the last event read; the last GOOD sync is not claimed.
    expect(after.syncedThrough!.toISOString()).toBe(new Date(Date.parse(t(4999)) + 3_600_000).toISOString());
    expect(after.lastSyncedAt).toEqual(conn.lastSyncedAt);
    expect(after.status).toBe("active");
  });

  it("a 429 met by the fast mirror is recorded as a wait (never thrown) and also holds the full pass", async () => {
    const conn = await connection();
    refuse = true;
    const r = await mirrorRecentPersons(conn, new Date(Date.now() - 600_000));
    expect(r.waitingUntil).not.toBeNull();
    expect(hogql).toHaveLength(1);
    expect(await row(conn.id)).toMatchObject({ status: "active" });
    hogql = [];
    const pass = await runPosthogSyncPass();
    expect(pass.deferred.map((d) => d.connectionId)).toEqual([conn.id]);
    expect(hogql).toEqual([]);
  });

  it("a paused connection stays paused through a 429", async () => {
    const conn = await connection();
    refuse = true;
    await mirrorRecentPersons(conn, new Date(Date.now() - 600_000));
    await db.update(posthogConnections).set({ status: "paused" }).where(eq(posthogConnections.id, conn.id));
    resetPosthogBudgetState();
    await db.update(posthogConnections).set({ rateLimitedUntil: null }).where(eq(posthogConnections.id, conn.id));
    await mirrorRecentPersons((await row(conn.id))!, new Date(Date.now() - 600_000));
    expect(await row(conn.id)).toMatchObject({ status: "paused" });
  });

  it("every read is bounded: no activity read touches the persons table, no read parses $set, persons re-listed only every 6 h (by id otherwise)", async () => {
    const conn = await connection({ personsListedAt: null });
    await mirrorRecentPersons(conn, new Date(Date.now() - 600_000));
    const p1 = await runPosthogSyncPass(conn.id);
    expect(p1.results[0].state.personsListed).toBe(true);
    const activity = hogql.filter((q) => q.includes("FROM events"));
    expect(activity.length).toBeGreaterThan(0);
    for (const q of activity) {
      expect(q).not.toMatch(/FROM persons/);
      expect(q).not.toContain("person.id");
      expect(q).not.toContain("$set.");
    }
    // The second pass (within 6 h) never reads the persons table.
    hogql = [];
    const p2 = await runPosthogSyncPass(conn.id);
    expect(p2.results[0].state.personsListed).toBe(false);
    // Only reads BY ID (the persons table is keyed on it): never the whole table.
    for (const q of hogql.filter((x) => x.includes("FROM persons"))) expect(q).toContain("toString(p.id) IN");
  });

  it("the history backlog is read newest first, paced by the bytes PostHog reports, never in one burst", async () => {
    const conn = await connection();
    // 120 persons mirrored while PostHog refused reads: their history was never read.
    const values = Array.from({ length: 120 }, (_, i) => ({
      orgId: ORG,
      brandId: BRAND,
      connectionId: conn.id,
      kind: "person",
      externalId: `ph-p${String(i).padStart(3, "0")}`,
      contentHash: `h${i}`,
      payload: { id: `ph-p${String(i).padStart(3, "0")}`, created_at: new Date(Date.parse("2026-11-01T00:00:00Z") + i * 3_600_000).toISOString() },
    }));
    await db.insert(posthogRawRecords).values(values);
    // Each read scans 0.4 GB (as PostHog reports it): the window (2 reads) + one history chunk (3 reads) pass the
    // 2 GB an hour the backlog may spend, so this pass reads ONE chunk of 50 and stops, with no refusal.
    bytesPerRead = 400_000_000;
    expect(POSTHOG_BACKFILL_HOURLY_BYTES).toBe(2_000_000_000);
    const pass = await runPosthogSyncPass(conn.id);
    expect(pass.results[0].state).toMatchObject({ historyRead: 50, historyBacklog: 70, waitingUntil: null });
    const done = await db
      .select({ id: posthogRawRecords.externalId })
      .from(posthogRawRecords)
      .where(and(eq(posthogRawRecords.connectionId, conn.id), sql`${posthogRawRecords.historyReadAt} IS NOT NULL`));
    // Newest persons first: p070..p119.
    expect(done.map((d) => d.id).sort()).toEqual(values.slice(70).map((v) => v.externalId));
    // History reads are scoped by distinct id and dated from the persons' creation, never the persons table.
    const history = hogql.filter((q) => q.includes("distinct_id IN"));
    expect(history.length).toBeGreaterThan(0);
    for (const q of history) expect(q).not.toContain("2000-01-01");

    // An hour later the next chunk is read.
    resetPosthogBudgetState();
    const next = await runPosthogSyncPass(conn.id);
    expect(next.results[0].state).toMatchObject({ historyRead: 50, historyBacklog: 20 });
    const left = await db
      .select()
      .from(posthogRawRecords)
      .where(and(eq(posthogRawRecords.connectionId, conn.id), isNull(posthogRawRecords.historyReadAt)));
    expect(left).toHaveLength(20);

    // The client reads "catching up: reading history", not a failure.
    const view = await request(app())
      .get(`/orgs/posthog/connections?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(view.body.connections[0].sync).toMatchObject({ state: "catching_up", reason: "reading_history", historyBacklog: 20 });
  });
});
