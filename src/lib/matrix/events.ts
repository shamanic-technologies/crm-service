/**
 * Deterministic, dependency-free logic over Matrix events.
 *
 * Everything here is pure: given the same events it produces the same silver
 * state. NO LLM anywhere in this file — knowing who wrote to you, when, and how
 * many times needs no model.
 */

import type { MatrixEvent } from "./client.js";

export const MATRIX_CHANNELS = ["whatsapp", "telegram", "discord", "linkedin"] as const;
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
 * keeps the members whose MXID sits in the bridge's ghost namespace
 * (`counterpartPrefix`, e.g. `@whatsapp_`) and who are still in the room.
 *
 * The counterpart is the ghost that joined FIRST, and it stays so: WhatsApp
 * can put a second ghost into a DM (2026-10-12, a "James (WA)" LID ghost joined
 * a campaign thread mid-conversation), and "the latest member event wins" moved
 * the WHOLE thread, history included, onto a new contact with no phone and no
 * email: every fact of the real person was withdrawn and re-stated under an
 * anonymous one. The display name is the chosen ghost's latest, so a rename is
 * still picked up.
 *
 * Returns null when no such member exists — the room does not belong to this
 * connection (a sync batch from one access token carries every bridge's rooms).
 */
export function resolveCounterpart(
  memberEvents: MatrixEvent[],
  ownMxid: string,
  counterpartPrefix: string,
): Counterpart | null {
  const ghosts = new Map<string, { first: MatrixEvent; latest: MatrixEvent }>();
  for (const ev of memberEvents) {
    if (ev.type !== "m.room.member") continue;
    const stateKey = ev.state_key;
    if (!stateKey || stateKey === ownMxid) continue;
    if (!stateKey.startsWith(counterpartPrefix)) continue;
    const membership = String(ev.content?.membership ?? "");
    const g = ghosts.get(stateKey);
    if (!g) {
      if (membership === "join" || membership === "invite") ghosts.set(stateKey, { first: ev, latest: ev });
      continue;
    }
    if (compareEvents(g.first, ev) > 0 && (membership === "join" || membership === "invite")) g.first = ev;
    if (compareEvents(g.latest, ev) < 0) g.latest = ev;
  }
  let best: { mxid: string; first: MatrixEvent; latest: MatrixEvent } | null = null;
  for (const [mxid, g] of ghosts) {
    const now = String(g.latest.content?.membership ?? "");
    if (now !== "join" && now !== "invite") continue; // left / kicked / banned: no longer the counterpart
    if (!best || compareEvents(g.first, best.first) < 0) best = { mxid, ...g };
  }
  if (!best) return null;

  const displayNameRaw = best.latest.content?.displayname;
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim() !== "" ? displayNameRaw.trim() : null;

  return {
    mxid: best.mxid,
    displayName,
    phoneE164: phoneFromMxid(best.mxid, counterpartPrefix),
  };
}

/**
 * Is this room a GROUP (several people) rather than a DM?
 *
 * Decided on the room's own state, the same way on every bridge: a bridged DM
 * carries `is_direct: true` on a membership event (the Matrix spec's DM mark,
 * set by the bridge when it invites the account); a group never does. A room
 * with no such mark and a single ghost is treated as a DM (a hand-registered
 * room, a two-person group): there is only one person to talk to.
 * RELATIONSHIP-TAGS-1014: a WhatsApp group used to be read as a conversation
 * with its first-joined member, and every other member was nobody.
 */
export function isGroupRoom(events: MatrixEvent[], ownMxid: string, counterpartPrefix: string): boolean {
  const ghosts = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "m.room.member") continue;
    if (ev.content?.is_direct === true) return false;
    const k = ev.state_key;
    if (k && k !== ownMxid && k.startsWith(counterpartPrefix)) ghosts.add(k);
  }
  return ghosts.size >= 2;
}

/** The room's current name (`m.room.name`, latest), or null. */
export function roomName(events: MatrixEvent[]): string | null {
  let latest: MatrixEvent | null = null;
  for (const ev of events) {
    if (ev.type !== "m.room.name") continue;
    if (!latest || compareEvents(latest, ev) < 0) latest = ev;
  }
  const name = latest?.content?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

export interface GroupMember extends Counterpart {
  /** The member's latest membership (`join`, `invite`, `leave`, `ban`...). */
  membership: string;
  /** When they first joined (or were invited), the vendor's date. */
  joinedAt: Date | null;
  /** Messages they wrote in the room (any content). */
  authoredCount: number;
  firstAuthoredAt: Date | null;
  lastAuthoredAt: Date | null;
}

/**
 * Every member of a group room in the bridge's ghost namespace (the account
 * itself is never a ghost), with what they did there. Pure, deterministic,
 * sorted by MXID.
 */
export function groupMembers(events: MatrixEvent[], ownMxid: string, counterpartPrefix: string): GroupMember[] {
  const byMxid = new Map<string, { first: MatrixEvent | null; latest: MatrixEvent; authored: number; firstAuthored: number | null; lastAuthored: number | null }>();
  for (const ev of events) {
    if (ev.type !== "m.room.member") continue;
    const k = ev.state_key;
    if (!k || k === ownMxid || !k.startsWith(counterpartPrefix)) continue;
    const membership = String(ev.content?.membership ?? "");
    const entered = membership === "join" || membership === "invite";
    const m = byMxid.get(k);
    if (!m) {
      byMxid.set(k, { first: entered ? ev : null, latest: ev, authored: 0, firstAuthored: null, lastAuthored: null });
      continue;
    }
    if (entered && (!m.first || compareEvents(m.first, ev) > 0)) m.first = ev;
    if (compareEvents(m.latest, ev) < 0) m.latest = ev;
  }
  for (const ev of events) {
    if (ev.type !== "m.room.message") continue;
    const m = byMxid.get(ev.sender);
    if (!m) continue;
    m.authored += 1;
    if (m.firstAuthored === null || ev.origin_server_ts < m.firstAuthored) m.firstAuthored = ev.origin_server_ts;
    if (m.lastAuthored === null || ev.origin_server_ts > m.lastAuthored) m.lastAuthored = ev.origin_server_ts;
  }
  return [...byMxid.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([mxid, m]) => {
      // The latest event naming a display name: a `leave` carries none.
      const named = [m.latest, m.first].find((e) => typeof e?.content?.displayname === "string" && String(e.content.displayname).trim() !== "");
      return {
        mxid,
        displayName: named ? String(named.content!.displayname).trim() : null,
        phoneE164: phoneFromMxid(mxid, counterpartPrefix),
        membership: String(m.latest.content?.membership ?? ""),
        joinedAt: m.first ? new Date(m.first.origin_server_ts) : null,
        authoredCount: m.authored,
        firstAuthoredAt: m.firstAuthored === null ? null : new Date(m.firstAuthored),
        lastAuthoredAt: m.lastAuthored === null ? null : new Date(m.lastAuthored),
      };
    });
}

/**
 * The messaging handle a ghost names, in the form human-service stores it
 * (RELATIONSHIP-TAGS-1014, agreed with human-service): a WhatsApp LID ghost
 * `@whatsapp_lid-839…:hs` → `839…@lid`; a LinkedIn ghost → the LinkedIn member
 * id verbatim (the bridge escapes it in the localpart: `_a` = `A`, `__` = `_`,
 * `=2d` = `-`). A WhatsApp ghost that encodes a phone has no handle: its phone
 * IS the key. Null for a channel human-service has no network for.
 */
export function handleOf(channel: string, mxid: string, counterpartPrefix: string): { network: string; id: string } | null {
  if (!mxid.startsWith(counterpartPrefix)) return null;
  const local = mxid.slice(counterpartPrefix.length).split(":")[0] ?? "";
  if (!local) return null;
  if (channel === "whatsapp") {
    const lid = /^lid-(\d+)$/.exec(local);
    return lid ? { network: "whatsapp", id: `${lid[1]}@lid` } : null;
  }
  if (channel === "linkedin" || channel === "telegram") return { network: channel, id: unescapeLocalpart(local) };
  return null;
}

/** PURE: undo the mautrix MXID localpart escaping (`_x` → `X`, `__` → `_`, `=hh` → byte). */
export function unescapeLocalpart(local: string): string {
  let out = "";
  for (let i = 0; i < local.length; i++) {
    const c = local[i];
    if (c === "_" && i + 1 < local.length) {
      const n = local[++i];
      out += n === "_" ? "_" : n.toUpperCase();
    } else if (c === "=" && /^[0-9a-f]{2}$/.test(local.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(local.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += c;
    }
  }
  return out;
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

/**
 * The words a HUMAN wrote in one message's content, or "" when there are none.
 *
 * Input hygiene, decided on the event's STRUCTURE, never on its topic:
 * - `m.notice` is the bridge's own voice (Matrix spec: automated, never typed by
 *   a person; WhatsApp has no way to send one). Its first paragraph is the
 *   bridge's line ("Old photo. Media will be requested from your phone…",
 *   "Failed to bridge voice message…", "Sent an album with 9 images:"); a
 *   caption the person wrote follows after a blank line and is kept.
 * - media sent without a caption carries an empty body, or its file name.
 */
export function humanText(content: Record<string, unknown> | undefined): string {
  const body = typeof content?.body === "string" ? content.body : "";
  if (content?.msgtype === "m.notice") {
    const cut = body.search(/\n\s*\n/);
    return cut < 0 ? "" : body.slice(cut).trim();
  }
  if (typeof content?.filename === "string" && body.trim() === content.filename.trim()) return "";
  return body.trim();
}

/** The event an edit (`m.replace`) rewrites, or null when the event is not an edit. */
function editTarget(e: MatrixEvent): string | null {
  const rel = e.content?.["m.relates_to"] as { rel_type?: unknown; event_id?: unknown } | undefined;
  return rel?.rel_type === "m.replace" && typeof rel.event_id === "string" ? rel.event_id : null;
}

/**
 * Render a room's messages as an ordered transcript, for the readers (the gold
 * lead reading, the business-relevance judgment): human words only.
 *
 * An edit is folded into the message it rewrites (its `m.new_content`, latest
 * edit wins) instead of being a second line; an edit whose original was never
 * mirrored stands at its own place. A message left with no human words (a
 * bridge notice, an uncaptioned photo) is dropped BEFORE the window, so the
 * last `maxLines` are the last lines a person wrote. An empty result means the
 * room holds nothing a person wrote that we can read.
 */
export function renderThread(
  messageEvents: MatrixEvent[],
  ownMxid: string,
  maxLines: number,
): ThreadLine[] {
  const messages = messageEvents.filter((e) => e.type === "m.room.message").sort(compareEvents);
  const ids = new Set(messages.map((m) => m.event_id));
  const edited = new Map<string, Record<string, unknown> | undefined>();
  for (const m of messages) {
    const target = editTarget(m);
    if (target && ids.has(target)) edited.set(target, m.content?.["m.new_content"] as Record<string, unknown> | undefined);
  }
  const lines: ThreadLine[] = [];
  for (const m of messages) {
    const target = editTarget(m);
    if (target && ids.has(target)) continue;
    const content = edited.has(m.event_id)
      ? edited.get(m.event_id)
      : target
        ? ((m.content?.["m.new_content"] as Record<string, unknown> | undefined) ?? m.content)
        : m.content;
    const body = humanText(content);
    if (!body) continue;
    lines.push({
      direction: m.sender === ownMxid ? "outbound" : "inbound",
      at: new Date(m.origin_server_ts).toISOString(),
      body,
    });
  }
  return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
}
