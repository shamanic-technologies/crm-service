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
import { mapLimit, siblingGet, type SiblingIdentity } from "./siblings.js";

// ─── the index ──────────────────────────────────────────────────────────────

const INDEX_CONCURRENCY = 4;
/** A unit is re-read at least this often even with no new activity (late body cleaning). */
export const UNIT_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Bodies are stored up to this length; a search past it would be a needle in a quoted thread anyway. */
const BODY_MAX = 20_000;

export interface IndexPerson {
  emails: string[];
  presences: Presence[];
  lastActivityAt: Date | null;
}

interface Unit {
  source: "gmail" | "instantly";
  unit: string;
  address: string;
  campaignId: string | null;
  activityAt: Date | null;
}

interface IndexedMessage {
  messageKey: string;
  at: string | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
}

export interface MessageIndexSummary {
  units: number;
  read: number;
  reused: number;
  failed: number;
  dropped: number;
}

/** Every unit the scope's people call for: one per Gmail address, one per (cold-email campaign, address). */
async function unitsOf(scope: PeopleScope, persons: IndexPerson[], gmailConnected: boolean): Promise<Unit[]> {
  const observed = await db
    .select({ email: leadStandingObservations.email, payload: leadStandingObservations.payload })
    .from(leadStandingObservations)
    .where(and(eq(leadStandingObservations.orgId, scope.orgId), eq(leadStandingObservations.brandId, scope.brandId)));
  const leadCampaigns = new Map(
    observed.map((o) => [o.email, ((o.payload as { campaignIds?: string[] } | null)?.campaignIds ?? []) as string[]]),
  );
  const units = new Map<string, Unit>();
  for (const p of persons) {
    for (const email of p.emails) {
      if (gmailConnected) {
        units.set(`gmail|${email}`, { source: "gmail", unit: email, address: email, campaignId: null, activityAt: p.lastActivityAt });
      }
      const campaigns = new Set(leadCampaigns.get(email) ?? []);
      for (const pr of p.presences) {
        if (pr.source === "instantly" && pr.sourceRef === email) {
          for (const c of (pr.detail.campaignIds as string[] | undefined) ?? []) campaigns.add(c);
        }
      }
      for (const c of campaigns) {
        const unit = `${c}:${email}`;
        units.set(`instantly|${unit}`, { source: "instantly", unit, address: email, campaignId: c, activityAt: p.lastActivityAt });
      }
    }
  }
  return [...units.values()];
}

interface GmailConversation {
  threads: {
    messages: {
      gmailMessageId: string;
      direction: string;
      subject: string | null;
      snippet: string | null;
      sentAt: string | null;
      bodyText: string | null;
      bodyStatus: string;
    }[];
  }[];
}

/** One unit's messages, as the timeline would show them. `null` = Gmail is not connected. */
async function readUnit(identity: SiblingIdentity, u: Unit): Promise<IndexedMessage[] | null> {
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
        at: m.sentAt,
        direction: m.direction,
        subject: m.subject,
        body: m.bodyStatus === "ok" ? m.bodyText : m.snippet,
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
  const messages = (r.body as { conversation: { messages: { direction: string; at: string; subject: string; text: string }[] } })
    .conversation.messages;
  // instantly-service gives no message id: position + time + direction is stable for an append-only thread.
  return messages.map((m, i) => ({
    messageKey: `${i}:${m.at}:${m.direction}`,
    at: m.at || null,
    direction: m.direction,
    subject: m.subject || null,
    body: m.text ?? null,
  }));
}

const validDate = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Bring the scope's message index up to date with its people. A unit is read
 * when it was never read, its last read failed, the person's activity moved past
 * what was read, or the read is a day old. Units no longer called for (the
 * person left the scope) are dropped with their messages.
 */
export async function indexScopeMessages(
  scope: PeopleScope,
  persons: IndexPerson[],
  identity: SiblingIdentity,
  gmailConnected: boolean,
): Promise<MessageIndexSummary> {
  const wanted = await unitsOf(scope, persons, gmailConnected);
  const existing = await db.select().from(peopleMessageUnits).where(eq(peopleMessageUnits.scopeId, scope.id));
  const known = new Map(existing.map((e) => [`${e.source}|${e.unit}`, e]));
  const wantedKeys = new Set(wanted.map((u) => `${u.source}|${u.unit}`));

  const stale = existing.filter((e) => !wantedKeys.has(`${e.source}|${e.unit}`));
  for (const e of stale) {
    await db.transaction(async (tx) => {
      await tx
        .delete(peopleMessageTexts)
        .where(and(eq(peopleMessageTexts.scopeId, scope.id), eq(peopleMessageTexts.source, e.source), eq(peopleMessageTexts.unit, e.unit)));
      await tx.delete(peopleMessageUnits).where(eq(peopleMessageUnits.id, e.id));
    });
  }

  const now = Date.now();
  const due = wanted.filter((u) => {
    const k = known.get(`${u.source}|${u.unit}`);
    if (!k || k.status !== "ok") return true;
    if (now - k.indexedAt.getTime() >= UNIT_REFRESH_MS) return true;
    return !!u.activityAt && (!k.activityAt || u.activityAt > k.activityAt);
  });

  let failed = 0;
  let gmailGone = false;
  await mapLimit(due, INDEX_CONCURRENCY, async (u) => {
    if (u.source === "gmail" && gmailGone) return;
    let messages: IndexedMessage[] | null;
    try {
      messages = await readUnit(identity, u);
    } catch (err) {
      failed++;
      await db
        .insert(peopleMessageUnits)
        .values({ scopeId: scope.id, source: u.source, unit: u.unit, address: u.address, activityAt: u.activityAt, status: "failed", error: (err as Error).message, runId: identity.runId })
        .onConflictDoUpdate({
          target: [peopleMessageUnits.scopeId, peopleMessageUnits.source, peopleMessageUnits.unit],
          set: { status: "failed", error: (err as Error).message, indexedAt: new Date(), runId: identity.runId },
        });
      return;
    }
    if (messages === null) {
      gmailGone = true;
      return;
    }
    const seen = new Set<string>();
    const rows = messages
      .filter((m) => (seen.has(m.messageKey) ? false : (seen.add(m.messageKey), true)))
      .map((m) => {
        const body = m.body ? m.body.slice(0, BODY_MAX) : null;
        return {
          scopeId: scope.id,
          source: u.source,
          unit: u.unit,
          address: u.address,
          messageKey: m.messageKey,
          at: validDate(m.at),
          direction: m.direction,
          subject: m.subject,
          body,
          searchText: `${m.subject ?? ""}\n${body ?? ""}`,
        };
      });
    await db.transaction(async (tx) => {
      await tx
        .delete(peopleMessageTexts)
        .where(and(eq(peopleMessageTexts.scopeId, scope.id), eq(peopleMessageTexts.source, u.source), eq(peopleMessageTexts.unit, u.unit)));
      for (let i = 0; i < rows.length; i += 500) await tx.insert(peopleMessageTexts).values(rows.slice(i, i + 500));
      await tx
        .insert(peopleMessageUnits)
        .values({ scopeId: scope.id, source: u.source, unit: u.unit, address: u.address, activityAt: u.activityAt, status: "ok", messages: rows.length, runId: identity.runId })
        .onConflictDoUpdate({
          target: [peopleMessageUnits.scopeId, peopleMessageUnits.source, peopleMessageUnits.unit],
          set: { status: "ok", error: null, activityAt: u.activityAt, messages: rows.length, indexedAt: new Date(), runId: identity.runId },
        });
    });
  });

  return { units: wanted.length, read: due.length, reused: wanted.length - due.length, failed, dropped: stale.length };
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
