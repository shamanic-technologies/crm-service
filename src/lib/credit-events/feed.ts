/**
 * THE CREDIT WATCH (CREDIT-RAN-OUT-UNIBOX-EVENT-1024): mirror billing-service's "credit ran out" / "credit restored"
 * feed (`GET /internal/credit-events?cursor=`, cross-org, total order (at, eventId), events at least 60 s old) into
 * bronze `credit_events` (insert-only on billing's event id: a re-read page stores nothing twice), find the people each
 * event is about (client-service org members, staff dropped), and report each member once as a Lead event (rules.ts).
 *
 * Filed ONLY under the staff Unibox scope (`COPILOT_UNIBOX_ORG_ID` + `_BRAND_ID`, same structural privacy as the
 * Copilot / API sources): the timeline (people/timeline.ts `billingItems`) and the fact feed (people/facts.ts
 * `creditCandidates`) read these rows for that scope alone; every other (org, brand) is `not_connected`.
 *
 * Every `CREDIT_WATCH_INTERVAL_MS` (60 s), first pass 60 s after boot, one at a time; `CREDIT_WATCH=off` stops it.
 * The cursor only moves after its page is stored, so a crash re-reads a page (idempotent), never skips one.
 */

import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { billingFeedCursors, creditEventReports, creditEvents, people, peopleScopes, type CreditEventReport } from "../../db/schema.js";
import { readOrgMembers } from "../org-members.js";
import { readOrg } from "../conversation-pings.js";
import { readBrandOffers } from "../form-trigger/offer.js";
import { copilotDestination } from "../copilot/messages.js";
import { runScopeBuild } from "../people/build.js";
import { emailKey } from "../people/identity.js";
import { siblingGet, type SiblingIdentity } from "../people/siblings.js";
import { createRun, updateRun } from "../runs-client.js";
import { CampaignRefusal, FINAL_REFUSAL_STATUSES, campaignServiceConfigured, recordTriggerEvent } from "../trigger-door.js";
import {
  CREDIT_REPORT_REASONS,
  CREDIT_REPORT_STATUS,
  creditOccurrenceBody,
  memberEmailsOf,
  parseFeedPage,
  reportOffers,
  reportVerdict,
  type FeedPage,
} from "./rules.js";

const SERVICE_NAME = "crm-service";
export const CREDIT_FEED = "billing_credit_events";
export const CREDIT_WATCH_INTERVAL_MS = Number(process.env.CREDIT_WATCH_INTERVAL_MS) || 60_000;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_PASS = 20;
const MAX_BACKOFF_MS = 60 * 60_000;
/** A report campaign-service could not take is retried this long after it was created. */
const REPORT_RETRY_WINDOW_MS = 24 * 60 * 60_000;

export function nextAttemptDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  return lastAttemptAt.getTime() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

function billingEnv(): { url: string; key: string } {
  const url = process.env.BILLING_SERVICE_URL;
  const key = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service][credit] BILLING_SERVICE_URL and BILLING_SERVICE_API_KEY are required to read the credit events");
  return { url: url.replace(/\/+$/, ""), key };
}

/** The staff Unibox scope (and who its runs are filed under), or null when the box configures none. */
async function staffScope(): Promise<{ orgId: string; brandId: string; userId: string; scopeId: string } | null> {
  const d = copilotDestination();
  if (!d) return null;
  const [scope] = await db
    .select({ id: peopleScopes.id, userId: peopleScopes.createdByUserId })
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, d.orgId), eq(peopleScopes.brandId, d.brandId)));
  if (!scope) throw new Error(`[crm-service][credit] no people scope for the staff Unibox ${d.orgId}/${d.brandId}: nobody to file the reads under`);
  return { ...d, userId: scope.userId, scopeId: scope.id };
}

export async function fetchCreditEventsPage(cursor: string | null): Promise<FeedPage> {
  const { url, key } = billingEnv();
  const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetch(`${url}/internal/credit-events?${qs}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`[crm-service][credit] billing-service GET /internal/credit-events answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parseFeedPage(await res.json());
}

/** Store one page (insert-only on billing's event id), then move the cursor. Returns how many events were new. */
export async function storeCreditPage(page: FeedPage, previousCursor: string | null): Promise<number> {
  return db.transaction(async (tx) => {
    let stored = 0;
    if (page.events.length > 0) {
      const inserted = await tx
        .insert(creditEvents)
        .values(
          page.events.map((e) => ({
            eventId: e.eventId,
            type: e.type,
            creditOrgId: e.orgId,
            episodeId: e.episodeId,
            at: new Date(e.at),
          })),
        )
        .onConflictDoNothing({ target: creditEvents.eventId })
        .returning({ eventId: creditEvents.eventId });
      stored = inserted.length;
    }
    // An empty page answers no cursor of its own: keep the one we hold.
    const cursor = page.nextCursor ?? previousCursor;
    await tx
      .insert(billingFeedCursors)
      .values({ feed: CREDIT_FEED, cursor, caughtUpAt: page.hasMore ? null : new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: billingFeedCursors.feed,
        set: { cursor, updatedAt: new Date(), ...(page.hasMore ? {} : { caughtUpAt: new Date() }) },
      });
    return stored;
  });
}

/** The watch's baseline: the first pass ever. Created now when absent. */
export async function creditWatchSince(): Promise<Date> {
  await db.insert(billingFeedCursors).values({ feed: CREDIT_FEED }).onConflictDoNothing({ target: billingFeedCursors.feed });
  const [row] = await db.select().from(billingFeedCursors).where(eq(billingFeedCursors.feed, CREDIT_FEED));
  return row.watchSince;
}

/** Read billing's feed to its end (bounded per pass). */
export async function mirrorCreditFeed(): Promise<{ pages: number; read: number; stored: number; caughtUp: boolean }> {
  await creditWatchSince();
  const [row] = await db.select().from(billingFeedCursors).where(eq(billingFeedCursors.feed, CREDIT_FEED));
  let cursor = row?.cursor ?? null;
  let pages = 0;
  let read = 0;
  let stored = 0;
  let caughtUp = false;
  while (pages < MAX_PAGES_PER_PASS) {
    const page = await fetchCreditEventsPage(cursor);
    stored += await storeCreditPage(page, cursor);
    pages++;
    read += page.events.length;
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) {
      caughtUp = true;
      break;
    }
  }
  return { pages, read, stored, caughtUp };
}

/** A name a person reads for the org: client-service's, else its oldest brand's (brand-service). Never fabricated. */
async function orgLabelOf(orgId: string, identity: SiblingIdentity): Promise<string | null> {
  try {
    const org = await readOrg(orgId, identity);
    if (org?.name) return org.name;
  } catch (err) {
    console.warn(`[crm-service][credit] client-service name of org ${orgId} unreadable: ${(err as Error).message}`);
  }
  try {
    const r = await siblingGet("brand", "/orgs/brands", { ...identity, orgId });
    if (r.status !== 200) return null;
    const brands = ((r.body as { brands?: { name?: string | null; createdAt?: string | null }[] })?.brands ?? []).filter((b) => b.name?.trim());
    brands.sort((a, b) => (a.createdAt ?? "9999").localeCompare(b.createdAt ?? "9999"));
    return brands[0]?.name?.trim() ?? null;
  } catch (err) {
    console.warn(`[crm-service][credit] brand-service brands of org ${orgId} unreadable: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Each stored event not yet tied to people: its org's members (client-service, staff dropped) and a report row per
 * member (pending, or skipped as history). client-service unreadable = the event waits for the next pass.
 */
export async function resolveCreditPeople(
  identity: { userId: string; runId: string; brandId: string },
  now: number = Date.now(),
): Promise<{ resolved: number; failed: number; reports: number }> {
  const pending = await db.select().from(creditEvents).where(isNull(creditEvents.membersResolvedAt)).orderBy(creditEvents.at, creditEvents.eventId);
  if (pending.length === 0) return { resolved: 0, failed: 0, reports: 0 };
  const watchSince = await creditWatchSince();
  const byOrg = new Map<string, typeof pending>();
  for (const e of pending) byOrg.set(e.creditOrgId, [...(byOrg.get(e.creditOrgId) ?? []), e]);
  let resolved = 0;
  let failed = 0;
  let reports = 0;
  for (const [orgId, events] of byOrg) {
    const orgIdentity = { ...identity, orgId };
    let emails: string[];
    try {
      emails = memberEmailsOf((await readOrgMembers(orgIdentity)).emails);
    } catch (err) {
      failed += events.length;
      const message = (err as Error).message.slice(0, 500);
      console.warn(`[crm-service][credit] members of org ${orgId} unreadable, retried next pass: ${message}`);
      await db.update(creditEvents).set({ membersError: message }).where(inArray(creditEvents.eventId, events.map((e) => e.eventId)));
      continue;
    }
    const label = await orgLabelOf(orgId, orgIdentity);
    for (const e of events) {
      await db.transaction(async (tx) => {
        await tx
          .update(creditEvents)
          .set({ memberEmails: emails, orgLabel: label, membersResolvedAt: new Date(), membersError: null })
          .where(eq(creditEvents.eventId, e.eventId));
        if (emails.length === 0) return;
        const verdict = reportVerdict(e.at, watchSince, now);
        const inserted = await tx
          .insert(creditEventReports)
          .values(
            emails.map((email) => ({
              eventId: e.eventId,
              email,
              status: verdict.status,
              reason: verdict.status === "skipped" ? verdict.reason : null,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: creditEventReports.id });
        reports += inserted.length;
      });
      resolved++;
    }
  }
  return { resolved, failed, reports };
}

async function dueReports(now: number): Promise<CreditEventReport[]> {
  const found = await db
    .select()
    .from(creditEventReports)
    .where(
      and(
        inArray(creditEventReports.status, [CREDIT_REPORT_STATUS.PENDING, CREDIT_REPORT_STATUS.FAILED]),
        or(isNull(creditEventReports.reason), ne(creditEventReports.reason, CREDIT_REPORT_REASONS.CAMPAIGN_REFUSED)),
        gt(creditEventReports.createdAt, new Date(now - REPORT_RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(creditEventReports.createdAt, creditEventReports.id);
  return found.filter((r) => nextAttemptDue(r.attempts, r.lastAttemptAt) <= now);
}

/** The staff scope's person holding this address: their name and the offers their conversations are about. */
async function personOf(scope: { orgId: string; brandId: string }, email: string): Promise<{ name: string | null; offerIds: string[] }> {
  const [p] = await db
    .select({ name: people.displayName, offerIds: people.offerIds })
    .from(people)
    .where(and(eq(people.orgId, scope.orgId), eq(people.brandId, scope.brandId), sql`${people.identityKeys} @> ${JSON.stringify([emailKey(email)])}::jsonb`))
    .limit(1);
  return { name: p?.name ?? null, offerIds: (p?.offerIds as string[] | undefined) ?? [] };
}

export interface DeliveredReport {
  reportId: string;
  status: string;
  reason: string | null;
}

/** Report every due member: one ORG run of the staff scope per pass. */
export async function deliverCreditReports(
  scope: { orgId: string; brandId: string; userId: string },
  runId: string,
  now: number = Date.now(),
): Promise<DeliveredReport[]> {
  if (!campaignServiceConfigured()) return [];
  const due = await dueReports(now);
  if (due.length === 0) return [];
  const identity = { orgId: scope.orgId, userId: scope.userId, runId, brandId: scope.brandId };
  const settle = (r: CreditEventReport, set: Partial<CreditEventReport>) =>
    db
      .update(creditEventReports)
      .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now), runId })
      .where(eq(creditEventReports.id, r.id));
  let activeOffers: string[];
  try {
    activeOffers = (await readBrandOffers(identity)).filter((o) => o.status === "active").map((o) => o.offerId);
  } catch (err) {
    console.warn(`[crm-service][credit] staff brand offers unreadable, reports retried next pass: ${(err as Error).message}`);
    return [];
  }
  const events = new Map(
    (await db.select().from(creditEvents).where(inArray(creditEvents.eventId, [...new Set(due.map((r) => r.eventId))]))).map((e) => [e.eventId, e]),
  );
  const out: DeliveredReport[] = [];
  for (const r of due) {
    const e = events.get(r.eventId)!;
    const person = await personOf(scope, r.email);
    const offers = reportOffers(person.offerIds, activeOffers);
    if (offers.length === 0) {
      await settle(r, { status: CREDIT_REPORT_STATUS.FAILED, reason: CREDIT_REPORT_REASONS.OFFER_UNKNOWN, lastError: "the staff brand has no active offer" });
      out.push({ reportId: r.id, status: CREDIT_REPORT_STATUS.FAILED, reason: CREDIT_REPORT_REASONS.OFFER_UNKNOWN });
      continue;
    }
    try {
      const recorded: { offerId: string; eventId: string; replayed: boolean }[] = [];
      for (const offerId of offers) {
        const rec = await recordTriggerEvent(
          identity,
          creditOccurrenceBody({
            brandId: scope.brandId,
            offerId,
            email: r.email,
            name: person.name,
            eventId: e.eventId,
            type: e.type,
            creditOrgId: e.creditOrgId,
            episodeId: e.episodeId,
            orgLabel: e.orgLabel,
            at: e.at,
          }),
        );
        recorded.push({ offerId, eventId: rec.eventId, replayed: rec.replayed });
      }
      await settle(r, {
        status: CREDIT_REPORT_STATUS.REPORTED,
        reason: null,
        lastError: null,
        offerIds: offers,
        campaignEvents: recorded,
        reportedAt: new Date(),
      });
      console.log(`[crm-service][credit] reported ${e.type} ${e.eventId} for ${r.email} as account_event x${recorded.length}`);
      out.push({ reportId: r.id, status: CREDIT_REPORT_STATUS.REPORTED, reason: null });
    } catch (err) {
      const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
      const reason = final ? CREDIT_REPORT_REASONS.CAMPAIGN_REFUSED : CREDIT_REPORT_REASONS.CAMPAIGN_UNREACHABLE;
      console.warn(`[crm-service][credit] ${e.type} ${e.eventId} for ${r.email} not reported (${reason}): ${(err as Error).message}`);
      await settle(r, { status: CREDIT_REPORT_STATUS.FAILED, reason, lastError: (err as Error).message.slice(0, 1000), offerIds: offers });
      out.push({ reportId: r.id, status: CREDIT_REPORT_STATUS.FAILED, reason });
    }
  }
  return out;
}

export interface CreditWatchResult {
  feed: { pages: number; read: number; stored: number; caughtUp: boolean };
  people: { resolved: number; failed: number; reports: number };
  delivered: DeliveredReport[];
}

/** One pass: mirror the feed, tie new events to people, report the due members, rebuild the staff people when anything moved. */
export async function runCreditWatchPass(now: number = Date.now()): Promise<CreditWatchResult | { skipped: "not_configured" }> {
  const scope = await staffScope();
  if (!scope) return { skipped: "not_configured" };
  const feed = await mirrorCreditFeed();
  const result: CreditWatchResult = { feed, people: { resolved: 0, failed: 0, reports: 0 }, delivered: [] };
  const [unresolved] = (await db.execute(sql`SELECT count(*)::int AS n FROM credit_events WHERE members_resolved_at IS NULL`)) as unknown as { n: number }[];
  const [due] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM credit_event_reports WHERE status IN ('pending', 'failed')`,
  )) as unknown as { n: number }[];
  if (unresolved.n === 0 && due.n === 0) return result;
  const run = await createRun({ orgId: scope.orgId, userId: scope.userId, brandIds: [scope.brandId], serviceName: SERVICE_NAME, taskName: "credit-events.watch" });
  const runIdentity = { orgId: scope.orgId, userId: scope.userId, runId: run.id, brandIds: [scope.brandId] };
  try {
    result.people = await resolveCreditPeople({ userId: scope.userId, runId: run.id, brandId: scope.brandId }, now);
    // The facts of newly tied events reach lead-service with the staff scope's next build: run it now.
    if (result.people.resolved > 0 && process.env.CREDIT_WATCH_REBUILD !== "off") {
      const [s] = await db.select().from(peopleScopes).where(eq(peopleScopes.id, scope.scopeId));
      if (s) void runScopeBuild(s, { followUp: true }).catch((err) => console.error("[crm-service][credit] staff people build failed:", err));
    }
    result.delivered = await deliverCreditReports(scope, run.id, now);
    await updateRun(run.id, result.delivered.some((d) => d.status === CREDIT_REPORT_STATUS.FAILED) ? "failed" : "completed", runIdentity);
  } catch (err) {
    await updateRun(run.id, "failed", runIdentity).catch(() => {});
    throw err;
  }
  return result;
}

let running = false;

/** Run one pass now unless one is running. */
export async function creditWatchNow(): Promise<CreditWatchResult | { skipped: "pass_running" | "not_configured" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    return await runCreditWatchPass();
  } finally {
    running = false;
  }
}

/** In-process, every CREDIT_WATCH_INTERVAL_MS, first pass 60 s after boot, never two at once. */
export function startCreditWatch(): void {
  if (process.env.CREDIT_WATCH === "off") return;
  if (!process.env.BILLING_SERVICE_URL || !process.env.BILLING_SERVICE_API_KEY) {
    console.error("[crm-service][credit] BILLING_SERVICE_URL / BILLING_SERVICE_API_KEY not set: credit events are not mirrored");
    return;
  }
  const tick = () => {
    creditWatchNow()
      .then((r) => {
        if ("feed" in r && (r.feed.stored > 0 || r.people.resolved > 0 || r.delivered.length > 0)) {
          console.log(`[crm-service][credit] pass: ${JSON.stringify({ feed: r.feed, people: r.people, delivered: r.delivered.length })}`);
        }
      })
      .catch((e) => console.error("[crm-service][credit] pass failed:", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, CREDIT_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}
