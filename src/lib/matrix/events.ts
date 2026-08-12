/**
 * Deterministic, dependency-free logic over Matrix events.
 *
 * Everything here is pure: given the same events it produces the same silver
 * state. NO LLM anywhere in this file — knowing who wrote to you, when, and how
 * many times needs no model.
 */

import type { MatrixEvent } from "./client.js";

export const MATRIX_CHANNELS = ["whatsapp", "telegram", "discord"] as const;
export type MatrixChannel = (typeof MATRIX_CHANNELS)[number];

export function isMatrixChannel(value: string): value is MatrixChannel {
  return (MATRIX_CHANNELS as readonly string[]).includes(value);
}

/**
 * INGESTION FLOOR — events older than this are NEVER mirrored into bronze.
 *
 * Bronze normally means "everything"; this is the one deliberate exception, so
 * a reader who finds nothing before the floor knows why (see CLAUDE.md). Fails
 * loud when unset or unparsable: a missing floor would silently back-fill years
 * of personal DMs.
 */
export function ingestionFloor(): Date {
  const raw = process.env.MATRIX_INGESTION_FLOOR;
  if (!raw) throw new Error("[crm-service] MATRIX_INGESTION_FLOOR is required");
  const floor = new Date(raw);
  if (Number.isNaN(floor.getTime())) {
    throw new Error(`[crm-service] MATRIX_INGESTION_FLOOR is not a valid date: ${raw}`);
  }
  return floor;
}

/** Is this event at or after the floor? */
export function isAtOrAfterFloor(event: MatrixEvent, floor: Date): boolean {
  return typeof event.origin_server_ts === "number" && event.origin_server_ts >= floor.getTime();
}

/**
 * Should this event be mirrored into bronze?
 *
 * The floor gates CONVERSATION CONTENT — `m.room.message`. Room STATE
 * (`m.room.member`) is always mirrored regardless of its age, because it is
 * IDENTITY, not content: it is the only thing that says who the counterpart of a
 * room is, and a room joined years ago carries a membership event with that old
 * timestamp. Dropping it would leave every real room unresolvable from bronze,
 * and gold would stop being rebuildable from bronze alone. No message written
 * before the floor is ever stored either way.
 */
export function shouldMirror(event: MatrixEvent, floor: Date): boolean {
  if (event.type === "m.room.message") return isAtOrAfterFloor(event, floor);
  return true;
}

/** Stable ordering: oldest first, event id breaks ties on identical timestamps. */
export function compareEvents(a: MatrixEvent, b: MatrixEvent): number {
  if (a.origin_server_ts !== b.origin_server_ts) return a.origin_server_ts - b.origin_server_ts;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

export interface Counterpart {
  /** The counterpart's bridged Matrix user id — the durable handle identity. */
  mxid: string;
  displayName: string | null;
  /** E.164 phone, when the bridge encodes one in the MXID localpart (WhatsApp). */
  phoneE164: string | null;
}

/**
 * Resolve WHO the counterpart of a DM room is.
 *
 * A bridged DM room has two members: the user's own bridged account and the
 * bridge ghost representing the other person. This is state-event work, not
 * guesswork: it reads `m.room.member` events, drops the user's own MXID, and
 * keeps the member whose MXID sits in the bridge's ghost namespace
 * (`counterpartPrefix`, e.g. `@whatsapp_`). The most recent member event wins,
 * so a display-name change is picked up.
 *
 * Returns null when no such member exists — the room does not belong to this
 * connection (a sync batch from one access token carries every bridge's rooms).
 */
export function resolveCounterpart(
  memberEvents: MatrixEvent[],
  ownMxid: string,
  counterpartPrefix: string,
): Counterpart | null {
  let best: MatrixEvent | null = null;
  for (const ev of memberEvents) {
    if (ev.type !== "m.room.member") continue;
    const stateKey = ev.state_key;
    if (!stateKey || stateKey === ownMxid) continue;
    if (!stateKey.startsWith(counterpartPrefix)) continue;
    const membership = String(ev.content?.membership ?? "");
    if (membership !== "join" && membership !== "invite") continue;
    if (!best || compareEvents(best, ev) < 0) best = ev;
  }
  if (!best || !best.state_key) return null;

  const displayNameRaw = best.content?.displayname;
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim() !== ""
      ? displayNameRaw.trim()
      : null;

  return {
    mxid: best.state_key,
    displayName,
    phoneE164: phoneFromMxid(best.state_key, counterpartPrefix),
  };
}

/**
 * mautrix-whatsapp encodes the counterpart's phone number in the ghost MXID
 * localpart (`@whatsapp_33612345678:hs` → `+33612345678`). Other bridges use
 * opaque ids, so this returns null for them — deterministically, never a guess.
 */
export function phoneFromMxid(mxid: string, counterpartPrefix: string): string | null {
  if (!mxid.startsWith(counterpartPrefix)) return null;
  const localpart = mxid.slice(counterpartPrefix.length).split(":")[0] ?? "";
  return /^\d{6,20}$/.test(localpart) ? `+${localpart}` : null;
}

/** Split a display name into first / last, same light rule the CSV path uses. */
export function splitName(fullName: string | null): {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
} {
  if (!fullName) return { fullName: null, firstName: null, lastName: null };
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    fullName,
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

export interface ConversationAggregate {
  firstMessageAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  /** Freshness watermark — the last message folded into this aggregate. */
  lastEventId: string;
}

/**
 * Aggregate a room's message events into conversation counters.
 *
 * INBOUND = written by the counterpart (they wrote first — that is the whole
 * point of this source). OUTBOUND = sent by the user's own bridged account.
 *
 * Returns null when the room has no message events at all (member state only).
 */
export function aggregateMessages(
  messageEvents: MatrixEvent[],
  ownMxid: string,
): ConversationAggregate | null {
  const messages = messageEvents.filter((e) => e.type === "m.room.message").sort(compareEvents);
  if (messages.length === 0) return null;

  let inbound = 0;
  let outbound = 0;
  for (const m of messages) {
    if (m.sender === ownMxid) outbound += 1;
    else inbound += 1;
  }

  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    firstMessageAt: new Date(first.origin_server_ts),
    lastMessageAt: new Date(last.origin_server_ts),
    messageCount: messages.length,
    inboundCount: inbound,
    outboundCount: outbound,
    lastEventId: last.event_id,
  };
}

export interface ThreadLine {
  direction: "inbound" | "outbound";
  at: string;
  body: string;
}

/** Render a room's messages as an ordered transcript for the gold LLM read. */
export function renderThread(
  messageEvents: MatrixEvent[],
  ownMxid: string,
  maxLines: number,
): ThreadLine[] {
  const messages = messageEvents.filter((e) => e.type === "m.room.message").sort(compareEvents);
  const window = messages.length > maxLines ? messages.slice(messages.length - maxLines) : messages;
  return window.map((m) => ({
    direction: m.sender === ownMxid ? "outbound" : "inbound",
    at: new Date(m.origin_server_ts).toISOString(),
    body: typeof m.content?.body === "string" ? m.content.body : "",
  }));
}
