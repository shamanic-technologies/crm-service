/**
 * Every newsletter email we SENT a subscriber, on their Unibox thread (UNIBOX-NEWSLETTER-1113, owner 2026-11-13:
 * « une newsletter envoyée doit apparaître dans l'Unibox »; 2026-10-09: « L'Unibox liste TOUTES nos conversations,
 * y compris celles où nous seuls avons écrit »).
 *
 * transactional-email-service sends each release of a mailing list to its subscribers and serves every email it
 * SENT on a cursor feed (`GET /internal/sent-newsletters?after=&limit=`, one item per release x subscriber, oldest
 * first, full history). crm-service READS it like the sent-emails feed (lib/transactional/sent-emails.ts): bronze
 * `newsletter_sends`, one row per producer id, insert-only; the stored cursor never moves past a page holding an
 * email younger than TX_EMAIL_SETTLE_MS (the producer commits slightly out of order, the tail is re-read).
 *
 * Filed GENERICALLY, never on one list or brand: a send shows on the subscriber's thread ONLY in the scope(s) of the
 * brand(s) it was sent for, as the producer states them (`brandIds`: the release's own, else its list's stated brand),
 * in the sending org (`newsletterScopeMatches`). No brand known = filed nowhere, logged loud each pass. Matched on the recipient address. On the thread it is an outbound email of ours
 * (source `transactional`: the producer, `sentBy: automation`) with the release's subject; and it is a fact
 * `message_out` (people/facts.ts `newsletterCandidates`) so lead-service dates the row as OUR activity.
 *
 * Every TX_EMAIL_WATCH_INTERVAL_MS (60 s), first pass 75 s after boot, one at a time; `NEWSLETTER_SEND_WATCH=off`
 * stops it. Reads are free: no run, no cost.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { calendarFeedCursors, newsletterSends, type NewsletterSend } from "../../db/schema.js";
import { normalizeEmail } from "../people/identity.js";
import { TX_EMAIL_SETTLE_MS, TX_EMAIL_WATCH_INTERVAL_MS } from "./sent-emails.js";

/** The cursor row's name in the shared feed cursor table. */
export const NEWSLETTER_FEED = "transactional_sent_newsletters";
/** `ref.eventType` of a newsletter item on the thread (a transactional item carries its template name there). */
export const NEWSLETTER_EVENT_TYPE = "newsletter";
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_PASS = 50;

/** One email as transactional-email-service serves it. */
export interface FeedNewsletter {
  id: string;
  releaseId: string;
  listSlug: string;
  recipientEmail: string;
  orgId: string | null;
  brandIds: string[] | null;
  from: string | null;
  subject: string;
  sentAt: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stripNul = (s: string | null): string | null => (s === null ? null : s.replace(/\u0000/g, ""));

/** PURE: one feed row, checked; a row missing what the thread needs fails the page loud (never stored half). */
export function parseFeedNewsletter(raw: unknown): FeedNewsletter {
  const r = raw as Record<string, unknown>;
  const id = r?.id;
  if (!isStr(id) || !UUID.test(id)) throw new Error(`[crm-service][newsletter] feed row without a uuid id: ${JSON.stringify(raw).slice(0, 200)}`);
  if (!isStr(r.releaseId) || !UUID.test(r.releaseId)) throw new Error(`[crm-service][newsletter] email ${id}: no releaseId`);
  if (!isStr(r.listSlug) || !r.listSlug) throw new Error(`[crm-service][newsletter] email ${id}: no listSlug`);
  if (!isStr(r.recipientEmail) || !r.recipientEmail.includes("@")) throw new Error(`[crm-service][newsletter] email ${id}: no recipientEmail`);
  if (!isStr(r.subject)) throw new Error(`[crm-service][newsletter] email ${id}: no subject`);
  if (!isStr(r.sentAt) || Number.isNaN(Date.parse(r.sentAt))) throw new Error(`[crm-service][newsletter] email ${id}: sentAt is not a date`);
  if (r.orgId !== null && r.orgId !== undefined && !isStr(r.orgId)) throw new Error(`[crm-service][newsletter] email ${id}: orgId is not a string`);
  if (r.from !== null && r.from !== undefined && !isStr(r.from)) throw new Error(`[crm-service][newsletter] email ${id}: from is not a string`);
  const brandIds = r.brandIds === null || r.brandIds === undefined ? null : r.brandIds;
  if (brandIds !== null && !(Array.isArray(brandIds) && brandIds.every(isStr))) throw new Error(`[crm-service][newsletter] email ${id}: brandIds is not a list of ids`);
  return {
    id,
    releaseId: r.releaseId,
    listSlug: r.listSlug,
    recipientEmail: r.recipientEmail,
    orgId: (r.orgId as string | null | undefined) ?? null,
    brandIds: brandIds && (brandIds as string[]).length > 0 ? (brandIds as string[]) : null,
    from: (r.from as string | null | undefined) ?? null,
    subject: r.subject,
    sentAt: r.sentAt,
  };
}

/**
 * PURE: does a send belong on a thread of this (org, brand)? Only the brand(s) it was SENT FOR (the producer's `brandIds`:
 * the release's own, else its list's stated brand), in the sending org. No brand known = no thread at all (logged loud by
 * the pass): filing it on every brand of the org put our newsletter on 149 people of our Loom demo brand (2026-11-13).
 */
export function newsletterScopeMatches(send: { orgId: string | null; brandIds: unknown }, orgId: string, brandId: string): boolean {
  if (send.orgId !== orgId) return false;
  const brands = Array.isArray(send.brandIds) ? (send.brandIds as string[]) : [];
  return brands.includes(brandId);
}

/** SQL twin of `newsletterScopeMatches` on a `newsletter_sends` row alias. */
export const newsletterScopeSql = (alias: string, orgId: string, brandId: string) =>
  sql`${sql.raw(alias)}.org_id = ${orgId} AND ${sql.raw(alias)}.brand_ids ? ${brandId}`;

async function fetchPage(cursor: string | null): Promise<{ emails: FeedNewsletter[]; nextCursor: string | null }> {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const key = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service][newsletter] TRANSACTIONAL_EMAIL_SERVICE_URL and TRANSACTIONAL_EMAIL_SERVICE_API_KEY are required");
  const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) qs.set("after", cursor);
  const res = await fetch(`${url.replace(/\/+$/, "")}/internal/sent-newsletters?${qs}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`[crm-service][newsletter] sent-newsletters feed answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { emails?: unknown; nextCursor?: unknown };
  if (!Array.isArray(body.emails)) throw new Error("[crm-service][newsletter] sent-newsletters feed answered no emails list");
  if (body.nextCursor !== null && body.nextCursor !== undefined && !isStr(body.nextCursor)) throw new Error("[crm-service][newsletter] nextCursor is not a string");
  return { emails: body.emails.map(parseFeedNewsletter), nextCursor: (body.nextCursor as string | null | undefined) ?? null };
}

/** Store one page (one row per producer id, never rewritten). Returns how many were new. */
export async function storeNewsletterSends(emails: FeedNewsletter[]): Promise<number> {
  if (emails.length === 0) return 0;
  const rows = emails.map((e) => ({
    id: e.id,
    releaseId: e.releaseId,
    listSlug: e.listSlug,
    recipientEmail: normalizeEmail(e.recipientEmail) ?? e.recipientEmail.trim().toLowerCase(),
    orgId: e.orgId,
    brandIds: e.brandIds,
    fromAddress: stripNul(e.from),
    subject: stripNul(e.subject)!,
    sentAt: new Date(e.sentAt),
  }));
  // Insert-only, except the producer's statement of WHO sent it (org, brands): a list's brand stated later re-states
  // every past send of it, read again from a reset cursor (`rereadFromStart`).
  const written = (await db
    .insert(newsletterSends)
    .values(rows)
    .onConflictDoUpdate({
      target: newsletterSends.id,
      set: { orgId: sql`excluded.org_id`, brandIds: sql`excluded.brand_ids` },
      setWhere: sql`${newsletterSends.orgId} IS DISTINCT FROM excluded.org_id OR ${newsletterSends.brandIds} IS DISTINCT FROM excluded.brand_ids`,
    })
    .returning({ id: newsletterSends.id, inserted: sql<boolean>`(xmax = 0)` })) as { id: string; inserted: boolean }[];
  return written.filter((w) => w.inserted).length;
}

/** Forget the cursor: the next pass reads the whole feed again (a list's brand was stated after its sends were read). */
export async function rereadFromStart(): Promise<void> {
  await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, NEWSLETTER_FEED));
}

async function saveCursor(cursor: string | null, caughtUp: boolean): Promise<void> {
  await db
    .insert(calendarFeedCursors)
    .values({ feed: NEWSLETTER_FEED, cursor, caughtUpAt: caughtUp ? new Date() : null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: calendarFeedCursors.feed,
      set: { cursor, updatedAt: new Date(), ...(caughtUp ? { caughtUpAt: new Date() } : {}) },
    });
}

export interface NewsletterPassResult {
  pages: number;
  read: number;
  stored: number;
  /** Rows read that name no brand: filed nowhere (logged). */
  noBrand: number;
  caughtUp: boolean;
  cursor: string | null;
}

/** One pass: read the feed from the stored cursor to its end (bounded); the cursor only moves over settled pages. */
export async function runNewsletterPass(now: number = Date.now()): Promise<NewsletterPassResult> {
  const [row] = await db.select().from(calendarFeedCursors).where(eq(calendarFeedCursors.feed, NEWSLETTER_FEED));
  let cursor = row?.cursor ?? null;
  let settledCursor = cursor;
  let holding = false;
  let pages = 0;
  let read = 0;
  let stored = 0;
  let caughtUp = false;
  let noBrand = 0;
  while (pages < MAX_PAGES_PER_PASS) {
    const page = await fetchPage(cursor);
    pages++;
    read += page.emails.length;
    noBrand += page.emails.filter((e) => !e.brandIds?.length).length;
    stored += await storeNewsletterSends(page.emails);
    if (page.emails.length === 0) {
      caughtUp = true;
      break;
    }
    const newest = Math.max(...page.emails.map((e) => Date.parse(e.sentAt)));
    if (newest > now - TX_EMAIL_SETTLE_MS) holding = true;
    if (!holding && page.nextCursor) settledCursor = page.nextCursor;
    if (!page.nextCursor || page.nextCursor === cursor) {
      caughtUp = true;
      break;
    }
    cursor = page.nextCursor;
  }
  await saveCursor(settledCursor, caughtUp);
  if (noBrand > 0) {
    console.error(
      `[crm-service][newsletter] ${noBrand} sent newsletter(s) name no brand (release and list both brandless): filed on NO thread. ` +
        "State the list's brand (transactional-email-service PUT /mailing-lists/:slug/brand), then POST /internal/newsletter-sends/watch {reread: true}.",
    );
  }
  return { pages, read, stored, noBrand, caughtUp, cursor: settledCursor };
}

let running = false;

export function startNewsletterWatch(): void {
  if (process.env.NEWSLETTER_SEND_WATCH === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runNewsletterPass()
      .then((r) => {
        if (r.stored > 0) console.log(`[crm-service][newsletter] pass pages=${r.pages} read=${r.read} stored=${r.stored} caughtUp=${r.caughtUp}`);
      })
      .catch((e) => console.error("[crm-service][newsletter] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TX_EMAIL_WATCH_INTERVAL_MS).unref();
  }, 75_000).unref();
}

/** A pass now, unless one runs. */
export async function runNewsletterPassNow(opts: { reread?: boolean } = {}): Promise<NewsletterPassResult | { skipped: "pass_running" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    if (opts.reread) await rereadFromStart();
    return await runNewsletterPass();
  } finally {
    running = false;
  }
}

/** The newsletters this (org, brand) sent these addresses, oldest first. */
export async function readNewsletterThread(orgId: string, brandId: string, emails: string[]): Promise<NewsletterSend[]> {
  const addresses = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length === 0) return [];
  return db
    .select()
    .from(newsletterSends)
    .where(and(inArray(newsletterSends.recipientEmail, addresses), newsletterScopeSql("newsletter_sends", orgId, brandId)))
    .orderBy(asc(newsletterSends.sentAt), asc(newsletterSends.id));
}
