/**
 * DID THE BRAND WRITE TO THIS PERSON AFTER T? (UNSENT-ANSWERED-ELSEWHERE-1103)
 *
 * campaign-service's staff Monitoring card "Unsent answers" lists occurrences (a person acted toward a
 * brand) the campaign answered nothing to. It must be red only when the person truly got nothing from us,
 * whoever answered: a campaign run, the AI WhatsApp line, the brand's team typing by hand. The conversation
 * is ours, so this answers, for a batch of people of one (org, brand), each with its own time T: did the
 * brand send that person ANY message after T, any channel, any sender, and when.
 *
 * A person is named by what an occurrence carries, ANY of (all named = one human, their people unioned):
 *   relationKey  a key we served earlier: its person id is read out of it, so a relation rebuilt since
 *                (the person's company changed, a second org relation) or a person merged since (retired
 *                id -> `person_id_aliases`) still resolves
 *   personId     the same, bare
 *   humanId      human-service's id, as served on every fact / people row
 *   email        any address the person holds (identity key)
 *   phone        an E.164 number the person holds, or the WhatsApp ghost the bridge resolved it to
 *
 * Outbound messages read (stored data only: no sibling call, no model, no cost; the stores lag their
 * sources by a few minutes at most):
 *   gmail, instantly   the message store over the person's addresses (gmail only when connected)
 *   matrix             every DM conversation of the person (WhatsApp / Telegram / LinkedIn...), a message
 *                      sent by the brand's account or its self-ghost (edits and bridge notices are not
 *                      messages), + our own WhatsApp send rows (they reach the mirror seconds later)
 *   copilot, api, transactional   the staff Unibox scope only, matched on the person's addresses
 *
 * Never an empty answer posing as "no": each ask states one status:
 *   sent          a message after T (`firstSent`, `lastSentAt`, `bySource`)
 *   nothing_sent  every thread of the person was read and holds nothing after T
 *   unreadable    nothing found AND a thread could not be read / was never read / its mirror is stale (`gaps`)
 *   unknown       no name of the ask is a person of this (org, brand) (`reason`)
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCalls, copilotMessages, people, peopleMessageUnits, peopleScopes, transactionalEmails, whatsappSends, type Person } from "../../db/schema.js";
import { API_SENDER_NAME, describeResponse } from "../api-calls/calls.js";
import { COPILOT_CHANNEL, COPILOT_SENDER_NAME, isCopilotDestination } from "../copilot/messages.js";
import { ownSenderSql } from "../matrix/own-senders.js";
import { TX_EMAIL_CHANNEL, TX_EMAIL_SENDER_NAME } from "../transactional/sent-emails.js";
import type { BuildSummary } from "./build.js";
import { emailKey, normalizeEmail, normalizePhone, phoneKey, type Presence } from "./identity.js";
import { automatedSends, clipText, peopleByIds, type MatrixRow } from "./latest-messages.js";
import { personIdOfRelationKey } from "./relations.js";

export const SENT_AFTER_MAX_PEOPLE = 200;
/** A Matrix connection not mirrored for this long may hide a message: a gap, never "nothing sent". */
export const MATRIX_MIRROR_STALE_MS = 30 * 60 * 1000;

export const SENT_AFTER_STATUSES = ["sent", "nothing_sent", "unreadable", "unknown"] as const;
export type SentAfterStatus = (typeof SENT_AFTER_STATUSES)[number];
export const SENT_AFTER_UNKNOWN_REASONS = ["scope_not_built", "not_a_relation_key", "person_not_found"] as const;
export const SENT_AFTER_GAP_REASONS = ["read_failed", "not_read_yet", "mirror_stale"] as const;

export type SentSource = "gmail" | "instantly" | "matrix" | "copilot" | "api" | "transactional";

export interface SentAfterAsk {
  ref?: string;
  relationKey?: string;
  personId?: string;
  humanId?: string;
  email?: string;
  phone?: string;
  after: string;
}

export interface SentMessage {
  at: string;
  source: SentSource;
  /** email | whatsapp | telegram | linkedin | chat | api | mcp ... */
  channel: string;
  /** automation = one of our machines; person = a human of the brand typed it; null = the source does not say. */
  sentBy: "automation" | "person" | null;
  from: string | null;
  text: string | null;
  ref: Record<string, string | null>;
}

export interface SentAfterGap {
  source: "gmail" | "instantly" | "matrix";
  /** gmail / instantly: the address; matrix: null. */
  address: string | null;
  /** matrix: the connection whose mirror is stale; else null. */
  connectionId: string | null;
  reason: (typeof SENT_AFTER_GAP_REASONS)[number];
  error: string | null;
}

export interface SentAfterAnswer {
  index: number;
  ref: string | null;
  after: string;
  status: SentAfterStatus;
  reason: string | null;
  personIds: string[];
  /** The earliest message the brand sent the person after T. */
  firstSent: SentMessage | null;
  lastSentAt: string | null;
  /** Per source + channel: when the brand wrote after T (first, last). */
  bySource: { source: SentSource; channel: string; firstAt: string; lastAt: string }[];
  gaps: SentAfterGap[];
}

// ─── pure ───────────────────────────────────────────────────────────────────

/** PURE: the status of one ask from what was found and what could not be read. */
export function sentAfterStatus(found: SentMessage[], gaps: SentAfterGap[]): Pick<SentAfterAnswer, "status" | "reason"> {
  if (found.length) return { status: "sent", reason: null };
  if (gaps.length) return { status: "unreadable", reason: "source_unreadable" };
  return { status: "nothing_sent", reason: null };
}

/** PURE: earliest message (ties by source then identity), latest time, and the per source + channel window. */
export function summarizeSent(found: SentMessage[]): Pick<SentAfterAnswer, "firstSent" | "lastSentAt" | "bySource"> {
  if (found.length === 0) return { firstSent: null, lastSentAt: null, bySource: [] };
  const sorted = [...found].sort((a, b) => a.at.localeCompare(b.at) || a.source.localeCompare(b.source) || JSON.stringify(a.ref).localeCompare(JSON.stringify(b.ref)));
  const groups = new Map<string, { source: SentSource; channel: string; firstAt: string; lastAt: string }>();
  for (const m of sorted) {
    const k = `${m.source}|${m.channel}`;
    const g = groups.get(k);
    if (!g) groups.set(k, { source: m.source, channel: m.channel, firstAt: m.at, lastAt: m.at });
    else g.lastAt = m.at;
  }
  return { firstSent: sorted[0], lastSentAt: sorted[sorted.length - 1].at, bySource: [...groups.values()] };
}

const iso = (d: Date | string) => new Date(d).toISOString();
const clip = (t: string | null) => clipText(t).text;

// ─── resolution ─────────────────────────────────────────────────────────────

interface Resolved {
  index: number;
  after: Date;
  persons: Person[];
}

/** The people each ask names (union of every name it carries). */
async function resolveAsks(orgId: string, brandId: string, asks: SentAfterAsk[]): Promise<Map<number, Person[]>> {
  const idsAsked = new Set<string>();
  const humanIds = new Set<string>();
  const keys = new Set<string>();
  const phones = new Set<string>();
  for (const a of asks) {
    const fromRel = a.relationKey ? personIdOfRelationKey(a.relationKey) : null;
    if (fromRel) idsAsked.add(fromRel);
    if (a.personId) idsAsked.add(a.personId);
    if (a.humanId) humanIds.add(a.humanId);
    const e = normalizeEmail(a.email);
    if (e) keys.add(emailKey(e));
    const p = normalizePhone(a.phone);
    if (p) {
      keys.add(phoneKey(p));
      phones.add(p);
    }
  }

  // A phone the person holds only as a WhatsApp ghost (LID): the bridge's answer names the ghost, the
  // ghost names the brand's Matrix contacts, each a `matrix:<contactId>` identity key.
  const ghostKeysOfPhone = new Map<string, string[]>();
  if (phones.size) {
    const rows = (await db.execute(sql`
      SELECT g.phone, c.id AS contact_id FROM matrix_ghost_phones g
      JOIN contacts c ON c.channel_handle = g.ghost_mxid AND c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = 'matrix'
      WHERE g.phone IN (${sql.join([...phones].map((p) => sql`${p}`), sql`, `)})
    `)) as unknown as { phone: string; contact_id: string }[];
    for (const r of rows) {
      const k = `matrix:${r.contact_id}`;
      ghostKeysOfPhone.set(r.phone, [...(ghostKeysOfPhone.get(r.phone) ?? []), k]);
      keys.add(k);
    }
  }

  const [byId, byHuman, byKey] = await Promise.all([
    peopleByIds(orgId, brandId, [...idsAsked]),
    humanIds.size
      ? db.select().from(people).where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), inArray(people.humanId, [...humanIds])))
      : Promise.resolve([] as Person[]),
    keys.size
      ? db
          .select()
          .from(people)
          .where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), sql`${people.identityKeys} ?| ARRAY[${sql.join([...keys].map((k) => sql`${k}`), sql`, `)}]::text[]`))
      : Promise.resolve([] as Person[]),
  ]);

  const out = new Map<number, Person[]>();
  asks.forEach((a, index) => {
    const found = new Map<string, Person>();
    const add = (p: Person | undefined) => p && found.set(p.id, p);
    const fromRel = a.relationKey ? personIdOfRelationKey(a.relationKey) : null;
    if (fromRel) add(byId.get(fromRel));
    if (a.personId) add(byId.get(a.personId));
    if (a.humanId) for (const p of byHuman) if (p.humanId === a.humanId) add(p);
    const wanted: string[] = [];
    const e = normalizeEmail(a.email);
    if (e) wanted.push(emailKey(e));
    const ph = normalizePhone(a.phone);
    if (ph) wanted.push(phoneKey(ph), ...(ghostKeysOfPhone.get(ph) ?? []));
    for (const p of byKey) if ((p.identityKeys as string[]).some((k) => wanted.includes(k))) add(p);
    out.set(index, [...found.values()]);
  });
  return out;
}

// ─── reads ──────────────────────────────────────────────────────────────────

interface StoreSent {
  idx: number;
  source: "gmail" | "instantly";
  address: string;
  message_key: string;
  at: Date | string;
  last_at: Date | string;
  body: string | null;
  channel: string | null;
  from_addr: string | null;
  ref: Record<string, string | null> | null;
  outreach_fact: unknown;
}

/** The first and last outbound stored email after each ask's T, per (ask, source). */
async function storeSent(scopeId: string, pairs: { idx: number; address: string; after: Date }[], gmailConnected: boolean): Promise<StoreSent[]> {
  if (pairs.length === 0) return [];
  return (await db.execute(sql`
    WITH asked(idx, address, after) AS (
      VALUES ${sql.join(pairs.map((p) => sql`(${p.idx}::int, ${p.address}::text, ${p.after.toISOString()}::timestamptz)`), sql`, `)}
    )
    SELECT DISTINCT ON (a.idx, t.source) a.idx, t.source, t.address, t.message_key, t.at,
      max(t.at) OVER (PARTITION BY a.idx, t.source) AS last_at,
      left(t.body, 2000) AS body, t.item->>'channel' AS channel, t.item->>'from' AS from_addr,
      t.item->'ref' AS ref, t.item->'outreachFact' AS outreach_fact
    FROM asked a
    JOIN people_message_texts t ON t.scope_id = ${scopeId} AND t.address = a.address
      AND t.direction = 'outbound' AND t.at > a.after
      ${gmailConnected ? sql`` : sql`AND t.source <> 'gmail'`}
    ORDER BY a.idx, t.source, t.at ASC, t.message_key ASC
  `)) as unknown as StoreSent[];
}

interface MatrixSent extends MatrixRow {
  idx: number;
  last_at: Date | string;
}

/** The first and last message the brand's account sent in each DM conversation after each ask's T. */
async function matrixSent(pairs: { idx: number; conversationId: string; after: Date }[]): Promise<MatrixSent[]> {
  if (pairs.length === 0) return [];
  const own = ownSenderSql(sql`e.sender`, sql`c.connection_id`);
  const sent = sql`e.connection_id = c.connection_id AND e.room_id = c.room_id AND e.event_type = 'm.room.message'
    AND e.origin_server_ts > a.after
    AND (e.payload->'content'->'m.relates_to'->>'rel_type') IS DISTINCT FROM 'm.replace'
    AND (e.payload->'content'->>'msgtype') IS DISTINCT FROM 'm.notice'
    AND ${own}`;
  return (await db.execute(sql`
    WITH asked(idx, conversation_id, after) AS (
      VALUES ${sql.join(pairs.map((p) => sql`(${p.idx}::int, ${p.conversationId}::uuid, ${p.after.toISOString()}::timestamptz)`), sql`, `)}
    )
    SELECT a.idx, c.id AS conversation_id, NULL AS group_room_id, c.channel, m.matrix_user_id AS own_mxid, true AS own_sent,
           f.event_id, f.room_id, f.sender, f.origin_server_ts, f.body, l.last_at
    FROM asked a
    JOIN conversations c ON c.id = a.conversation_id
    JOIN matrix_connections m ON m.id = c.connection_id
    CROSS JOIN LATERAL (
      SELECT e.event_id, e.room_id, e.sender, e.origin_server_ts, e.payload->'content'->'body' AS body
      FROM matrix_raw_events e WHERE ${sent}
      ORDER BY e.origin_server_ts ASC, e.event_id ASC LIMIT 1
    ) f
    CROSS JOIN LATERAL (SELECT max(e.origin_server_ts) AS last_at FROM matrix_raw_events e WHERE ${sent}) l
  `)) as unknown as MatrixSent[];
}

/** The ask's whole union of the person's addresses, phones, DM conversations (and their connections + rooms). */
function reachOf(persons: Person[]) {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const conversationIds = new Set<string>();
  for (const p of persons) {
    for (const e of p.emails as string[]) emails.add(e.toLowerCase());
    for (const ph of p.phones as string[]) phones.add(ph);
    for (const pr of p.presences as Presence[]) {
      if (pr.source === "matrix" && typeof pr.detail.conversationId === "string") conversationIds.add(pr.detail.conversationId);
    }
  }
  return { emails: [...emails], phones: [...phones], conversationIds: [...conversationIds] };
}

/** Did the brand send each person a message after their T? One answer per ask, in the order asked. */
export async function readSentAfter(orgId: string, brandId: string, asks: SentAfterAsk[]): Promise<{ scope: { id: string; status: string; lastBuiltAt: string | null } | null; people: SentAfterAnswer[]; counts: Record<SentAfterStatus, number> }> {
  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)))
    .limit(1);
  const answers: SentAfterAnswer[] = asks.map((a, index) => ({
    index,
    ref: a.ref ?? null,
    after: new Date(a.after).toISOString(),
    status: "unknown",
    reason: "scope_not_built",
    personIds: [],
    firstSent: null,
    lastSentAt: null,
    bySource: [],
    gaps: [],
  }));
  const finish = () => {
    const counts = { sent: 0, nothing_sent: 0, unreadable: 0, unknown: 0 } as Record<SentAfterStatus, number>;
    for (const a of answers) counts[a.status]++;
    return {
      scope: scope ? { id: scope.id, status: scope.status, lastBuiltAt: scope.lastBuiltAt ? scope.lastBuiltAt.toISOString() : null } : null,
      people: answers,
      counts,
    };
  };
  if (!scope || scope.status === "pending") return finish();

  const personsOf = await resolveAsks(orgId, brandId, asks);
  const resolved: Resolved[] = [];
  asks.forEach((a, index) => {
    const persons = personsOf.get(index) ?? [];
    if (persons.length === 0) {
      const onlyBadKey = !!a.relationKey && !personIdOfRelationKey(a.relationKey) && !a.personId && !a.humanId && !a.email && !a.phone;
      answers[index].reason = onlyBadKey ? "not_a_relation_key" : "person_not_found";
      return;
    }
    answers[index].personIds = persons.map((p) => p.personId).filter((x): x is string => !!x);
    resolved.push({ index, after: new Date(a.after), persons });
  });
  if (resolved.length === 0) return finish();

  const reads = scope.sourceReads as BuildSummary | null;
  const connected = (s: string) => reads?.sources.find((r) => r.source === s)?.status !== "not_connected";
  const gmailConnected = connected("gmail");
  const matrixConnected = connected("matrix");
  const staffScope = isCopilotDestination(orgId, brandId);

  const reach = new Map(resolved.map((r) => [r.index, reachOf(r.persons)]));
  const storePairs = resolved.flatMap((r) => reach.get(r.index)!.emails.map((address) => ({ idx: r.index, address, after: r.after })));
  const convPairs = matrixConnected ? resolved.flatMap((r) => reach.get(r.index)!.conversationIds.map((conversationId) => ({ idx: r.index, conversationId, after: r.after }))) : [];
  const allEmails = [...new Set(resolved.flatMap((r) => reach.get(r.index)!.emails))];
  const allPhones = [...new Set(resolved.flatMap((r) => reach.get(r.index)!.phones))];
  const allConvs = [...new Set(convPairs.map((p) => p.conversationId))];
  const minAfter = new Date(Math.min(...resolved.map((r) => r.after.getTime())));

  const [stored, mx, units, convConns, sends, copilot, api, tx] = await Promise.all([
    storeSent(scope.id, storePairs, gmailConnected),
    matrixSent(convPairs),
    allEmails.length
      ? db
          .select({ address: peopleMessageUnits.address, source: peopleMessageUnits.source, status: peopleMessageUnits.status, error: peopleMessageUnits.error })
          .from(peopleMessageUnits)
          .where(and(eq(peopleMessageUnits.scopeId, scope.id), inArray(peopleMessageUnits.address, allEmails)))
      : Promise.resolve([] as { address: string; source: string; status: string; error: string | null }[]),
    allConvs.length
      ? (db.execute(sql`
          SELECT c.id AS conversation_id, c.room_id, m.id AS connection_id, m.status, m.last_synced_at, m.last_error
          FROM conversations c JOIN matrix_connections m ON m.id = c.connection_id
          WHERE c.id IN (${sql.join(allConvs.map((id) => sql`${id}::uuid`), sql`, `)})
        `) as unknown as Promise<{ conversation_id: string; room_id: string; connection_id: string; status: string; last_synced_at: Date | string | null; last_error: string | null }[]>)
      : Promise.resolve([]),
    allEmails.length || allPhones.length || allConvs.length
      ? db
          .select()
          .from(whatsappSends)
          .where(
            and(
              eq(whatsappSends.orgId, orgId),
              eq(whatsappSends.brandId, brandId),
              eq(whatsappSends.status, "sent"),
              sql`${whatsappSends.sentAt} > ${minAfter.toISOString()}::timestamptz`,
              sql`(${sql.join(
                [
                  ...(allEmails.length ? [sql`lower(${whatsappSends.email}) IN (${sql.join(allEmails.map((e) => sql`${e}`), sql`, `)})`] : []),
                  ...(allPhones.length ? [sql`${whatsappSends.phone} IN (${sql.join(allPhones.map((p) => sql`${p}`), sql`, `)})`] : []),
                  ...(allConvs.length ? [sql`${whatsappSends.roomId} IN (SELECT room_id FROM conversations WHERE id IN (${sql.join(allConvs.map((id) => sql`${id}::uuid`), sql`, `)}))`] : []),
                ],
                sql` OR `,
              )})`,
            ),
          )
      : Promise.resolve([]),
    staffScope && allEmails.length
      ? db
          .select()
          .from(copilotMessages)
          .where(
            and(
              eq(copilotMessages.orgId, orgId),
              eq(copilotMessages.brandId, brandId),
              eq(copilotMessages.role, "assistant"),
              inArray(copilotMessages.email, allEmails),
              sql`${copilotMessages.sentAt} > ${minAfter.toISOString()}::timestamptz`,
            ),
          )
      : Promise.resolve([]),
    staffScope && allEmails.length
      ? db
          .select()
          .from(apiCalls)
          .where(and(eq(apiCalls.orgId, orgId), eq(apiCalls.brandId, brandId), inArray(apiCalls.email, allEmails), sql`${apiCalls.calledAt} > ${minAfter.toISOString()}::timestamptz - interval '1 day'`))
      : Promise.resolve([]),
    staffScope && allEmails.length
      ? db
          .select()
          .from(transactionalEmails)
          .where(and(inArray(transactionalEmails.recipientEmail, allEmails), sql`${transactionalEmails.sentAt} > ${minAfter.toISOString()}::timestamptz`))
      : Promise.resolve([]),
  ]);

  const auto = await automatedSends(orgId, brandId, mx);
  const roomOf = new Map(convConns.map((c) => [c.conversation_id, c.room_id]));
  const connOf = new Map(convConns.map((c) => [c.conversation_id, c]));
  const unitsOf = new Map<string, { source: string; status: string; error: string | null }[]>();
  for (const u of units) unitsOf.set(u.address, [...(unitsOf.get(u.address) ?? []), u]);
  const now = Date.now();

  for (const r of resolved) {
    const { emails, phones, conversationIds } = reach.get(r.index)!;
    const after = r.after.getTime();
    const found: SentMessage[] = [];

    for (const s of stored.filter((x) => x.idx === r.index)) {
      const gmail = s.source === "gmail";
      found.push({
        at: iso(s.at),
        source: s.source,
        channel: s.channel ?? "email",
        sentBy: !gmail && s.outreach_fact ? "automation" : null,
        from: s.from_addr,
        text: clip(s.body),
        ref: { ...(s.ref ?? {}), address: s.address },
      });
      if (iso(s.last_at) !== iso(s.at)) found.push({ at: iso(s.last_at), source: s.source, channel: s.channel ?? "email", sentBy: null, from: null, text: null, ref: { address: s.address } });
    }
    for (const m of mx.filter((x) => x.idx === r.index)) {
      found.push({
        at: iso(m.origin_server_ts),
        source: "matrix",
        channel: m.channel,
        sentBy: auto.has(m.event_id) ? "automation" : "person",
        from: m.sender,
        text: clip(typeof m.body === "string" ? m.body : null),
        ref: { eventId: m.event_id, roomId: m.room_id, conversationId: m.conversation_id },
      });
      if (iso(m.last_at) !== iso(m.origin_server_ts)) found.push({ at: iso(m.last_at), source: "matrix", channel: m.channel, sentBy: null, from: null, text: null, ref: { conversationId: m.conversation_id } });
    }
    const rooms = new Set(conversationIds.map((c) => roomOf.get(c)).filter((x): x is string => !!x));
    for (const w of sends) {
      if (!w.sentAt || w.sentAt.getTime() <= after) continue;
      const mine = (w.email && emails.includes(w.email.toLowerCase())) || (w.phone && phones.includes(w.phone)) || (w.roomId && rooms.has(w.roomId));
      if (!mine) continue;
      found.push({ at: w.sentAt.toISOString(), source: "matrix", channel: "whatsapp", sentBy: "automation", from: w.fromAccount, text: clip(w.text), ref: { sendId: w.id, eventId: w.eventId, roomId: w.roomId } });
    }
    for (const c of copilot) {
      if (!emails.includes(c.email) || c.sentAt.getTime() <= after) continue;
      found.push({ at: c.sentAt.toISOString(), source: "copilot", channel: COPILOT_CHANNEL, sentBy: "automation", from: COPILOT_SENDER_NAME, text: clip(c.text), ref: { messageId: c.messageId, sessionId: c.sessionId } });
    }
    for (const c of api) {
      const answeredAt = c.calledAt.getTime() + c.durationMs;
      if (!emails.includes(c.email) || answeredAt <= after) continue;
      found.push({ at: new Date(answeredAt).toISOString(), source: "api", channel: c.channel, sentBy: "automation", from: API_SENDER_NAME, text: clip(describeResponse(c)), ref: { callId: c.callId } });
    }
    for (const t of tx) {
      if (!emails.includes(t.recipientEmail) || t.sentAt.getTime() <= after) continue;
      found.push({ at: t.sentAt.toISOString(), source: "transactional", channel: TX_EMAIL_CHANNEL, sentBy: "automation", from: t.fromAddress ?? TX_EMAIL_SENDER_NAME, text: clip(t.subject), ref: { emailId: t.id, eventType: t.eventType } });
    }

    // Gaps: a stored thread that failed its last read or was never read; a DM whose mirror is stale.
    const gaps: SentAfterGap[] = [];
    const coldEmailed = new Set(r.persons.flatMap((p) => (p.presences as Presence[]).filter((x) => x.source === "instantly").map((x) => x.sourceRef.toLowerCase())));
    for (const address of emails) {
      const mine = unitsOf.get(address) ?? [];
      for (const u of mine) {
        if (u.status !== "ok" && (u.source === "gmail" ? gmailConnected : true)) gaps.push({ source: u.source as "gmail" | "instantly", address, connectionId: null, reason: "read_failed", error: u.error });
      }
      if (gmailConnected && !mine.some((u) => u.source === "gmail")) gaps.push({ source: "gmail", address, connectionId: null, reason: "not_read_yet", error: null });
      if (coldEmailed.has(address) && !mine.some((u) => u.source === "instantly")) gaps.push({ source: "instantly", address, connectionId: null, reason: "not_read_yet", error: null });
    }
    if (matrixConnected) {
      const seen = new Set<string>();
      for (const c of conversationIds) {
        const conn = connOf.get(c);
        if (!conn || seen.has(conn.connection_id)) continue;
        seen.add(conn.connection_id);
        const synced = conn.last_synced_at ? new Date(conn.last_synced_at).getTime() : null;
        if (conn.status !== "active" || synced === null || now - synced > MATRIX_MIRROR_STALE_MS) {
          gaps.push({ source: "matrix", address: null, connectionId: conn.connection_id, reason: "mirror_stale", error: conn.last_error ?? `status ${conn.status}, last mirrored ${synced === null ? "never" : new Date(synced).toISOString()}` });
        }
      }
    }

    Object.assign(answers[r.index], sentAfterStatus(found, gaps), summarizeSent(found), { gaps });
  }
  return finish();
}
