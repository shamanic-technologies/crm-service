/**
 * Keeping the message store current BEFORE anyone opens a person.
 *
 * The timeline serves Gmail and cold email from crm-service's store
 * (people/search.ts) so an open never waits on a slow sibling. A store is only as
 * good as its freshness, and the build's signal is coarse: a person's activity
 * date moves on a sequence send or their first reply, never on a reply WE sent
 * (instantly-service's written-to-leads `lastSentAt` is the last sequence step).
 * Measured 2026-10-10: robert.burke@fondren.com's automated follow-up of
 * 2026-10-09 21:28 stayed out of his thread for 10 hours, until the owner opened
 * him twice.
 *
 * So once a minute, per scope, this asks each source what MOVED, cheaply:
 *
 *  - instantly  the outreach fact feed (`GET /internal/outreach-facts`, cursor
 *               per scope): every fact names a (campaign, lead) thread that just
 *               gained something. Facts recorded more than a day ago are only
 *               walked past: the store's daily re-read already covers them.
 *  - gmail      the correspondents read (`GET /orgs/google/correspondents`),
 *               served most-recent-first: the first page says which addresses
 *               have a newer last message than the one we last saw.
 *
 * A thread that moved gets `changed_at` = when we learned it, and is re-read
 * right away and once more CHANGE_CONFIRM_MS later (the sibling's own read can
 * trail its signal by a moment: Instantly's mirror, Gmail's sync). An open that
 * finds a stored thread older than a known change re-reads THAT thread before
 * answering (people/search.ts); every other thread is served as stored.
 *
 * READ-ONLY toward every source, like the rest of the person layer.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleMessageUnits, peopleScopes, type PeopleScope } from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { refreshUnits, UNIT_REFRESH_MS, type Unit } from "./search.js";
import { siblingGet, type SiblingIdentity } from "./siblings.js";
import type { BuildSummary } from "./build.js";

const SERVICE_NAME = "crm-service";

export const FRESHNESS_INTERVAL_MS = Number(process.env.PEOPLE_FRESHNESS_INTERVAL_MS) || 60_000;
/** A moved thread is read again this long after we learned of the move. */
export const CHANGE_CONFIRM_MS = 5 * 60_000;
const FACT_PAGE = 1000;
/**
 * Time spent walking one scope's fact feed per tick; a backlog drains over the
 * next ticks. A first walk starts at the feed's beginning (~3.4M fleet facts on
 * 2026-10-10, ~90 ms a page of 1000): pages-per-tick at 20 left the largest brand
 * unwatched for over an hour.
 */
const FACT_WALK_BUDGET_MS = 30_000;
/** Gmail correspondents read per tick (most recent first). */
const GMAIL_RECENT = 200;

interface OutreachFact {
  seq: string;
  recordedAt: string;
  leadEmail: string;
  orgId: string | null;
  campaignId: string | null;
  brandIds: string[];
}

interface FactsPage {
  facts: OutreachFact[];
  nextCursor: string;
  hasMore: boolean;
}

interface Correspondent {
  email: string;
  lastMessageAt: string | null;
}

/**
 * PURE: the cold-email units the facts name for this scope, ignoring facts
 * recorded before `since` (the daily re-read covers those).
 */
export function unitsFromFacts(scope: Pick<PeopleScope, "orgId" | "brandId">, facts: OutreachFact[], since: number): string[] {
  const units = new Set<string>();
  for (const f of facts) {
    if (f.orgId !== scope.orgId || !f.campaignId || !f.brandIds.includes(scope.brandId)) continue;
    if (new Date(f.recordedAt).getTime() < since) continue;
    units.add(`${f.campaignId}:${f.leadEmail.trim().toLowerCase()}`);
  }
  return [...units];
}

/** Walk the scope's fact feed from its cursor; returns the units it names and moves the cursor. */
async function instantlyMoved(scope: PeopleScope, identity: SiblingIdentity): Promise<string[]> {
  let cursor = scope.outreachFactsCursor;
  const units = new Set<string>();
  const since = Date.now() - UNIT_REFRESH_MS;
  const deadline = Date.now() + FACT_WALK_BUDGET_MS;
  while (Date.now() < deadline) {
    const q = new URLSearchParams({ orgId: scope.orgId, brandId: scope.brandId, limit: String(FACT_PAGE) });
    if (cursor) q.set("since", cursor);
    const r = await siblingGet("instantly", `/internal/outreach-facts?${q}`, identity);
    if (r.status !== 200) {
      throw new Error(`instantly-service outreach-facts returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    const body = r.body as FactsPage;
    for (const u of unitsFromFacts(scope, body.facts, since)) units.add(u);
    cursor = body.nextCursor;
    if (!body.hasMore) break;
  }
  if (cursor !== scope.outreachFactsCursor) {
    await db.update(peopleScopes).set({ outreachFactsCursor: cursor }).where(eq(peopleScopes.id, scope.id));
  }
  return [...units];
}

/** The Gmail addresses whose last message is newer than the one we last saw. */
async function gmailMoved(scope: PeopleScope, identity: SiblingIdentity): Promise<{ unit: string; mark: string }[]> {
  const r = await siblingGet("google", `/orgs/google/correspondents?limit=${GMAIL_RECENT}`, identity);
  if (r.status === 404) return []; // no mailbox connected
  if (r.status !== 200) {
    throw new Error(`google-service correspondents returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const recent = (r.body as { correspondents: Correspondent[] }).correspondents
    .filter((c) => c.lastMessageAt)
    .map((c) => ({ unit: c.email.trim().toLowerCase(), mark: new Date(c.lastMessageAt!).toISOString() }));
  if (recent.length === 0) return [];
  const known = await db
    .select({ unit: peopleMessageUnits.unit, changeMark: peopleMessageUnits.changeMark })
    .from(peopleMessageUnits)
    .where(
      and(
        eq(peopleMessageUnits.scopeId, scope.id),
        eq(peopleMessageUnits.source, "gmail"),
        inArray(peopleMessageUnits.unit, recent.map((c) => c.unit)),
      ),
    );
  const marks = new Map(known.map((k) => [k.unit, k.changeMark]));
  // ISO strings of one format compare in time order.
  return recent.filter((c) => marks.has(c.unit) && (marks.get(c.unit) ?? "") < c.mark);
}

/** Record that these stored threads moved now. Threads never stored are left to the open (read on first sight). */
async function markChanged(scopeId: string, source: "gmail" | "instantly", moved: { unit: string; mark?: string }[]): Promise<void> {
  const now = new Date();
  for (const m of moved) {
    await db
      .update(peopleMessageUnits)
      .set(m.mark ? { changedAt: now, changeMark: m.mark } : { changedAt: now })
      .where(and(eq(peopleMessageUnits.scopeId, scopeId), eq(peopleMessageUnits.source, source), eq(peopleMessageUnits.unit, m.unit)));
  }
}

/**
 * PURE: a stored thread the watch must re-read: never re-read since its move, or
 * not re-read since CHANGE_CONFIRM_MS after it (the confirmation read).
 */
export function changePending(u: { changedAt: Date | null; indexedAt: Date }, now: number): boolean {
  if (!u.changedAt) return false;
  const changed = u.changedAt.getTime();
  const read = u.indexedAt.getTime();
  if (read < changed) return true;
  return read < changed + CHANGE_CONFIRM_MS && now >= changed + CHANGE_CONFIRM_MS;
}

export interface FreshnessScopeResult {
  scopeId: string;
  moved: number;
  refreshed: number;
  failed: number;
  error?: string;
}

/** One watch pass over one scope. */
export async function watchScope(scope: PeopleScope): Promise<FreshnessScopeResult> {
  const result: FreshnessScopeResult = { scopeId: scope.id, moved: 0, refreshed: 0, failed: 0 };
  // The reads are free DB reads on the siblings, attributed to the scope's latest build run.
  if (!scope.lastRunId) return result;
  const pollIdentity: SiblingIdentity = {
    orgId: scope.orgId,
    userId: scope.createdByUserId,
    runId: scope.lastRunId,
    brandId: scope.brandId,
  };
  const instantly = await instantlyMoved(scope, pollIdentity);
  await markChanged(scope.id, "instantly", instantly.map((unit) => ({ unit })));
  const gmailStatus = (scope.sourceReads as BuildSummary | null)?.sources.find((s) => s.source === "gmail")?.status;
  const gmail = gmailStatus && gmailStatus !== "not_connected" ? await gmailMoved(scope, pollIdentity) : [];
  await markChanged(scope.id, "gmail", gmail);
  result.moved = instantly.length + gmail.length;

  const candidates = await db
    .select()
    .from(peopleMessageUnits)
    .where(and(eq(peopleMessageUnits.scopeId, scope.id), sql`${peopleMessageUnits.changedAt} IS NOT NULL`, sql`${peopleMessageUnits.indexedAt} < ${peopleMessageUnits.changedAt} + interval '${sql.raw(String(CHANGE_CONFIRM_MS / 1000))} seconds'`));
  const now = Date.now();
  const due: Unit[] = candidates
    .filter((c) => changePending(c, now))
    .map((c) => ({
      source: c.source as Unit["source"],
      unit: c.unit,
      address: c.address,
      campaignId: c.source === "instantly" ? c.unit.split(":")[0] : null,
      activityAt: c.activityAt,
    }));
  if (due.length === 0) return result;

  // Re-reading is the work: its own org run, like a build.
  const run = await createRun({
    orgId: scope.orgId,
    userId: scope.createdByUserId,
    brandIds: [scope.brandId],
    serviceName: SERVICE_NAME,
    taskName: "people.freshness",
  });
  try {
    const r = await refreshUnits(scope.id, due, { ...pollIdentity, runId: run.id });
    result.refreshed = r.read;
    result.failed = r.failed;
    await updateRun(run.id, "completed", { orgId: scope.orgId, userId: scope.createdByUserId });
  } catch (err) {
    await updateRun(run.id, "failed", { orgId: scope.orgId, userId: scope.createdByUserId }).catch((e) =>
      console.error(`[crm-service] failed to close people freshness run ${run.id}:`, e),
    );
    throw err;
  }
  return result;
}

let running = false;

/** One watch pass over every scope; one failing scope does not stop the others. */
export async function runFreshnessPass(): Promise<FreshnessScopeResult[] | null> {
  if (running) return null;
  running = true;
  try {
    const scopes = await db.select().from(peopleScopes);
    const results: FreshnessScopeResult[] = [];
    for (const scope of scopes) {
      try {
        const r = await watchScope(scope);
        results.push(r);
        if (r.refreshed || r.failed) {
          console.log(`[crm-service] people freshness scope=${scope.id} moved=${r.moved} refreshed=${r.refreshed} failed=${r.failed}`);
        }
      } catch (err) {
        console.error(`[crm-service] people freshness failed scope=${scope.id}:`, err);
        results.push({ scopeId: scope.id, moved: 0, refreshed: 0, failed: 0, error: (err as Error).message });
      }
    }
    return results;
  } finally {
    running = false;
  }
}

/** In-process: first pass ~60s after boot (deploys recreate the container often), then every interval. */
export function startFreshnessWatch(): void {
  const tick = () => {
    runFreshnessPass().catch((e) => console.error("[crm-service] people freshness pass failed:", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, FRESHNESS_INTERVAL_MS).unref();
  }, 60_000).unref();
}
