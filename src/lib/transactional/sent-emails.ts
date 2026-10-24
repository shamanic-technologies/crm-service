/**
 * Every transactional email distribute.you SENT a client, as a conversation SOURCE of the staff
 * Unibox (TX-EMAIL-IN-UNIBOX-1024, owner 2026-10-24: « ça n'annule pas le transactionnel. Mais le
 * transactionnel envoyé doit aussi être ajouté à l'Unibox »).
 *
 * transactional-email-service sends them (dunning, receipts, budget changed, onboarding, campaign
 * created / stopped, positive-reply forwards...) and serves what it SENT on a cursor feed
 * (`GET /internal/sent-emails?after=&limit=`, oldest first, full history). crm-service READS it, like
 * every sibling: bronze `transactional_emails` (one row per producer email id: re-reading a page
 * stores nothing twice), and the person's timeline shows each one as an outbound email FROM US (subject,
 * body, send time) beside the Copilot and the API, so nobody writes a duplicate.
 *
 * Filed like the Copilot (structural privacy): every email is ours to a client of OUR brand, so it is
 * served ONLY under the staff Unibox scope (`COPILOT_UNIBOX_ORG_ID` + `_BRAND_ID`), matched on the
 * recipient address; `orgId` on the feed is the org the send was BILLED to, kept as provenance, never
 * a filing scope. Every eventType goes through the same path, no template is special.
 *
 * Not a people presence (a recipient only WE wrote to brings nobody new in), no fact emitted: the
 * thread and its latest-message preview only. The producer serves sent emails only, never a staff
 * alert; recipients on our own addresses are nobody already (people build), nothing new here.
 *
 * Rows can commit slightly out of sentAt order on the producer: the stored cursor never moves past a
 * page holding an email younger than `TX_EMAIL_SETTLE_MS` (15 min), so the next pass re-reads that tail
 * (dedupe on id) and a late commit is never skipped.
 *
 * Every `TX_EMAIL_WATCH_INTERVAL_MS` (60 s), first pass 60 s after boot, one at a time;
 * `TRANSACTIONAL_EMAIL_WATCH=off` stops it. Reads are free: no run, no cost.
 */

import { asc, eq, getTableColumns, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { calendarFeedCursors, transactionalEmails, type TransactionalEmail } from "../../db/schema.js";
import { isCopilotDestination } from "../copilot/messages.js";
import { normalizeEmail } from "../people/identity.js";

/** The cursor row's name (the feed cursor table is shared by every cursor feed we read). */
export const TX_EMAIL_FEED = "transactional_sent_emails";
export const TX_EMAIL_WATCH_INTERVAL_MS = Number(process.env.TX_EMAIL_WATCH_INTERVAL_MS) || 60_000;
export const TX_EMAIL_SETTLE_MS = Number(process.env.TX_EMAIL_SETTLE_MS) || 15 * 60_000;
/** How the platform is named on a thread when the producer gives no From. */
export const TX_EMAIL_SENDER_NAME = "distribute.you";
export const TX_EMAIL_CHANNEL = "email";
export const TX_EMAIL_MESSAGE_SOURCES = ["stored", "replayed", "unavailable"] as const;
const PAGE_LIMIT = 200;
const MAX_PAGES_PER_PASS = 50;

/** One email as transactional-email-service serves it. */
export interface FeedEmail {
  id: string;
  eventType: string;
  recipientEmail: string;
  orgId: string | null;
  brandIds: string[] | null;
  from: string | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  sentAt: string;
  messageSource: (typeof TX_EMAIL_MESSAGE_SOURCES)[number];
}

export interface FeedPage {
  emails: FeedEmail[];
  nextCursor: string | null;
}

/** Postgres refuses NUL in text. */
const stripNul = (s: string | null): string | null => (s === null ? null : s.replace(/\u0000/g, ""));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** PURE: the readable words of an HTML email (no tags, no styles / scripts, entities decoded, blank runs folded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** PURE: what the thread shows as the email's words: the text part, else the HTML's words, else nothing. */
export function readableBody(e: Pick<FeedEmail, "textBody" | "htmlBody">): string | null {
  if (e.textBody?.trim()) return e.textBody.trim();
  if (e.htmlBody?.trim()) return htmlToText(e.htmlBody) || null;
  return null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown, field: string, id: string): string | null => {
  if (v === null || v === undefined) return null;
  if (!isStr(v)) throw new Error(`[crm-service][tx-email] email ${id}: ${field} is not a string`);
  return v;
};

/** PURE: one feed row, checked; a row missing what the thread needs fails the page loud (never stored half). */
export function parseFeedEmail(raw: unknown): FeedEmail {
  const r = raw as Record<string, unknown>;
  const id = r?.id;
  if (!isStr(id) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`[crm-service][tx-email] feed row without a uuid id: ${JSON.stringify(raw).slice(0, 200)}`);
  if (!isStr(r.recipientEmail) || !r.recipientEmail.includes("@")) throw new Error(`[crm-service][tx-email] email ${id}: no recipientEmail`);
  if (!isStr(r.eventType) || !r.eventType) throw new Error(`[crm-service][tx-email] email ${id}: no eventType`);
  if (!isStr(r.sentAt) || Number.isNaN(Date.parse(r.sentAt))) throw new Error(`[crm-service][tx-email] email ${id}: sentAt is not a date`);
  if (!TX_EMAIL_MESSAGE_SOURCES.includes(r.messageSource as FeedEmail["messageSource"])) {
    throw new Error(`[crm-service][tx-email] email ${id}: messageSource ${JSON.stringify(r.messageSource)} is none of ${TX_EMAIL_MESSAGE_SOURCES.join("|")}`);
  }
  const brandIds = r.brandIds === null || r.brandIds === undefined ? null : r.brandIds;
  if (brandIds !== null && !(Array.isArray(brandIds) && brandIds.every(isStr))) throw new Error(`[crm-service][tx-email] email ${id}: brandIds is not a list of ids`);
  return {
    id,
    eventType: r.eventType,
    recipientEmail: r.recipientEmail,
    orgId: strOrNull(r.orgId, "orgId", id),
    brandIds: brandIds as string[] | null,
    from: strOrNull(r.from, "from", id),
    subject: strOrNull(r.subject, "subject", id),
    textBody: strOrNull(r.textBody, "textBody", id),
    htmlBody: strOrNull(r.htmlBody, "htmlBody", id),
    sentAt: r.sentAt,
    messageSource: r.messageSource as FeedEmail["messageSource"],
  };
}

async function fetchPage(cursor: string | null): Promise<FeedPage> {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const key = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service][tx-email] TRANSACTIONAL_EMAIL_SERVICE_URL and TRANSACTIONAL_EMAIL_SERVICE_API_KEY are required");
  const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) qs.set("after", cursor);
  const res = await fetch(`${url.replace(/\/+$/, "")}/internal/sent-emails?${qs}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`[crm-service][tx-email] transactional-email-service GET /internal/sent-emails answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { emails?: unknown; nextCursor?: unknown };
  if (!Array.isArray(body?.emails)) throw new Error("[crm-service][tx-email] transactional-email-service sent-emails feed answered no emails list");
  if (body.nextCursor !== null && body.nextCursor !== undefined && !isStr(body.nextCursor)) throw new Error("[crm-service][tx-email] nextCursor is not a string");
  return { emails: body.emails.map(parseFeedEmail), nextCursor: (body.nextCursor as string | null | undefined) ?? null };
}

/** Store one page (one row per producer id, never rewritten). Returns how many were new. */
export async function storeSentEmails(emails: FeedEmail[]): Promise<number> {
  if (emails.length === 0) return 0;
  const rows = emails.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    recipientEmail: normalizeEmail(e.recipientEmail) ?? e.recipientEmail.trim().toLowerCase(),
    billedOrgId: e.orgId,
    brandIds: e.brandIds,
    fromAddress: stripNul(e.from),
    subject: stripNul(e.subject),
    text: stripNul(readableBody(e)),
    textBody: stripNul(e.textBody),
    htmlBody: stripNul(e.htmlBody),
    messageSource: e.messageSource,
    sentAt: new Date(e.sentAt),
  }));
  const inserted = await db
    .insert(transactionalEmails)
    .values(rows)
    .onConflictDoNothing({ target: transactionalEmails.id })
    .returning({ id: transactionalEmails.id });
  return inserted.length;
}

async function saveCursor(cursor: string | null, caughtUp: boolean): Promise<void> {
  await db
    .insert(calendarFeedCursors)
    .values({ feed: TX_EMAIL_FEED, cursor, caughtUpAt: caughtUp ? new Date() : null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: calendarFeedCursors.feed,
      set: { cursor, updatedAt: new Date(), ...(caughtUp ? { caughtUpAt: new Date() } : {}) },
    });
}

export interface TxEmailPassResult {
  pages: number;
  read: number;
  stored: number;
  caughtUp: boolean;
  /** The cursor the next pass starts from (held back over the unsettled tail). */
  cursor: string | null;
}

/**
 * One pass: read the feed from the stored cursor to its end (bounded). The stored cursor only moves
 * over pages whose newest email is settled (older than TX_EMAIL_SETTLE_MS): the unsettled tail is read
 * again next pass, so an email the producer commits late is never skipped.
 */
export async function runTxEmailPass(now: number = Date.now()): Promise<TxEmailPassResult> {
  const [row] = await db.select().from(calendarFeedCursors).where(eq(calendarFeedCursors.feed, TX_EMAIL_FEED));
  let cursor = row?.cursor ?? null;
  let settledCursor = cursor;
  let holding = false;
  let pages = 0;
  let read = 0;
  let stored = 0;
  let caughtUp = false;
  while (pages < MAX_PAGES_PER_PASS) {
    const page = await fetchPage(cursor);
    pages++;
    read += page.emails.length;
    stored += await storeSentEmails(page.emails);
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
  return { pages, read, stored, caughtUp, cursor: settledCursor };
}

let running = false;

export function startTxEmailWatch(): void {
  if (process.env.TRANSACTIONAL_EMAIL_WATCH === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runTxEmailPass()
      .then((r) => {
        if (r.stored > 0) console.log(`[crm-service][tx-email] pass pages=${r.pages} read=${r.read} stored=${r.stored} caughtUp=${r.caughtUp}`);
      })
      .catch((e) => console.error("[crm-service][tx-email] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TX_EMAIL_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}

/** A pass now, unless one runs. */
export async function runTxEmailPassNow(): Promise<TxEmailPassResult | { skipped: "pass_running" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    return await runTxEmailPass();
  } finally {
    running = false;
  }
}

/** The emails we sent these addresses, oldest first (empty for any scope but the staff Unibox). Bodies stay in bronze. */
export async function readTxEmailThread(orgId: string, brandId: string, emails: string[]): Promise<TxEmailThreadRow[]> {
  if (!isCopilotDestination(orgId, brandId) || emails.length === 0) return [];
  const { textBody: _t, htmlBody: _h, ...columns } = getTableColumns(transactionalEmails);
  return db
    .select(columns)
    .from(transactionalEmails)
    .where(inArray(transactionalEmails.recipientEmail, emails.map((e) => e.toLowerCase())))
    .orderBy(asc(transactionalEmails.sentAt), asc(transactionalEmails.id));
}

export type TxEmailThreadRow = Omit<TransactionalEmail, "textBody" | "htmlBody">;
