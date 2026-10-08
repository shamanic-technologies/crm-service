/**
 * Searching a brand's people: by who they are (name, any email, any phone,
 * company) AND by what was said with them (message subjects and bodies across
 * Gmail, cold email and WhatsApp / Telegram / Discord).
 *
 * Plain text search, no model: a case-insensitive substring match of the whole
 * query. Names, addresses and companies are on the person row. Message text of
 * the SIBLING sources (Gmail, Instantly) is copied into a search index owned
 * here (`people_message_texts`), refreshed after each people build, unit by
 * unit, only when the person's activity moved (see `indexScopeMessages`).
 * Matrix text is crm-service's own bronze and is searched in place.
 *
 * READ-ONLY toward every source: the index only issues the same GETs the
 * timeline does.
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  conversations,
  leadStandingObservations,
  matrixRawEvents,
  peopleMessageTexts,
  peopleMessageUnits,
  type PeopleScope,
} from "../../db/schema.js";
import type { Presence } from "./identity.js";
import type { TextCleanStatus, TimelineItem } from "./timeline.js";
import { mapLimit, siblingGet, type SiblingIdentity } from "./siblings.js";

// ─── the store ──────────────────────────────────────────────────────────────

const INDEX_CONCURRENCY = 4;
/** A unit is re-read at least this often even with no new activity (late body cleaning). */
export const UNIT_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Bodies are searched up to this length; a match past it would be a needle in a quoted thread anyway. */
const BODY_MAX = 20_000;
/**
 * The stored row shape. 1 = text only (v0.15.0); 2 = the full timeline item
 * rides in `item`. A unit stored in an older format is due for a re-read.
 */
export const STORE_FORMAT = 2;

export interface IndexPerson {
  emails: string[];
  presences: Presence[];
  lastActivityAt: Date | null;
}

export interface Unit {
  source: "gmail" | "instantly";
  unit: string;
  address: string;
  campaignId: string | null;
  activityAt: Date | null;
}

export interface UnitRefreshSummary {
  read: number;
  failed: number;
  /** Gmail answered "not connected": nothing of Gmail was stored. */
  gmailNotConnected: boolean;
}

export interface MessageIndexSummary {
  units: number;
  read: number;
  reused: number;
  failed: number;
  dropped: number;
}

const gmailUnit = (email: string, activityAt: Date | null): Unit => ({
  source: "gmail",
  unit: email,
  address: email,
  campaignId: null,
  activityAt,
});
const instantlyUnit = (campaignId: string, email: string, activityAt: Date | null): Unit => ({
  source: "instantly",
  unit: `${campaignId}:${email}`,
  address: email,
  campaignId,
  activityAt,
});

/** Cold-email campaigns lead-service last reported per address (the build's cache, no call). */
async function cachedLeadCampaigns(scope: PeopleScope, emails?: string[]): Promise<Map<string, string[]>> {
  const observed = await db
    .select({ email: leadStandingObservations.email, payload: leadStandingObservations.payload })
    .from(leadStandingObservations)
    .where(
      and(
        eq(leadStandingObservations.orgId, scope.orgId),
        eq(leadStandingObservations.brandId, scope.brandId),
        emails ? (emails.length ? inArray(leadStandingObservations.email, emails) : sql`false`) : sql`true`,
      ),
    );
  return new Map(
    observed.map((o) => [o.email, ((o.payload as { campaignIds?: string[] } | null)?.campaignIds ?? []) as string[]]),
  );
}

/** Every unit one person calls for: one per Gmail address, one per (cold-email campaign, address). */
function unitsOfPerson(p: IndexPerson, gmailConnected: boolean, leadCampaigns: Map<string, string[]>, extra: Unit[] = []): Unit[] {
  const units = new Map<string, Unit>();
  for (const email of p.emails) {
    if (gmailConnected) units.set(`gmail|${email}`, gmailUnit(email, p.lastActivityAt));
    const campaigns = new Set(leadCampaigns.get(email) ?? []);
    for (const pr of p.presences) {
      if (pr.source === "instantly" && pr.sourceRef === email) {
        for (const c of (pr.detail.campaignIds as string[] | undefined) ?? []) campaigns.add(c);
      }
    }
    for (const c of campaigns) units.set(`instantly|${c}:${email}`, instantlyUnit(c, email, p.lastActivityAt));
  }
  for (const u of extra) if (!units.has(`${u.source}|${u.unit}`)) units.set(`${u.source}|${u.unit}`, { ...u, activityAt: p.lastActivityAt });
  return [...units.values()];
}

interface GmailConversation {
  threads: {
    threadId: string;
    messages: {
      gmailMessageId: string;
      threadId: string;
      direction: "inbound" | "outbound" | "other";
      fromEmail: string | null;
      to: string[];
      subject: string | null;
      snippet: string | null;
      sentAt: string | null;
      bodyText: string | null;
      bodyTextOriginal: string | null;
      bodyStatus: string;
      bodyCleanStatus: TextCleanStatus;
    }[];
  }[];
}

interface InstantlyConversation {
  conversation: {
    campaignId: string;
    messages: {
      direction: "inbound" | "outbound";
      from: string;
      to: string;
      at: string;
      subject: string;
      text: string;
      campaignId: string;
      instantlyCampaignId: string;
    }[];
  };
}

interface StoredMessage {
  messageKey: string;
  item: TimelineItem;
}

/** One unit's messages, as timeline items. `null` = Gmail is not connected. */
async function readUnit(identity: SiblingIdentity, u: Unit): Promise<StoredMessage[] | null> {
  if (u.source === "gmail") {
    const r = await siblingGet("google", `/orgs/google/conversation?email=${encodeURIComponent(u.address)}&limit=500`, identity);
    const reason = (r.body as { reason?: string } | null)?.reason;
    if (r.status === 404 && reason === "no_google_account_connected") return null;
    if (r.status === 404 && reason === "no_messages") return [];
    if (r.status !== 200) {
      throw new Error(`google-service conversation for ${u.address} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    return (r.body as GmailConversation).threads.flatMap((t) =>
      t.messages.map((m) => ({
        messageKey: m.gmailMessageId,
        item: {
          at: m.sentAt,
          source: "gmail" as const,
          channel: "email",
          kind: "message" as const,
          direction: m.direction,
          subject: m.subject,
          text: m.bodyStatus === "ok" ? m.bodyText : m.snippet,
          from: m.fromEmail,
          to: m.to,
          ref: { gmailMessageId: m.gmailMessageId, threadId: m.threadId, bodyStatus: m.bodyStatus },
          textClean: {
            status: m.bodyCleanStatus,
            cleaned: m.bodyStatus === "ok" && m.bodyCleanStatus === "cleaned",
            original: m.bodyTextOriginal,
          },
          event: null,
        },
      })),
    );
  }
  const r = await siblingGet(
    "instantly",
    `/orgs/conversations?campaign_id=${encodeURIComponent(u.campaignId!)}&email=${encodeURIComponent(u.address)}`,
    identity,
  );
  // Documented: no record of that (campaign, lead) — nothing was exchanged there.
  if (r.status === 404) return [];
  if (r.status !== 200) {
    throw new Error(
      `instantly-service conversation ${u.campaignId}/${u.address} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
    );
  }
  // instantly-service gives no message id: position + time + direction is stable for an append-only thread.
  return (r.body as InstantlyConversation).conversation.messages.map((m, i) => ({
    messageKey: `${i}:${m.at}:${m.direction}`,
    item: {
      at: m.at || null,
      source: "instantly" as const,
      channel: "email",
      kind: "message" as const,
      direction: m.direction,
      subject: m.subject || null,
      text: m.text,
      from: m.from,
      to: m.to ? [m.to] : [],
      ref: { campaignId: m.campaignId, instantlyCampaignId: m.instantlyCampaignId },
      textClean: null,
      event: null,
    },
  }));
}

const validDate = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Read the given units from their source and replace what the store holds for each. */
export async function refreshUnits(scopeId: string, units: Unit[], identity: SiblingIdentity): Promise<UnitRefreshSummary> {
  let failed = 0;
  let read = 0;
  let gmailNotConnected = false;
  await mapLimit(units, INDEX_CONCURRENCY, async (u) => {
    if (u.source === "gmail" && gmailNotConnected) return;
    let messages: StoredMessage[] | null;
    try {
      messages = await readUnit(identity, u);
    } catch (err) {
      failed++;
      await db
        .insert(peopleMessageUnits)
        .values({ scopeId, source: u.source, unit: u.unit, address: u.address, activityAt: u.activityAt, status: "failed", error: (err as Error).message, runId: identity.runId, format: STORE_FORMAT })
        .onConflictDoUpdate({
          target: [peopleMessageUnits.scopeId, peopleMessageUnits.source, peopleMessageUnits.unit],
          set: { status: "failed", error: (err as Error).message, indexedAt: new Date(), runId: identity.runId },
        });
      return;
    }
    if (messages === null) {
      gmailNotConnected = true;
      return;
    }
    read++;
    const seen = new Set<string>();
    const rows = messages
      .filter((m) => (seen.has(m.messageKey) ? false : (seen.add(m.messageKey), true)))
      .map((m) => {
        const body = m.item.text ? m.item.text.slice(0, BODY_MAX) : null;
        return {
          scopeId,
          source: u.source,
          unit: u.unit,
          address: u.address,
          messageKey: m.messageKey,
          at: validDate(m.item.at),
          direction: m.item.direction,
          subject: m.item.subject,
          body,
          searchText: `${m.item.subject ?? ""}\n${body ?? ""}`,
          item: m.item,
        };
      });
    await db.transaction(async (tx) => {
      await tx
        .delete(peopleMessageTexts)
        .where(and(eq(peopleMessageTexts.scopeId, scopeId), eq(peopleMessageTexts.source, u.source), eq(peopleMessageTexts.unit, u.unit)));
      for (let i = 0; i < rows.length; i += 500) await tx.insert(peopleMessageTexts).values(rows.slice(i, i + 500));
      await tx
        .insert(peopleMessageUnits)
        .values({ scopeId, source: u.source, unit: u.unit, address: u.address, activityAt: u.activityAt, status: "ok", messages: rows.length, runId: identity.runId, format: STORE_FORMAT })
        .onConflictDoUpdate({
          target: [peopleMessageUnits.scopeId, peopleMessageUnits.source, peopleMessageUnits.unit],
          set: { status: "ok", error: null, activityAt: u.activityAt, messages: rows.length, indexedAt: new Date(), runId: identity.runId, format: STORE_FORMAT },
        });
    });
  });
  return { read, failed, gmailNotConnected };
}

/** Whether a stored unit must be read again. */
export function unitDue(
  u: Unit,
  known: { status: string; indexedAt: Date; activityAt: Date | null; format: number } | undefined,
  now: number,
  maxAgeMs = UNIT_REFRESH_MS,
): boolean {
  if (!known || known.status !== "ok" || known.format < STORE_FORMAT) return true;
  if (now - known.indexedAt.getTime() >= maxAgeMs) return true;
  return !!u.activityAt && (!known.activityAt || u.activityAt > known.activityAt);
}

/**
 * Bring the scope's message store up to date with its people. A unit is read
 * when it was never read, its last read failed, its stored format is older,
 * the person's activity moved past what was read, or the read is a day old.
 * Units no longer called for (the person left the scope) are dropped with
 * their messages.
 */
export async function indexScopeMessages(
  scope: PeopleScope,
  persons: IndexPerson[],
  identity: SiblingIdentity,
  gmailConnected: boolean,
): Promise<MessageIndexSummary> {
  const leadCampaigns = await cachedLeadCampaigns(scope);
  const existing = await db.select().from(peopleMessageUnits).where(eq(peopleMessageUnits.scopeId, scope.id));
  const known = new Map(existing.map((e) => [`${e.source}|${e.unit}`, e]));
  // Instantly units a timeline read discovered (lead-service campaigns the build's cache did not know) stay.
  const discovered = new Map<string, Unit[]>();
  for (const e of existing) {
    if (e.source !== "instantly") continue;
    const [campaignId] = e.unit.split(":");
    discovered.set(e.address, [...(discovered.get(e.address) ?? []), instantlyUnit(campaignId, e.address, null)]);
  }
  const wantedMap = new Map<string, Unit>();
  for (const p of persons) {
    const extra = p.emails.flatMap((e) => discovered.get(e) ?? []);
    for (const u of unitsOfPerson(p, gmailConnected, leadCampaigns, extra)) wantedMap.set(`${u.source}|${u.unit}`, u);
  }
  const wanted = [...wantedMap.values()];

  const stale = existing.filter((e) => !wantedMap.has(`${e.source}|${e.unit}`));
  for (const e of stale) {
    await db.transaction(async (tx) => {
      await tx
        .delete(peopleMessageTexts)
        .where(and(eq(peopleMessageTexts.scopeId, scope.id), eq(peopleMessageTexts.source, e.source), eq(peopleMessageTexts.unit, e.unit)));
      await tx.delete(peopleMessageUnits).where(eq(peopleMessageUnits.id, e.id));
    });
  }

  const now = Date.now();
  const due = wanted.filter((u) => unitDue(u, known.get(`${u.source}|${u.unit}`), now));
  const r = await refreshUnits(scope.id, due, identity);
  return { units: wanted.length, read: due.length, reused: wanted.length - due.length, failed: r.failed, dropped: stale.length };
}

// ─── one person, from the store ─────────────────────────────────────────────

/** A person's stored timeline is re-read in the background once older than this. */
export const TIMELINE_REFRESH_MS = Number(process.env.PEOPLE_TIMELINE_REFRESH_MS) || 60_000;

export interface StoredSource {
  /** ok = served from the store; failed = never read successfully (error). */
  status: "ok" | "empty" | "failed";
  items: TimelineItem[];
  error: string | null;
  asked: string[];
  /** The OLDEST read the served items come from: everything is at least this fresh. */
  readAt: string | null;
}

export interface StoredTimeline {
  gmail: StoredSource;
  instantly: StoredSource;
  /** Units older than TIMELINE_REFRESH_MS (or never read with a lead-service discovery pending). */
  refresh: () => Promise<void>;
  stale: boolean;
}

const refreshing = new Set<string>();

/**
 * One person's Gmail + cold-email messages, from the store. A Gmail address
 * never read yet is read NOW (first read only); everything else is served as
 * stored and, when older than TIMELINE_REFRESH_MS, re-read in the background
 * through `refresh()` (which also asks lead-service for cold-email campaigns
 * the build's cache did not know).
 */
export async function readStoredTimeline(
  scope: PeopleScope,
  person: IndexPerson & { personKey: string },
  gmailConnected: boolean,
  identity: SiblingIdentity,
  discoverCampaigns: (email: string) => Promise<string[]>,
): Promise<StoredTimeline> {
  const leadCampaigns = await cachedLeadCampaigns(scope, person.emails);
  const loadUnits = () =>
    person.emails.length
      ? db
          .select()
          .from(peopleMessageUnits)
          .where(and(eq(peopleMessageUnits.scopeId, scope.id), inArray(peopleMessageUnits.address, person.emails)))
      : Promise.resolve([] as (typeof peopleMessageUnits.$inferSelect)[]);
  let stored = await loadUnits();
  const extra = stored
    .filter((e) => e.source === "instantly")
    .map((e) => instantlyUnit(e.unit.split(":")[0], e.address, null));
  const units = unitsOfPerson(person, gmailConnected, leadCampaigns, extra);

  // A unit never attempted is read now, once. A failed or older-format unit is
  // NOT: it is served as stored and re-read in the background, so one slow
  // mailbox (a 30s timeout) never makes every click wait.
  const known = () => new Map(stored.map((e) => [`${e.source}|${e.unit}`, e]));
  const k0 = known();
  const missing = units.filter((u) => !k0.has(`${u.source}|${u.unit}`));
  if (missing.length) {
    await refreshUnits(scope.id, missing, identity);
    stored = await loadUnits();
  }
  const k1 = known();

  const rows = person.emails.length
    ? await db
        .select({ source: peopleMessageTexts.source, unit: peopleMessageTexts.unit, messageKey: peopleMessageTexts.messageKey, item: peopleMessageTexts.item })
        .from(peopleMessageTexts)
        .where(and(eq(peopleMessageTexts.scopeId, scope.id), inArray(peopleMessageTexts.address, person.emails)))
    : [];

  const sourceOf = (source: "gmail" | "instantly"): StoredSource => {
    const mine = units.filter((u) => u.source === source);
    const asked = mine.map((u) => u.unit);
    const states = mine.map((u) => k1.get(`${u.source}|${u.unit}`)).filter((x): x is NonNullable<typeof x> => !!x);
    const seen = new Set<string>();
    const items: TimelineItem[] = [];
    for (const r of rows) {
      if (r.source !== source || !r.item) continue;
      // A Gmail message to two of the person's addresses is one message.
      const key = source === "gmail" ? r.messageKey : `${r.unit}|${r.messageKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(r.item as TimelineItem);
    }
    const okStates = states.filter((s) => s.status === "ok");
    const failedStates = states.filter((s) => s.status !== "ok");
    const error = failedStates.length ? failedStates.map((s) => s.error).join("; ") : null;
    const readAt = okStates.length ? new Date(Math.min(...okStates.map((s) => s.indexedAt.getTime()))).toISOString() : null;
    if (items.length === 0 && failedStates.length && okStates.length === 0) {
      return { status: "failed", items, error, asked, readAt };
    }
    return { status: items.length ? "ok" : "empty", items, error, asked, readAt };
  };

  const now = Date.now();
  const due = units.filter((u) => unitDue(u, k1.get(`${u.source}|${u.unit}`), now, TIMELINE_REFRESH_MS));
  const key = `${scope.id}|${person.personKey}`;
  const refresh = async () => {
    if (refreshing.has(key)) return;
    refreshing.add(key);
    try {
      const found: Unit[] = [];
      for (const email of person.emails) {
        for (const c of await discoverCampaigns(email)) found.push(instantlyUnit(c, email, person.lastActivityAt));
      }
      const fresh = await loadUnits();
      const kf = new Map(fresh.map((e) => [`${e.source}|${e.unit}`, e]));
      const todo = new Map(due.map((u) => [`${u.source}|${u.unit}`, u]));
      for (const u of found) if (!kf.has(`${u.source}|${u.unit}`)) todo.set(`${u.source}|${u.unit}`, u);
      await refreshUnits(scope.id, [...todo.values()], identity);
    } finally {
      refreshing.delete(key);
    }
  };

  return { gmail: sourceOf("gmail"), instantly: sourceOf("instantly"), refresh, stale: due.length > 0 };
}

/** How complete the index is for a scope, so a search never claims coverage it does not have. */
export async function messageIndexCoverage(scopeId: string) {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS units,
           count(*) FILTER (WHERE status = 'ok')::int AS indexed,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           coalesce(sum(messages), 0)::int AS messages,
           max(indexed_at) AS last_indexed_at
    FROM people_message_units WHERE scope_id = ${scopeId}
  `)) as unknown as { units: number; indexed: number; failed: number; messages: number; last_indexed_at: Date | string | null }[];
  return {
    units: row.units,
    indexed: row.indexed,
    failed: row.failed,
    messages: row.messages,
    lastIndexedAt: row.last_indexed_at ? new Date(row.last_indexed_at).toISOString() : null,
  };
}

// ─── the search ─────────────────────────────────────────────────────────────

export const SEARCH_MAX_LENGTH = 200;
const EXCERPT_RADIUS = 60;
const MESSAGE_MATCHES_PER_PERSON = 3;

/** `q` as an ILIKE pattern: wildcards escaped, matched anywhere. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The query's digits when it reads like a phone fragment (4+ digits, nothing but phone punctuation). */
export function phoneDigits(q: string): string | null {
  if (!/^[\d\s+().-]+$/.test(q)) return null;
  const digits = q.replace(/\D/g, "");
  return digits.length >= 4 ? digits : null;
}

/** A short excerpt of `text` around the first case-insensitive occurrence of `q`. */
export function excerpt(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.slice(0, EXCERPT_RADIUS * 2);
  const start = Math.max(0, i - EXCERPT_RADIUS);
  const end = Math.min(flat.length, i + q.length + EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export interface MessageHit {
  source: "gmail" | "instantly" | "matrix";
  address: string | null;
  conversationId: string | null;
  at: Date | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
  ref: Record<string, string | null>;
}

/**
 * The people of the scope that the query reaches through a MESSAGE: the
 * addresses whose indexed Gmail / cold-email text matches, and the Matrix
 * conversations whose mirrored text matches.
 */
export async function messageMatchKeys(scopeId: string, orgId: string, brandId: string, q: string) {
  const pattern = likePattern(q);
  const addressRows = (await db.execute(sql`
    SELECT DISTINCT address FROM people_message_texts
    WHERE scope_id = ${scopeId} AND search_text ILIKE ${pattern}
  `)) as unknown as { address: string }[];
  const convRows = (await db.execute(sql`
    SELECT DISTINCT c.id::text AS id
    FROM conversations c
    JOIN matrix_raw_events e ON e.connection_id = c.connection_id AND e.room_id = c.room_id
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}
      AND e.event_type = 'm.room.message'
      AND e.payload->'content'->>'body' ILIKE ${pattern}
  `)) as unknown as { id: string }[];
  return { addresses: addressRows.map((r) => r.address), conversationIds: convRows.map((r) => r.id) };
}

/** The WHERE fragment a search adds to the people list. */
export function searchPredicate(q: string, keys: { addresses: string[]; conversationIds: string[] }): SQL {
  const pattern = likePattern(q);
  const digits = phoneDigits(q);
  const parts: SQL[] = [
    sql`people.display_name ILIKE ${pattern}`,
    sql`people.company ILIKE ${pattern}`,
    sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(people.emails) e WHERE e ILIKE ${pattern})`,
    sql`EXISTS (SELECT 1 FROM jsonb_array_elements(people.presences) p WHERE p->>'displayName' ILIKE ${pattern} OR p->>'company' ILIKE ${pattern})`,
  ];
  if (digits) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(people.phones) ph WHERE regexp_replace(ph, '\\D', '', 'g') LIKE ${`%${digits}%`})`,
    );
  }
  if (keys.addresses.length) {
    parts.push(sql`people.emails ?| ${sql`ARRAY[${sql.join(keys.addresses.map((a) => sql`${a}`), sql`, `)}]::text[]`}`);
  }
  if (keys.conversationIds.length) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements(people.presences) p WHERE p->>'source' = 'matrix' AND p->'detail'->>'conversationId' IN (${sql.join(
        keys.conversationIds.map((c) => sql`${c}`),
        sql`, `,
      )}))`,
    );
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** The newest matching messages of the page's people, so the list can say what was said. */
export async function messageHitsFor(
  scopeId: string,
  q: string,
  emails: string[],
  conversationIds: string[],
): Promise<MessageHit[]> {
  const pattern = likePattern(q);
  const hits: MessageHit[] = [];
  if (emails.length) {
    const rows = await db
      .select()
      .from(peopleMessageTexts)
      .where(
        and(
          eq(peopleMessageTexts.scopeId, scopeId),
          inArray(peopleMessageTexts.address, emails),
          sql`${peopleMessageTexts.searchText} ILIKE ${pattern}`,
        ),
      );
    for (const r of rows) {
      const [campaignId] = r.source === "instantly" ? r.unit.split(":") : [null];
      hits.push({
        source: r.source as "gmail" | "instantly",
        address: r.address,
        conversationId: null,
        at: r.at,
        direction: r.direction,
        subject: r.subject,
        body: r.body,
        ref: r.source === "gmail" ? { gmailMessageId: r.messageKey } : { campaignId },
      });
    }
  }
  if (conversationIds.length) {
    const rows = await db
      .select({
        conversationId: conversations.id,
        eventId: matrixRawEvents.eventId,
        roomId: matrixRawEvents.roomId,
        channel: conversations.channel,
        sender: matrixRawEvents.sender,
        at: matrixRawEvents.originServerTs,
        body: sql<string>`${matrixRawEvents.payload}->'content'->>'body'`,
        ownMxid: sql<string>`(SELECT matrix_user_id FROM matrix_connections mc WHERE mc.id = ${conversations.connectionId})`,
      })
      .from(conversations)
      .innerJoin(
        matrixRawEvents,
        and(eq(matrixRawEvents.connectionId, conversations.connectionId), eq(matrixRawEvents.roomId, conversations.roomId)),
      )
      .where(
        and(
          inArray(conversations.id, conversationIds),
          eq(matrixRawEvents.eventType, "m.room.message"),
          sql`${matrixRawEvents.payload}->'content'->>'body' ILIKE ${pattern}`,
        ),
      );
    for (const r of rows) {
      hits.push({
        source: "matrix",
        address: null,
        conversationId: r.conversationId,
        at: r.at,
        direction: r.sender === r.ownMxid ? "outbound" : "inbound",
        subject: null,
        body: r.body,
        ref: { eventId: r.eventId, roomId: r.roomId, conversationId: r.conversationId, channel: r.channel },
      });
    }
  }
  return hits;
}

export type SearchMatch =
  | { field: "name" | "company" | "email" | "phone"; value: string }
  | {
      field: "message";
      source: "gmail" | "instantly" | "matrix";
      at: string | null;
      direction: string | null;
      subject: string | null;
      excerpt: string;
      ref: Record<string, string | null>;
    };

/** Why one person matched: every identity field that holds `q`, then their newest matching messages. */
export function matchesOf(
  person: { displayName: string | null; company: string | null; emails: string[]; phones: string[]; presences: Presence[] },
  q: string,
  hits: MessageHit[],
): { matches: SearchMatch[]; messageMatches: number } {
  const needle = q.toLowerCase();
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);
  const out: SearchMatch[] = [];
  const seen = new Set<string>();
  const push = (field: "name" | "company" | "email" | "phone", value: string) => {
    const k = `${field}|${value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ field, value });
  };
  if (has(person.displayName)) push("name", person.displayName!);
  for (const p of person.presences) if (has(p.displayName)) push("name", p.displayName!);
  if (has(person.company)) push("company", person.company!);
  for (const p of person.presences) if (has(p.company)) push("company", p.company!);
  for (const e of person.emails) if (has(e)) push("email", e);
  const digits = phoneDigits(q);
  if (digits) for (const ph of person.phones) if (ph.replace(/\D/g, "").includes(digits)) push("phone", ph);

  const convIds = new Set(
    person.presences
      .filter((p) => p.source === "matrix" && typeof p.detail.conversationId === "string")
      .map((p) => p.detail.conversationId as string),
  );
  const emails = new Set(person.emails);
  const mine = hits
    .filter((h) => (h.address !== null && emails.has(h.address)) || (h.conversationId !== null && convIds.has(h.conversationId)))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  // A Gmail message sent to two of the person's addresses is one message.
  const unique = mine.filter((h, i) => {
    const key = `${h.source}|${JSON.stringify(h.ref)}|${h.at?.getTime()}`;
    return mine.findIndex((x) => `${x.source}|${JSON.stringify(x.ref)}|${x.at?.getTime()}` === key) === i;
  });
  for (const h of unique.slice(0, MESSAGE_MATCHES_PER_PERSON)) {
    const inSubject = has(h.subject);
    out.push({
      field: "message",
      source: h.source,
      at: h.at?.toISOString() ?? null,
      direction: h.direction,
      subject: h.subject,
      excerpt: inSubject && !has(h.body) ? excerpt(h.subject!, q) : excerpt(h.body ?? h.subject ?? "", q),
      ref: h.ref,
    });
  }
  return { matches: out, messageMatches: unique.length };
}
