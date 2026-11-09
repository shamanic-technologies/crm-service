/**
 * Our SENDING mailboxes as a CRM source (EVERY-PERSON-ON-THE-THREAD-1109): instantly-service serves every message
 * those mailboxes sent or received (`GET /internal/mailbox-messages?after=&limit=`, cross-org, total order on a
 * version seq, a message RE-SERVED with a higher version whenever what is said about it changes). crm-service reads
 * it like every sibling feed: bronze `mailbox_messages` (latest version per id), silver `mailbox_message_people`
 * (every address on it, per brand it is filed on; rules.ts), cursor row `mailbox_messages` in `calendar_feed_cursors`
 * (moves only after its page is stored).
 *
 * Words are kept only for a thread that names someone besides our mailbox and the sequence's lead: a plain cold
 * email and its lead's answers are the cold-email source's conversation already (150k+ bodies copied for nothing
 * otherwise). When a message makes a thread name someone else (Markus answering on Thomas's thread), the thread's
 * earlier messages are re-read once by `threadKey` so the newcomer's Unibox shows the whole thread.
 *
 * A scope whose people moved is rebuilt (`followUp`), so the person, their Jev verdict and their facts follow within
 * a build. Every `MAILBOX_WATCH_INTERVAL_MS` (60 s), first pass 60 s after boot, one at a time; `MAILBOX_WATCH=off`
 * stops it. Reads are free: no run, no cost.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { calendarFeedCursors, mailboxMessagePeople, mailboxMessages, peopleScopes } from "../../db/schema.js";
import { isStaffEmail } from "../owner-telegram.js";
import { messagePeople, namesSomeoneElse, parseFeedMailboxMessage, type FeedMailboxMessage } from "./rules.js";

export const MAILBOX_FEED = "mailbox_messages";
export const MAILBOX_WATCH_INTERVAL_MS = Number(process.env.MAILBOX_WATCH_INTERVAL_MS) || 60_000;
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_PASS = 40;

/** Postgres refuses NUL in text. */
const stripNul = (s: string | null): string | null => (s === null ? null : s.replace(/\u0000/g, ""));

function service(): { url: string; key: string } {
  const url = process.env.INSTANTLY_SERVICE_URL;
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service][mailbox] INSTANTLY_SERVICE_URL and INSTANTLY_SERVICE_API_KEY are required");
  return { url: url.replace(/\/+$/, ""), key };
}

export interface MailboxFeedPage {
  messages: FeedMailboxMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function getPage(qs: URLSearchParams): Promise<MailboxFeedPage> {
  const { url, key } = service();
  const res = await fetch(`${url}/internal/mailbox-messages?${qs}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`[crm-service][mailbox] instantly-service GET /internal/mailbox-messages answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { messages?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(body?.messages)) throw new Error("[crm-service][mailbox] mailbox-messages feed answered no messages list");
  const next = body.nextCursor === null || body.nextCursor === undefined ? null : String(body.nextCursor);
  return { messages: body.messages.map(parseFeedMailboxMessage), nextCursor: next, hasMore: body.hasMore === true };
}

export const fetchMailboxPage = (cursor: string | null) => getPage(new URLSearchParams({ after: cursor ?? "0", limit: String(PAGE_LIMIT) }));

/** Every message of one thread (latest version each). Null when the producer does not serve the filter (a 400). */
export async function fetchThread(threadKey: string): Promise<FeedMailboxMessage[] | null> {
  const out: FeedMailboxMessage[] = [];
  let after = "0";
  for (let i = 0; i < 20; i++) {
    let page: MailboxFeedPage;
    try {
      page = await getPage(new URLSearchParams({ after, limit: String(PAGE_LIMIT), threadKey }));
    } catch (err) {
      if (/answered 400/.test((err as Error).message)) return null;
      throw err;
    }
    // A producer that ignores the filter would serve other threads: keep the asked one only.
    out.push(...page.messages.filter((m) => m.threadKey === threadKey));
    if (!page.hasMore || !page.nextCursor || page.nextCursor === after) break;
    after = page.nextCursor;
  }
  return out;
}

/** Threads (among `keys`) the registry already keeps the words of: some message of theirs names someone else. */
async function keptThreads(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ threadKey: mailboxMessages.threadKey })
    .from(mailboxMessages)
    .where(and(inArray(mailboxMessages.threadKey, keys), eq(mailboxMessages.textKept, true)));
  return new Set(rows.map((r) => r.threadKey!).filter(Boolean));
}

export interface StoreResult {
  stored: number;
  /** Threads that started naming someone else on this page (their earlier messages get their words back). */
  newlyKeptThreads: string[];
  /** (org, brand) scopes whose people this page moved. */
  scopes: { orgId: string; brandId: string }[];
}

/**
 * Store one page: each message replaces its stored version by id (an older version never overwrites a newer one),
 * and its people rows are rewritten for every brand it is filed on.
 */
export async function storeMailboxMessages(messages: FeedMailboxMessage[], forceKeep: Set<string> = new Set()): Promise<StoreResult> {
  if (messages.length === 0) return { stored: 0, newlyKeptThreads: [], scopes: [] };
  // One row per id: the page's latest version wins.
  const latest = new Map<string, FeedMailboxMessage>();
  for (const m of messages) {
    const prev = latest.get(m.id);
    if (!prev || BigInt(versionNum(m.version)) >= BigInt(versionNum(prev.version))) latest.set(m.id, m);
  }
  const list = [...latest.values()];
  const peopleOf = new Map(list.map((m) => [m.id, messagePeople(m)]));
  const threadKeys = [...new Set(list.map((m) => m.threadKey).filter((k): k is string => !!k))];
  const before = await keptThreads(threadKeys);
  const keptNow = new Set(before);
  for (const m of list) if (m.threadKey && namesSomeoneElse(peopleOf.get(m.id)!)) keptNow.add(m.threadKey);
  for (const k of forceKeep) keptNow.add(k);
  const keep = (m: FeedMailboxMessage) => namesSomeoneElse(peopleOf.get(m.id)!) || (!!m.threadKey && keptNow.has(m.threadKey));

  const scopes = new Map<string, { orgId: string; brandId: string }>();
  let stored = 0;
  await db.transaction(async (tx) => {
    for (const m of list) {
      const kept = keep(m);
      const row = {
        id: m.id,
        version: m.version,
        mailbox: m.mailbox.trim().toLowerCase(),
        direction: m.direction,
        kind: m.kind,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo,
        references: m.references,
        threadKey: m.threadKey,
        occurredAt: new Date(m.occurredAt),
        subject: stripNul(m.subject),
        fromAddress: m.from?.address.trim().toLowerCase() ?? null,
        fromName: stripNul(m.from?.name ?? null),
        recipients: { to: m.to, cc: m.cc, bcc: m.bcc },
        participants: m.participants,
        text: kept ? stripNul(m.text) : null,
        textKept: kept,
        textUnavailableReason: kept ? m.textUnavailableReason : "not_kept_lead_only_thread",
        sentBy: m.sentBy,
        orgId: m.orgId,
        brandIds: m.brandIds,
        campaignId: m.campaignId,
        instantlyCampaignId: m.instantlyCampaignId,
        leadEmail: m.leadEmail?.trim().toLowerCase() ?? null,
        updatedAt: new Date(),
      };
      const written = await tx
        .insert(mailboxMessages)
        .values(row)
        .onConflictDoUpdate({
          target: mailboxMessages.id,
          set: row,
          // Never step back to an older version (a page re-read out of order).
          setWhere: sql`${mailboxMessages.version}::numeric <= ${versionNum(m.version)}::numeric`,
        })
        .returning({ id: mailboxMessages.id });
      if (written.length === 0) continue;
      stored++;
      await tx.delete(mailboxMessagePeople).where(eq(mailboxMessagePeople.messageId, m.id));
      if (!m.orgId || m.brandIds.length === 0) continue;
      // The sequence's own lead is the cold-email source's: only the others are people of this source.
      const people = peopleOf.get(m.id)!.filter((p) => !p.sequenceLead);
      if (people.length === 0) continue;
      for (const brandId of m.brandIds) {
        scopes.set(`${m.orgId}|${brandId}`, { orgId: m.orgId, brandId });
        await tx.insert(mailboxMessagePeople).values(
          people.map((p) => ({
            messageId: m.id,
            orgId: m.orgId!,
            brandId,
            address: p.address,
            name: stripNul(p.name),
            role: p.role,
            sequenceLead: p.sequenceLead,
            threadKey: m.threadKey,
            occurredAt: new Date(m.occurredAt),
          })),
        );
      }
    }
  });
  const newlyKeptThreads = [...keptNow].filter((k) => !before.has(k) && !forceKeep.has(k));
  return { stored, newlyKeptThreads, scopes: [...scopes.values()] };
}

/** PURE: the version as an integer string ("0042" -> "42"); a non-numeric version is refused loud. */
export function versionNum(v: string): string {
  if (!/^\d+$/.test(v)) throw new Error(`[crm-service][mailbox] version ${JSON.stringify(v)} is not a sequence number`);
  return v.replace(/^0+(?=\d)/, "");
}

/** A thread just started naming someone else: its earlier messages get their words (one read per thread). */
async function fillThreads(keys: string[]): Promise<{ filled: number; unsupported: boolean }> {
  let filled = 0;
  for (const key of keys) {
    const thread = await fetchThread(key);
    if (thread === null) return { filled, unsupported: true };
    const r = await storeMailboxMessages(thread, new Set([key]));
    filled += r.stored;
  }
  return { filled, unsupported: false };
}

async function saveCursor(cursor: string | null, caughtUp: boolean): Promise<void> {
  await db
    .insert(calendarFeedCursors)
    .values({ feed: MAILBOX_FEED, cursor, caughtUpAt: caughtUp ? new Date() : null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: calendarFeedCursors.feed,
      set: { cursor, updatedAt: new Date(), ...(caughtUp ? { caughtUpAt: new Date() } : {}) },
    });
}

export interface MailboxPassResult {
  pages: number;
  read: number;
  stored: number;
  threadsFilled: number;
  caughtUp: boolean;
  scopes: { orgId: string; brandId: string }[];
  cursor: string | null;
  /** Brands whose people scope this pass opened (it did not exist yet). */
  scopesOpened: number;
}

/** One pass: the feed from the stored cursor to its end (bounded), then a rebuild of every scope whose people moved. */
export async function runMailboxPass(
  rebuild: (scope: { orgId: string; brandId: string }) => Promise<void> = kickScopeBuild,
  openScopes: () => Promise<{ opened: number; failed: number }> = openMissingScopes,
): Promise<MailboxPassResult> {
  const [row] = await db.select().from(calendarFeedCursors).where(eq(calendarFeedCursors.feed, MAILBOX_FEED));
  let cursor = row?.cursor ?? null;
  let pages = 0;
  let read = 0;
  let stored = 0;
  let threadsFilled = 0;
  let caughtUp = false;
  const scopes = new Map<string, { orgId: string; brandId: string }>();
  while (pages < MAX_PAGES_PER_PASS) {
    const page = await fetchMailboxPage(cursor);
    pages++;
    read += page.messages.length;
    const r = await storeMailboxMessages(page.messages);
    stored += r.stored;
    for (const s of r.scopes) scopes.set(`${s.orgId}|${s.brandId}`, s);
    if (r.newlyKeptThreads.length) {
      const f = await fillThreads(r.newlyKeptThreads);
      threadsFilled += f.filled;
      if (f.unsupported) console.warn("[crm-service][mailbox] the feed serves no threadKey filter yet: earlier messages of a newly kept thread keep no words");
    }
    if (page.nextCursor) cursor = page.nextCursor;
    await saveCursor(cursor, !page.hasMore);
    if (!page.hasMore || page.messages.length === 0) {
      caughtUp = true;
      break;
    }
  }
  for (const s of scopes.values()) {
    await rebuild(s).catch((err) => console.error(`[crm-service][mailbox] rebuild org=${s.orgId} brand=${s.brandId} failed:`, err));
  }
  const opened = await openScopes();
  return { pages, read, stored, threadsFilled, caughtUp, scopes: [...scopes.values()], cursor, scopesOpened: opened.opened };
}

/** Rebuild a brand's people (unawaited). A brand with no people scope yet gets one (see `openMissingScopes`). */
async function kickScopeBuild(s: { orgId: string; brandId: string }): Promise<void> {
  const [scope] = await db.select().from(peopleScopes).where(and(eq(peopleScopes.orgId, s.orgId), eq(peopleScopes.brandId, s.brandId)));
  if (!scope) return; // opened by `openMissingScopes` at the end of the pass, which builds it
  const { runScopeBuild } = await import("../people/build.js");
  void runScopeBuild(scope, { followUp: true }).catch((err) => console.error(`[crm-service][mailbox] people build scope=${scope.id} failed:`, err));
}

/**
 * PURE: who a scope the registry opens on its own is filed under (its org runs, its Jev calls): a member of the org
 * (client-service's order: last active first), a client's own member before our staff who set the org up.
 */
export function scopeCreatorOf(users: { id?: unknown; email?: unknown }[]): string | null {
  const withId = users.filter((u): u is { id: string; email?: unknown } => typeof u.id === "string" && u.id.length > 0);
  const client = withId.find((u) => !isStaffEmail(typeof u.email === "string" ? u.email : null));
  return (client ?? withId[0])?.id ?? null;
}

async function orgMemberId(orgId: string): Promise<string | null> {
  const url = process.env.CLIENT_SERVICE_URL;
  const key = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service][mailbox] CLIENT_SERVICE_URL and CLIENT_SERVICE_API_KEY are required to open a people scope");
  const res = await fetch(`${url.replace(/\/+$/, "")}/internal/users?orgId=${encodeURIComponent(orgId)}&allMembers=true`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`client-service GET /internal/users answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { users?: { id?: unknown; email?: unknown }[] };
  if (!Array.isArray(body?.users)) throw new Error("client-service GET /internal/users answered no users list");
  return scopeCreatorOf(body.users);
}

/**
 * A person on our sending mailboxes is a person of the brand whether or not anyone opened its people list yet
 * (EVERY-PERSON-ON-THE-THREAD-1109: Living Vital's scope did not exist, so Markus was mirrored and never built).
 * Every brand holding such a person and no scope gets one, filed under a member of its org, and is built. A brand
 * whose org has no member readable stays unopened (logged) and is asked again next pass.
 */
export async function openMissingScopes(): Promise<{ opened: number; failed: number }> {
  const missing = (await db.execute(sql`
    SELECT DISTINCT p.org_id, p.brand_id FROM mailbox_message_people p
    WHERE NOT p.sequence_lead
      AND NOT EXISTS (SELECT 1 FROM people_scopes s WHERE s.org_id = p.org_id AND s.brand_id = p.brand_id)
  `)) as unknown as { org_id: string; brand_id: string }[];
  let opened = 0;
  let failed = 0;
  const { ensureScope, runScopeBuild } = await import("../people/build.js");
  for (const m of missing) {
    try {
      const userId = await orgMemberId(m.org_id);
      if (!userId) {
        console.warn(`[crm-service][mailbox] org=${m.org_id} brand=${m.brand_id}: no member to open its people scope under`);
        failed++;
        continue;
      }
      const { scope, created } = await ensureScope(m.org_id, m.brand_id, userId);
      if (created) {
        opened++;
        void runScopeBuild(scope, { followUp: true }).catch((err) => console.error(`[crm-service][mailbox] people build scope=${scope.id} failed:`, err));
      }
    } catch (err) {
      failed++;
      console.error(`[crm-service][mailbox] opening the people scope of org=${m.org_id} brand=${m.brand_id} failed:`, err);
    }
  }
  return { opened, failed };
}

let running = false;

export function startMailboxWatch(): void {
  if (process.env.MAILBOX_WATCH === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runMailboxPass()
      .then((r) => {
        if (r.stored > 0) console.log(`[crm-service][mailbox] pass pages=${r.pages} read=${r.read} stored=${r.stored} filled=${r.threadsFilled} scopes=${r.scopes.length} caughtUp=${r.caughtUp}`);
      })
      .catch((e) => console.error("[crm-service][mailbox] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, MAILBOX_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}

/** A pass now, unless one runs. */
export async function runMailboxPassNow(): Promise<MailboxPassResult | { skipped: "pass_running" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    return await runMailboxPass();
  } finally {
    running = false;
  }
}
