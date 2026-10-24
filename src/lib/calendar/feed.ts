/**
 * THE CALENDAR WATCH (GOOGLE-CALENDAR-MEETING-FACTS-1021): mirror google-service's calendar changes feed,
 * then, for every brand of an org whose meetings moved, decide who the meetings are with and who joined
 * (lib/calendar/matching.ts) and rebuild its people so the meeting facts reach lead-service.
 *
 * The feed (`GET /internal/calendar/events?cursor=`) is CROSS-ORG and keyset-paged; an event comes back
 * each time it changes (reschedule, cancel, Meet attendance read). Bronze `calendar_events` keeps the
 * latest served version per google-service row id; the cursor lives in `calendar_feed_cursors` and only
 * moves after its page is stored, so a crash re-reads a page (upserts: idempotent), never skips one.
 *
 * google-service answers its routes only with an identity (org, user, run): the feed read is our
 * platform's own, filed under the staff org (`COPILOT_UNIBOX_ORG_ID`, its scope's creator) with one org
 * run per pass. Every judgment is billed to the org whose brand it is for, on that org's own run.
 *
 * Every `CALENDAR_WATCH_INTERVAL_MS` (5 min; google-service re-reads calendars every 15), first pass 60 s
 * after boot, one at a time; `CALENDAR_WATCH=off` stops it. Every `CALENDAR_REJUDGE_INTERVAL_MS` (15 min)
 * every org with meetings is judged again (people the brand learned since may now match an attendee:
 * asked only when the question changed).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { calendarEvents, calendarFeedCursors, peopleScopes, type PeopleScope } from "../../db/schema.js";
import { readOrgMembers } from "../org-members.js";
import { runScopeBuild } from "../people/build.js";
import { siblingGetOk } from "../people/siblings.js";
import { createRun, SUPPORT_RUNS, updateRun } from "../runs-client.js";
import { judgeScopeMeetings, type ScopeJudgeSummary } from "./matching.js";
import type { CalendarEvent } from "./meetings.js";

const SERVICE_NAME = "crm-service";
export const CALENDAR_FEED = "google_calendar_events";
export const CALENDAR_WATCH_INTERVAL_MS = Number(process.env.CALENDAR_WATCH_INTERVAL_MS) || 5 * 60_000;
export const CALENDAR_REJUDGE_INTERVAL_MS = Number(process.env.CALENDAR_REJUDGE_INTERVAL_MS) || 15 * 60_000;
const PAGE_LIMIT = 200;
const MAX_PAGES_PER_PASS = 50;

interface FeedPage {
  events: CalendarEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** The identity the cross-org feed read is filed under: the staff org and its Unibox scope's creator. */
async function feedIdentity(): Promise<{ orgId: string; userId: string }> {
  const orgId = process.env.COPILOT_UNIBOX_ORG_ID;
  const brandId = process.env.COPILOT_UNIBOX_BRAND_ID;
  if (!orgId || !brandId) throw new Error("[crm-service][calendar] COPILOT_UNIBOX_ORG_ID and COPILOT_UNIBOX_BRAND_ID are required to read the calendar feed");
  const [scope] = await db
    .select({ userId: peopleScopes.createdByUserId })
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
  if (!scope) throw new Error(`[crm-service][calendar] no people scope for the staff org ${orgId}: nobody to file the feed read under`);
  return { orgId, userId: scope.userId };
}

async function fetchFeedPage(cursor: string | null, identity: { orgId: string; userId: string; runId: string }): Promise<FeedPage> {
  const url = process.env.GOOGLE_SERVICE_URL;
  const key = process.env.GOOGLE_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service][calendar] GOOGLE_SERVICE_URL and GOOGLE_SERVICE_API_KEY are required");
  const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetch(`${url.replace(/\/+$/, "")}/internal/calendar/events?${qs}`, {
    headers: { "x-api-key": key, "x-org-id": identity.orgId, "x-user-id": identity.userId, "x-run-id": identity.runId },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`[crm-service][calendar] google-service GET /internal/calendar/events answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as FeedPage;
  if (!Array.isArray(body?.events) || typeof body.hasMore !== "boolean") {
    throw new Error("[crm-service][calendar] google-service calendar feed answered no events list");
  }
  return body;
}

/** Store one page (upsert on google-service's row id), then move the cursor. Returns the orgs whose events moved. */
export async function storeFeedPage(page: FeedPage): Promise<Set<string>> {
  const orgs = new Set<string>();
  await db.transaction(async (tx) => {
    for (const e of page.events) {
      const moved = await tx
        .insert(calendarEvents)
        .values({
          id: e.id,
          orgId: e.orgId,
          calendarEmail: e.calendarEmail,
          googleEventId: e.googleEventId,
          status: e.status,
          payload: e,
          changedAt: new Date(e.changedAt),
        })
        .onConflictDoUpdate({
          target: calendarEvents.id,
          set: { status: e.status, payload: e, changedAt: new Date(e.changedAt), mirroredAt: new Date() },
          setWhere: sql`${calendarEvents.payload} IS DISTINCT FROM ${JSON.stringify(e)}::jsonb`,
        })
        .returning({ orgId: calendarEvents.orgId });
      for (const m of moved) orgs.add(m.orgId);
    }
    await tx
      .insert(calendarFeedCursors)
      .values({ feed: CALENDAR_FEED, cursor: page.nextCursor, caughtUpAt: page.hasMore ? null : new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: calendarFeedCursors.feed,
        set: {
          cursor: page.nextCursor,
          updatedAt: new Date(),
          ...(page.hasMore ? {} : { caughtUpAt: new Date() }),
        },
      });
  });
  return orgs;
}

/** Read the feed to its end (bounded per pass). */
export async function mirrorCalendarFeed(): Promise<{ pages: number; events: number; orgs: Set<string>; caughtUp: boolean }> {
  const identity = await feedIdentity();
  const run = await createRun({ orgId: identity.orgId, userId: identity.userId, serviceName: SERVICE_NAME, taskName: "calendar.feed" });
  const orgs = new Set<string>();
  let pages = 0;
  let events = 0;
  let caughtUp = false;
  try {
    const [row] = await db.select().from(calendarFeedCursors).where(eq(calendarFeedCursors.feed, CALENDAR_FEED));
    let cursor = row?.cursor ?? null;
    while (pages < MAX_PAGES_PER_PASS) {
      const page = await fetchFeedPage(cursor, { ...identity, runId: run.id });
      for (const o of await storeFeedPage(page)) orgs.add(o);
      pages++;
      events += page.events.length;
      cursor = page.nextCursor;
      if (!page.hasMore) {
        caughtUp = true;
        break;
      }
    }
    await updateRun(run.id, "completed", identity);
  } catch (err) {
    await updateRun(run.id, "failed", identity).catch(() => {});
    throw err;
  }
  return { pages, events, orgs, caughtUp };
}

async function brandName(identity: { orgId: string; userId: string; runId: string; brandId: string }): Promise<string | null> {
  const body = await siblingGetOk<{ brand?: { name?: string | null } }>("brand", `/internal/brands/${identity.brandId}`, identity);
  return body?.brand?.name ?? null;
}

/** One scope: its org run, the org's team, the judgments, then a rebuild when anything moved. */
export async function judgeScope(scope: PeopleScope, eventsMoved: boolean): Promise<ScopeJudgeSummary> {
  const run = await createRun({
    orgId: scope.orgId,
    userId: scope.createdByUserId,
    brandIds: [scope.brandId],
    // Which person an attendee is: a product feature (the meeting is the lead's act), marked at creation (LEDGER-HISTORY-1024).
    ...SUPPORT_RUNS.calendarMatching,
  });
  const identity = { orgId: scope.orgId, userId: scope.createdByUserId, runId: run.id, brandId: scope.brandId };
  try {
    const members = await readOrgMembers(identity);
    const summary = await judgeScopeMeetings(
      scope,
      { orgId: scope.orgId, userId: scope.createdByUserId, runId: run.id, brandIds: [scope.brandId] },
      members.emails,
      await brandName(identity),
    );
    await updateRun(run.id, "completed", identity);
    if (summary.changed || eventsMoved) void runScopeBuild(scope, { followUp: true });
    return summary;
  } catch (err) {
    await updateRun(run.id, "failed", identity).catch(() => {});
    throw err;
  }
}

let lastFullJudgeAt = 0;

export interface CalendarWatchResult {
  feed: { pages: number; events: number; orgsMoved: number; caughtUp: boolean };
  scopes: (ScopeJudgeSummary | { scopeId: string; error: string })[];
}

/** One pass: mirror the feed, then judge every brand of an org whose meetings moved (all of them every 15 min). */
export async function runCalendarWatchPass(now: number = Date.now()): Promise<CalendarWatchResult> {
  const feed = await mirrorCalendarFeed();
  const full = now - lastFullJudgeAt >= CALENDAR_REJUDGE_INTERVAL_MS;
  let orgs = [...feed.orgs];
  if (full) {
    const all = (await db.execute(sql`SELECT DISTINCT org_id::text AS org_id FROM calendar_events`)) as unknown as { org_id: string }[];
    orgs = [...new Set([...orgs, ...all.map((r) => r.org_id)])];
    lastFullJudgeAt = now;
  }
  const result: CalendarWatchResult = {
    feed: { pages: feed.pages, events: feed.events, orgsMoved: feed.orgs.size, caughtUp: feed.caughtUp },
    scopes: [],
  };
  if (orgs.length === 0) return result;
  const scopes = await db.select().from(peopleScopes).where(inArray(peopleScopes.orgId, orgs));
  for (const scope of scopes) {
    try {
      result.scopes.push(await judgeScope(scope, feed.orgs.has(scope.orgId)));
    } catch (err) {
      console.error(`[crm-service][calendar] judge failed scope=${scope.id}:`, err);
      result.scopes.push({ scopeId: scope.id, error: (err as Error).message });
    }
  }
  console.log(
    `[crm-service][calendar] pass pages=${feed.pages} events=${feed.events} orgsMoved=${feed.orgs.size} scopes=${scopes.length} ` +
      result.scopes
        .map((s) => ("error" in s ? `${s.scopeId}:error` : `${s.scopeId}:att=${s.attendees},same=${s.sameAddress},jev=${s.attendeeJudged},meet=${s.attendanceJudged}`))
        .join(" "),
  );
  return result;
}

let running = false;

export function startCalendarWatch(): void {
  if (process.env.CALENDAR_WATCH === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runCalendarWatchPass()
      .catch((e) => console.error("[crm-service][calendar] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, CALENDAR_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}

/** A pass now, unless one runs (the route's answer says so). */
export async function runCalendarWatchNow(): Promise<CalendarWatchResult | { skipped: "pass_running" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    return await runCalendarWatchPass();
  } finally {
    running = false;
  }
}
