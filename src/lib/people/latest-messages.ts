/**
 * THE LATEST MESSAGE OF MANY RELATIONS' THREADS, IN ONE READ (UNIBOX-LAST-MESSAGE-PREVIEW-1021).
 *
 * The Unibox lists one row per relation (a human x a company, lead-service's `unibox_rows`) and shows,
 * under the name, the first words of the LAST message of that row's thread, who wrote it, the channel
 * and when. The thread is ours (`GET /orgs/people/timeline?relationKey=`); reading it whole per row is
 * one heavy read per row, so this answers the latest MESSAGE of each relation, for a batch of up to
 * `LATEST_MESSAGES_MAX_RELATIONS`, from what the service already stores and nothing else:
 *
 *   - gmail, instantly  the message store (`people_message_texts`, kept warm by the freshness watch
 *                       and every timeline read), read over the relation's addresses, like the timeline
 *   - matrix            our own mirror: the relation's DM conversations, and the words the person
 *                       wrote in a group (same items as the timeline's `matrixItems`)
 *   - copilot, api, transactional   the staff Unibox scope only, matched on the relation's addresses
 *                       (transactional = every email the platform sent them, TX-EMAIL-IN-UNIBOX-1024)
 *
 * Events (CRM steps, visits, payments, signups) are not messages and never answer. No sibling is
 * called: a store that lags a few minutes is accepted by the caller. The thread's own total order
 * decides "latest" (date, then the item's identity); an undated message answers only when the
 * relation holds no dated one.
 *
 * Never an empty answer posing as "no message": each relation states one status:
 *   message     the latest message (and `gaps`: a stored thread of the relation that could not be
 *               read or was never read yet, so a newer message may exist there)
 *   no_message  every thread the relation calls for was read and holds no message
 *   unreadable  no message found AND some thread could not be read / was never read (`gaps`)
 *   unknown     the key is not a relation of this (org, brand) (`reason`)
 */
import { ownSenderSql } from "../matrix/own-senders.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCalls, copilotMessages, people, transactionalEmails, peopleMessageUnits, peopleScopes, personIdAliases, type Person } from "../../db/schema.js";
import { API_SENDER_NAME, describeResponse } from "../api-calls/calls.js";
import { COPILOT_CHANNEL, COPILOT_SENDER_NAME, isCopilotDestination } from "../copilot/messages.js";
import { TX_EMAIL_CHANNEL, TX_EMAIL_SENDER_NAME } from "../transactional/sent-emails.js";
import { readVoiceTranscripts, voiceNoteText } from "../matrix/voice-notes.js";
import type { BuildSummary } from "./build.js";
import { presenceStableKey } from "./facts.js";
import type { Presence } from "./identity.js";
import { personIdOfRelationKey, type PersonRelation } from "./relations.js";

export const LATEST_MESSAGES_MAX_RELATIONS = 1000;
/** The preview's text is bounded to this many characters (code points); `textTruncated` says when cut. */
export const LATEST_MESSAGE_TEXT_MAX = 500;
const MAX_ALIAS_HOPS = 10;

export const LATEST_MESSAGE_STATUSES = ["message", "no_message", "unreadable", "unknown"] as const;
export type LatestMessageStatus = (typeof LATEST_MESSAGE_STATUSES)[number];

export const UNKNOWN_REASONS = ["not_a_relation_key", "scope_not_built", "person_not_found", "relation_not_found"] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export const GAP_REASONS = ["read_failed", "not_read_yet"] as const;
export interface LatestMessageGap {
  source: "gmail" | "instantly";
  address: string;
  reason: (typeof GAP_REASONS)[number];
  /** The source's own error on a failed read; null otherwise. */
  error: string | null;
}

/**
 * How `text` was derived. cleaned = the sender's own words (Gmail, google-service cleaned it);
 * original = the body as stored, quoted history and signature included when the source sent them
 * (cold email, Gmail not cleaned); snippet = Gmail's snippet (the body was not fetched); as_written =
 * a chat message (WhatsApp, Telegram, Discord, Copilot), or a voice note's transcript; summary = our
 * one-line description of an API / MCP call or of its answer. A transactional email is `original` (its
 * text part, else the words of its HTML).
 */
export const TEXT_BASES = ["cleaned", "original", "snippet", "as_written", "summary"] as const;
export type TextBasis = (typeof TEXT_BASES)[number];

export interface LatestMessage {
  at: string | null;
  source: "gmail" | "instantly" | "matrix" | "copilot" | "api" | "transactional";
  /** email | whatsapp | telegram | discord | chat | api | mcp */
  channel: string;
  /** inbound = the person wrote; outbound = the brand did. */
  direction: "inbound" | "outbound" | "other";
  /**
   * Outbound only (null inbound): automation = one of our machines (a cold-email sequence step,
   * an automated WhatsApp send, the Copilot, the API); person = a human of the brand typed it
   * (a WhatsApp / Telegram message from the brand's own account that is none of our automated
   * sends); null = the source does not say (a Gmail send, a cold-email send tied to no sequence step).
   */
  sentBy: "person" | "automation" | null;
  subject: string | null;
  text: string | null;
  textBasis: TextBasis | null;
  /** Gmail only: google-service's `bodyCleanStatus`, verbatim; null elsewhere. */
  textCleanStatus: string | null;
  textTruncated: boolean;
  from: string | null;
  /** The source's own ids (thread, message, campaign, room, event, call), as the timeline item's `ref`. */
  ref: Record<string, string | null>;
}

export interface RelationLatestMessage {
  relationKey: string;
  status: LatestMessageStatus;
  /** unknown: why (UNKNOWN_REASONS); unreadable: `source_unreadable`; else null. */
  reason: string | null;
  message: LatestMessage | null;
  gaps: LatestMessageGap[];
}

export interface LatestMessagesAnswer {
  scope: { id: string; status: string; lastBuiltAt: string | null } | null;
  relations: RelationLatestMessage[];
  counts: Record<LatestMessageStatus, number>;
}

// ─── pure ───────────────────────────────────────────────────────────────────

export interface Candidate {
  /** epoch ms; null = undated. */
  at: number | null;
  /** The item's identity in the thread (tie-break, like the timeline's itemKey). */
  key: string;
  message: LatestMessage;
}

/** PURE: the thread's latest: the newest dated message, ties broken by identity; undated only when nothing is dated. */
export function latestOf(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    if (best.at === null && c.at !== null) best = c;
    else if (best.at !== null && c.at === null) continue;
    else if (c.at !== best.at) {
      if ((c.at as number) > (best.at as number)) best = c;
    } else if (c.key > best.key) best = c;
  }
  return best;
}

/** PURE: the first `max` code points (never a lone surrogate), and whether it was cut. */
export function clipText(text: string | null, max = LATEST_MESSAGE_TEXT_MAX): { text: string | null; truncated: boolean } {
  if (text === null) return { text: null, truncated: false };
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max).join(""), truncated: true };
}

/** PURE: the status a relation answers, from its latest message and its store gaps. */
export function relationStatus(latest: LatestMessage | null, gaps: LatestMessageGap[]): Pick<RelationLatestMessage, "status" | "reason"> {
  if (latest) return { status: "message", reason: null };
  if (gaps.length) return { status: "unreadable", reason: "source_unreadable" };
  return { status: "no_message", reason: null };
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const ms = (d: Date | string | null): number | null => {
  if (d === null) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
};

// ─── the read ───────────────────────────────────────────────────────────────

interface Resolved {
  relationKey: string;
  person: Person;
  relation: PersonRelation;
  presences: Presence[];
}

/** The people holding these person ids (a retired id follows its aliases, like `findPersonById`). */
async function peopleByIds(orgId: string, brandId: string, ids: string[]): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  if (ids.length === 0) return out;
  // asked id -> id being looked up now
  let pending = new Map(ids.map((id) => [id, id]));
  for (let hop = 0; hop <= MAX_ALIAS_HOPS && pending.size; hop++) {
    const lookups = [...new Set(pending.values())];
    const rows = await db
      .select()
      .from(people)
      .where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), inArray(people.personId, lookups)));
    const byId = new Map(rows.map((r) => [r.personId as string, r]));
    const next = new Map<string, string>();
    const missing: string[] = [];
    for (const [asked, now] of pending) {
      const p = byId.get(now);
      if (p) out.set(asked, p);
      else missing.push(asked);
    }
    if (missing.length === 0) break;
    const aliasOf = new Map(
      (
        await db
          .select({ retiredId: personIdAliases.retiredId, personId: personIdAliases.personId })
          .from(personIdAliases)
          .where(
            and(
              eq(personIdAliases.orgId, orgId),
              eq(personIdAliases.brandId, brandId),
              inArray(personIdAliases.retiredId, [...new Set(missing.map((a) => pending.get(a)!))]),
            ),
          )
      ).map((a) => [a.retiredId, a.personId]),
    );
    for (const asked of missing) {
      const to = aliasOf.get(pending.get(asked)!);
      if (to && to !== pending.get(asked)) next.set(asked, to);
    }
    pending = next;
  }
  return out;
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

interface StoreRow {
  address: string;
  source: "gmail" | "instantly";
  message_key: string;
  at: Date | string | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
  channel: string | null;
  from_addr: string | null;
  ref: Record<string, string | null> | null;
  text_clean: { status?: string; cleaned?: boolean } | null;
  outreach_fact: unknown;
}

/** The latest stored Gmail / cold-email message per address (gmail only when Gmail is connected). */
async function latestStoredPerAddress(scopeId: string, addresses: string[], gmailConnected: boolean): Promise<Map<string, StoreRow>> {
  const out = new Map<string, StoreRow>();
  for (const part of chunks(addresses, 1000)) {
    // Two steps: the winner of each address is picked on narrow columns (no stored item / body read),
    // then only the winners' heavy columns are read. Read whole in one step, 392 addresses took 1.95 s
    // on prod (every stored item detoasted before the DISTINCT ON); in two, 1,000 took 1.4 s cold.
    const rows = (await db.execute(sql`
      WITH winners AS (
        SELECT DISTINCT ON (address) id
        FROM people_message_texts
        WHERE scope_id = ${scopeId}
          AND address IN (${sql.join(part.map((a) => sql`${a}`), sql`, `)})
          ${gmailConnected ? sql`` : sql`AND source <> 'gmail'`}
        ORDER BY address, at DESC NULLS LAST, source DESC, message_key DESC
      )
      SELECT t.address, t.source, t.message_key, t.at, t.direction, t.subject,
        left(t.body, ${LATEST_MESSAGE_TEXT_MAX * 4}) AS body,
        t.item->>'channel' AS channel, t.item->>'from' AS from_addr, t.item->'ref' AS ref,
        t.item->'textClean' AS text_clean, t.item->'outreachFact' AS outreach_fact
      FROM people_message_texts t
      WHERE t.id IN (SELECT id FROM winners)
    `)) as unknown as StoreRow[];
    for (const r of rows) out.set(r.address, r);
  }
  return out;
}

function storeCandidate(r: StoreRow): Candidate {
  const gmail = r.source === "gmail";
  const outbound = r.direction === "outbound";
  const bodyStatus = r.ref?.bodyStatus ?? null;
  const textBasis: TextBasis | null =
    r.body === null ? null : gmail ? (bodyStatus !== null && bodyStatus !== "ok" ? "snippet" : r.text_clean?.cleaned ? "cleaned" : "original") : "original";
  const clipped = clipText(r.body);
  return {
    at: ms(r.at),
    key: `${r.source}|${r.message_key}`,
    message: {
      at: iso(r.at),
      source: r.source,
      channel: r.channel ?? "email",
      direction: (r.direction as LatestMessage["direction"]) ?? "other",
      sentBy: outbound && !gmail && r.outreach_fact ? "automation" : null,
      subject: r.subject,
      text: clipped.text,
      textBasis,
      textCleanStatus: gmail ? (r.text_clean?.status ?? null) : null,
      textTruncated: clipped.truncated,
      from: r.from_addr,
      ref: r.ref ?? {},
    },
  };
}

interface MatrixRow {
  conversation_id: string | null;
  group_room_id: string | null;
  channel: string;
  own_mxid: string | null;
  /** The sender is the connection's account or its self-ghost (OLIVE-TG-SELF-GHOST-1029); null in a group read. */
  own_sent: boolean | null;
  event_id: string;
  room_id: string;
  sender: string;
  origin_server_ts: Date | string;
  body: unknown;
}

/** The latest `m.room.message` of each DM conversation (the timeline's matrix items, latest only). */
async function latestOfConversations(conversationIds: string[]): Promise<Map<string, MatrixRow>> {
  const out = new Map<string, MatrixRow>();
  for (const part of chunks(conversationIds, 1000)) {
    const rows = (await db.execute(sql`
      SELECT c.id AS conversation_id, NULL AS group_room_id, c.channel, m.matrix_user_id AS own_mxid,
             ${ownSenderSql(sql`e.sender`, sql`c.connection_id`)} AS own_sent,
             e.event_id, e.room_id, e.sender, e.origin_server_ts, e.payload->'content'->'body' AS body
      FROM conversations c
      JOIN matrix_connections m ON m.id = c.connection_id
      CROSS JOIN LATERAL (
        SELECT event_id, room_id, sender, origin_server_ts, payload
        FROM matrix_raw_events
        WHERE connection_id = c.connection_id AND room_id = c.room_id AND event_type = 'm.room.message'
        ORDER BY origin_server_ts DESC, event_id DESC
        LIMIT 1
      ) e
      WHERE c.id IN (${sql.join(part.map((id) => sql`${id}`), sql`, `)})
    `)) as unknown as MatrixRow[];
    for (const r of rows) out.set(r.conversation_id!, r);
  }
  return out;
}

/** The latest message a handle wrote in each of these group rooms. Key `room|handle`. */
async function latestInGroups(pairs: { roomId: string; handle: string; channel: string }[]): Promise<Map<string, MatrixRow>> {
  const out = new Map<string, MatrixRow>();
  for (const part of chunks(pairs, 500)) {
    const rows = (await db.execute(sql`
      SELECT NULL AS conversation_id, p.room_id AS group_room_id, p.channel, NULL AS own_mxid, NULL::boolean AS own_sent,
             e.event_id, e.room_id, e.sender, e.origin_server_ts, e.payload->'content'->'body' AS body
      FROM (VALUES ${sql.join(part.map((p) => sql`(${p.roomId}, ${p.handle}, ${p.channel})`), sql`, `)}) AS p(room_id, handle, channel)
      CROSS JOIN LATERAL (
        SELECT event_id, room_id, sender, origin_server_ts, payload
        FROM matrix_raw_events
        WHERE room_id = p.room_id AND sender = p.handle AND event_type = 'm.room.message'
        ORDER BY origin_server_ts DESC, event_id DESC
        LIMIT 1
      ) e
    `)) as unknown as MatrixRow[];
    for (const r of rows) out.set(`${r.group_room_id}|${r.sender}`, r);
  }
  return out;
}

/** Which of these outbound events are our automated WhatsApp sends (by event id, else same room + text). */
async function automatedSends(orgId: string, brandId: string, rows: MatrixRow[]): Promise<Set<string>> {
  const auto = new Set<string>();
  if (rows.length === 0) return auto;
  const sends = (await db.execute(sql`
    SELECT event_id, room_id, text FROM whatsapp_sends
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
      AND (event_id IN (${sql.join(rows.map((r) => sql`${r.event_id}`), sql`, `)})
        OR room_id IN (${sql.join([...new Set(rows.map((r) => r.room_id))].map((x) => sql`${x}`), sql`, `)}))
  `)) as unknown as { event_id: string | null; room_id: string | null; text: string }[];
  const ids = new Set(sends.map((s) => s.event_id).filter((x): x is string => !!x));
  const texts = new Set(sends.map((s) => `${s.room_id}|${s.text.trim()}`));
  for (const r of rows) {
    const body = typeof r.body === "string" ? r.body.trim() : "";
    if (ids.has(r.event_id) || (body && texts.has(`${r.room_id}|${body}`))) auto.add(r.event_id);
  }
  return auto;
}

function matrixCandidate(r: MatrixRow, subject: string | null, auto: Set<string>, voice: Map<string, string>): Candidate {
  const outbound = r.own_sent === true;
  const raw = typeof r.body === "string" ? r.body : null;
  const words = raw && raw.trim() ? raw : (voice.get(r.event_id) ?? raw);
  const clipped = clipText(words);
  const ref: Record<string, string | null> = r.conversation_id
    ? { eventId: r.event_id, roomId: r.room_id, conversationId: r.conversation_id }
    : { eventId: r.event_id, roomId: r.room_id, groupRoomId: r.room_id };
  return {
    at: ms(r.origin_server_ts),
    key: `matrix|${r.event_id}`,
    message: {
      at: iso(r.origin_server_ts),
      source: "matrix",
      channel: r.channel,
      direction: outbound ? "outbound" : "inbound",
      sentBy: outbound ? (auto.has(r.event_id) ? "automation" : "person") : null,
      subject,
      text: clipped.text,
      textBasis: clipped.text === null ? null : "as_written",
      textCleanStatus: null,
      textTruncated: clipped.truncated,
      from: r.sender,
      ref,
    },
  };
}

/** The latest Copilot turn per address (staff Unibox scope only). */
async function latestCopilot(orgId: string, brandId: string, emails: string[]): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  for (const part of chunks(emails, 1000)) {
    const rows = await db
      .selectDistinctOn([copilotMessages.email])
      .from(copilotMessages)
      .where(and(eq(copilotMessages.orgId, orgId), eq(copilotMessages.brandId, brandId), inArray(copilotMessages.email, part)))
      .orderBy(
        copilotMessages.email,
        sql`${copilotMessages.sentAt} DESC`,
        sql`CASE ${copilotMessages.role} WHEN 'user' THEN 0 ELSE 1 END DESC`,
        sql`${copilotMessages.id} DESC`,
      );
    for (const m of rows) {
      const inbound = m.role === "user";
      const clipped = clipText(m.text);
      out.set(m.email, {
        at: m.sentAt.getTime(),
        key: `copilot|${m.messageId}`,
        message: {
          at: m.sentAt.toISOString(),
          source: "copilot",
          channel: COPILOT_CHANNEL,
          direction: inbound ? "inbound" : "outbound",
          sentBy: inbound ? null : "automation",
          subject: null,
          text: clipped.text,
          textBasis: "as_written",
          textCleanStatus: null,
          textTruncated: clipped.truncated,
          from: inbound ? m.email : COPILOT_SENDER_NAME,
          ref: { messageId: m.messageId, sessionId: m.sessionId, chatOrgId: m.chatOrgId, chatUserId: m.chatUserId },
        },
      });
    }
  }
  return out;
}

/** The latest API / MCP item per address: the answer of the call answered last (staff Unibox scope only). */
async function latestApiCall(orgId: string, brandId: string, emails: string[]): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  for (const part of chunks(emails, 1000)) {
    const rows = await db
      .selectDistinctOn([apiCalls.email])
      .from(apiCalls)
      .where(and(eq(apiCalls.orgId, orgId), eq(apiCalls.brandId, brandId), inArray(apiCalls.email, part)))
      .orderBy(apiCalls.email, sql`${apiCalls.calledAt} + ${apiCalls.durationMs} * interval '1 millisecond' DESC`, sql`${apiCalls.id} DESC`);
    for (const c of rows) {
      const answeredAt = new Date(c.calledAt.getTime() + c.durationMs);
      const clipped = clipText(describeResponse(c));
      out.set(c.email, {
        at: answeredAt.getTime(),
        key: `api|${c.callId}`,
        message: {
          at: answeredAt.toISOString(),
          source: "api",
          channel: c.channel,
          direction: "outbound",
          sentBy: "automation",
          subject: null,
          text: clipped.text,
          textBasis: "summary",
          textCleanStatus: null,
          textTruncated: clipped.truncated,
          from: API_SENDER_NAME,
          ref: { callId: c.callId, method: c.method, path: c.path, status: String(c.status), mcpTool: c.mcpTool },
        },
      });
    }
  }
  return out;
}

/** The latest transactional email per address (staff Unibox scope only): an email WE sent, by a machine. */
async function latestTransactional(emails: string[]): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  for (const part of chunks(emails, 1000)) {
    const t = transactionalEmails;
    const rows = await db
      .selectDistinctOn([t.recipientEmail], {
        id: t.id,
        recipientEmail: t.recipientEmail,
        eventType: t.eventType,
        messageSource: t.messageSource,
        fromAddress: t.fromAddress,
        subject: t.subject,
        text: t.text,
        sentAt: t.sentAt,
      })
      .from(t)
      .where(inArray(t.recipientEmail, part))
      .orderBy(t.recipientEmail, sql`${t.sentAt} DESC`, sql`${t.id} DESC`);
    for (const e of rows) {
      const clipped = clipText(e.text);
      out.set(e.recipientEmail, {
        at: e.sentAt.getTime(),
        key: `transactional|${e.id}`,
        message: {
          at: e.sentAt.toISOString(),
          source: "transactional",
          channel: TX_EMAIL_CHANNEL,
          direction: "outbound",
          sentBy: "automation",
          subject: e.subject,
          text: clipped.text,
          textBasis: clipped.text === null ? null : "original",
          textCleanStatus: null,
          textTruncated: clipped.truncated,
          from: e.fromAddress ?? TX_EMAIL_SENDER_NAME,
          ref: { emailId: e.id, eventType: e.eventType, messageSource: e.messageSource },
        },
      });
    }
  }
  return out;
}

const emptyCounts = (): Record<LatestMessageStatus, number> => ({ message: 0, no_message: 0, unreadable: 0, unknown: 0 });

/** The latest message of each relation's thread (one answer per DISTINCT key, in the order asked). */
export async function readLatestMessages(orgId: string, brandId: string, relationKeys: string[]): Promise<LatestMessagesAnswer> {
  const keys = [...new Set(relationKeys)];
  const answers = new Map<string, RelationLatestMessage>();
  const unknown = (relationKey: string, reason: UnknownReason): RelationLatestMessage => ({ relationKey, status: "unknown", reason, message: null, gaps: [] });

  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)))
    .limit(1);
  const finish = (): LatestMessagesAnswer => {
    const relations = keys.map((k) => answers.get(k)!);
    const counts = emptyCounts();
    for (const r of relations) counts[r.status]++;
    return {
      scope: scope ? { id: scope.id, status: scope.status, lastBuiltAt: scope.lastBuiltAt ? scope.lastBuiltAt.toISOString() : null } : null,
      relations,
      counts,
    };
  };

  const personIdOf = new Map<string, string>();
  for (const k of keys) {
    const id = personIdOfRelationKey(k);
    if (!id) answers.set(k, unknown(k, "not_a_relation_key"));
    else personIdOf.set(k, id);
  }
  if (!scope || scope.status === "pending") {
    for (const k of personIdOf.keys()) answers.set(k, unknown(k, "scope_not_built"));
    return finish();
  }

  const persons = await peopleByIds(orgId, brandId, [...new Set(personIdOf.values())]);
  const resolved: Resolved[] = [];
  for (const [k, id] of personIdOf) {
    const person = persons.get(id);
    if (!person) {
      answers.set(k, unknown(k, "person_not_found"));
      continue;
    }
    const relation = ((person.relations as PersonRelation[] | null) ?? []).find((r) => r.relationKey === k);
    if (!relation) {
      answers.set(k, unknown(k, "relation_not_found"));
      continue;
    }
    const points = new Set(relation.contactPoints.map((c) => c.id));
    resolved.push({ relationKey: k, person, relation, presences: (person.presences as Presence[]).filter((p) => points.has(presenceStableKey(p))) });
  }
  if (resolved.length === 0) return finish();

  const reads = scope.sourceReads as BuildSummary | null;
  const connected = (s: string) => reads?.sources.find((r) => r.source === s)?.status !== "not_connected";
  const gmailConnected = connected("gmail");
  const matrixConnected = connected("matrix");
  const staffScope = isCopilotDestination(orgId, brandId);

  const addresses = [...new Set(resolved.flatMap((r) => r.relation.emails.map((e) => e.toLowerCase())))];
  const conversationIds = matrixConnected
    ? [...new Set(resolved.flatMap((r) => r.presences.filter((p) => p.source === "matrix").map((p) => p.detail.conversationId).filter((c): c is string => typeof c === "string")))]
    : [];
  const groupPairs = new Map<string, { roomId: string; handle: string; channel: string; name: string | null }>();
  if (matrixConnected) {
    for (const r of resolved) {
      for (const p of r.presences) {
        if (p.source !== "matrix" || !Array.isArray(p.detail.groups) || typeof p.detail.channelHandle !== "string") continue;
        for (const g of p.detail.groups as { roomId: string; name: string | null; authoredCount?: number }[]) {
          if ((g.authoredCount ?? 0) > 0) groupPairs.set(`${g.roomId}|${p.detail.channelHandle}`, { roomId: g.roomId, handle: p.detail.channelHandle, channel: p.detail.channel as string, name: g.name ?? null });
        }
      }
    }
  }

  const [stored, units, dms, groups, copilot, api, transactional] = await Promise.all([
    addresses.length ? latestStoredPerAddress(scope.id, addresses, gmailConnected) : Promise.resolve(new Map<string, StoreRow>()),
    addresses.length
      ? Promise.all(
          chunks(addresses, 1000).map((part) =>
            db
              .select({ address: peopleMessageUnits.address, source: peopleMessageUnits.source, status: peopleMessageUnits.status, error: peopleMessageUnits.error })
              .from(peopleMessageUnits)
              .where(and(eq(peopleMessageUnits.scopeId, scope.id), inArray(peopleMessageUnits.address, part))),
          ),
        ).then((xs) => xs.flat())
      : Promise.resolve([] as { address: string; source: string; status: string; error: string | null }[]),
    conversationIds.length ? latestOfConversations(conversationIds) : Promise.resolve(new Map<string, MatrixRow>()),
    groupPairs.size ? latestInGroups([...groupPairs.values()]) : Promise.resolve(new Map<string, MatrixRow>()),
    staffScope && addresses.length ? latestCopilot(orgId, brandId, addresses) : Promise.resolve(new Map<string, Candidate>()),
    staffScope && addresses.length ? latestApiCall(orgId, brandId, addresses) : Promise.resolve(new Map<string, Candidate>()),
    staffScope && addresses.length ? latestTransactional(addresses) : Promise.resolve(new Map<string, Candidate>()),
  ]);

  const matrixRows = [...dms.values(), ...groups.values()];
  const outbound = matrixRows.filter((r) => r.own_sent === true);
  const silent = matrixRows.filter((r) => !(typeof r.body === "string" && r.body.trim()));
  const [auto, transcripts] = await Promise.all([automatedSends(orgId, brandId, outbound), readVoiceTranscripts(silent.map((r) => r.event_id))]);
  const voice = new Map([...transcripts].map(([id, t]) => [id, voiceNoteText(t)]));

  const unitsOf = new Map<string, { source: string; status: string; error: string | null }[]>();
  for (const u of units) unitsOf.set(u.address, [...(unitsOf.get(u.address) ?? []), u]);

  for (const r of resolved) {
    const emails = [...new Set(r.relation.emails.map((e) => e.toLowerCase()))];
    const candidates: Candidate[] = [];
    const gaps: LatestMessageGap[] = [];
    for (const address of emails) {
      const s = stored.get(address);
      if (s) candidates.push(storeCandidate(s));
      const c = copilot.get(address);
      if (c) candidates.push(c);
      const a = api.get(address);
      if (a) candidates.push(a);
      const tx = transactional.get(address);
      if (tx) candidates.push(tx);
      // Gaps: a stored thread of the address that failed its last read, or one never read yet.
      const mine = unitsOf.get(address) ?? [];
      for (const u of mine) {
        if (u.status !== "ok" && (u.source === "gmail" ? gmailConnected : true)) {
          gaps.push({ source: u.source as "gmail" | "instantly", address, reason: "read_failed", error: u.error });
        }
      }
      if (gmailConnected && !mine.some((u) => u.source === "gmail")) gaps.push({ source: "gmail", address, reason: "not_read_yet", error: null });
      const coldEmailed = r.presences.some((p) => p.source === "instantly" && p.sourceRef.toLowerCase() === address);
      if (coldEmailed && !mine.some((u) => u.source === "instantly")) gaps.push({ source: "instantly", address, reason: "not_read_yet", error: null });
    }
    for (const p of r.presences) {
      if (p.source !== "matrix") continue;
      const conv = typeof p.detail.conversationId === "string" ? dms.get(p.detail.conversationId) : undefined;
      if (conv) candidates.push(matrixCandidate(conv, null, auto, voice));
      if (typeof p.detail.channelHandle === "string" && Array.isArray(p.detail.groups)) {
        for (const g of p.detail.groups as { roomId: string }[]) {
          const pair = groupPairs.get(`${g.roomId}|${p.detail.channelHandle}`);
          const row = groups.get(`${g.roomId}|${p.detail.channelHandle}`);
          if (pair && row) candidates.push(matrixCandidate(row, pair.name, auto, voice));
        }
      }
    }
    const latest = latestOf(candidates)?.message ?? null;
    answers.set(r.relationKey, { relationKey: r.relationKey, ...relationStatus(latest, gaps), message: latest, gaps });
  }
  return finish();
}
