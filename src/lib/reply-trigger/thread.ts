/**
 * PURE: read one mirrored thread and say whether a person is waiting for the
 * brand's answer in it. No database, no model.
 *
 * Channel-agnostic: a thread is the Matrix room of any personal channel we
 * mirror (WhatsApp today, LinkedIn when a send route writes there).
 *
 * The rules (owner 2026-10-15, REPLY-ANY-LEAD-1015, replacing WA-RESPONDER-1012's
 * "campaign threads only" and "hand-typed = taken over for good"):
 *  - EVERY thread counts, whoever opened it (one of our campaigns, the owner by
 *    hand, or the person themselves). Who the brand answers is decided by the
 *    answering pipe's strategy at campaign-service, never filtered here;
 *  - the person's words since the last outbound message are ONE burst: three
 *    messages in a row are one answer to give, not three;
 *  - ANY outbound message ends the burst: one of our sends, or a message the
 *    account typed by hand on the phone. A hand-typed message is just one of
 *    our messages: the person's next words are a new burst;
 *  - only words a human wrote count (`humanText`): a bridge notice, an
 *    uncaptioned photo, an edit of an earlier message are not an answer. A
 *    reaction is not a message at all.
 */
import type { MatrixEvent } from "../matrix/client.js";
import { compareEvents, humanText } from "../matrix/events.js";

/** One send through our send route into this thread (any status). */
export interface RoomSend {
  eventId: string | null;
  campaignId: string | null;
  status: string;
  sentAt: Date | null;
}

export interface BurstMessage {
  eventId: string;
  at: string;
  text: string;
}

export type ThreadReading =
  /** One of our sends into this thread is in flight: its event cannot be told from a hand-typed one yet. */
  | { kind: "send_in_flight" }
  /** Nobody is waiting: the last word in the thread is ours (or the person never wrote). */
  | { kind: "answered" }
  /**
   * The person wrote since our last word. `campaignId` = the last campaign that wrote in the thread
   * before the burst through our send route, null when none did (hand-written or person-opened thread).
   */
  | { kind: "unanswered"; campaignId: string | null; burst: BurstMessage[] };

/** Max characters of one message carried forward (the door caps `item` at 20k). */
export const MESSAGE_TEXT_CAP = 2000;

function editTarget(e: MatrixEvent): string | null {
  const rel = e.content?.["m.relates_to"] as { rel_type?: unknown; event_id?: unknown } | undefined;
  return rel?.rel_type === "m.replace" && typeof rel.event_id === "string" ? rel.event_id : null;
}

type Entry =
  | { at: number; tie: string; kind: "ours"; campaignId: string | null }
  | { at: number; tie: string; kind: "event"; event: MatrixEvent };

export function readThreadForReply(events: MatrixEvent[], ownMxid: string, sends: RoomSend[]): ThreadReading {
  if (sends.some((s) => s.status === "sending")) return { kind: "send_in_flight" };

  const messages = events.filter((e) => e.type === "m.room.message").sort(compareEvents);
  const byId = new Map(messages.map((m) => [m.event_id, m]));
  const sent = sends.filter((s) => s.status === "sent" && s.eventId);
  const ourIds = new Set(sent.map((s) => s.eventId!));

  // Our sends, placed where the mirror put them, or at their send time when the
  // mirror has not carried them in yet (they end a burst either way).
  const entries: Entry[] = [];
  for (const s of sent) {
    const mirrored = byId.get(s.eventId!);
    const at = mirrored ? mirrored.origin_server_ts : s.sentAt?.getTime();
    if (at === undefined) continue;
    entries.push({ at, tie: s.eventId!, kind: "ours", campaignId: s.campaignId });
  }
  for (const m of messages) {
    if (ourIds.has(m.event_id)) continue;
    entries.push({ at: m.origin_server_ts, tie: m.event_id, kind: "event", event: m });
  }
  entries.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));

  let lastCampaignId: string | null = null;
  let campaignOfBurst: string | null = null;
  let burst: BurstMessage[] = [];

  for (const e of entries) {
    if (e.kind === "ours") {
      if (e.campaignId) lastCampaignId = e.campaignId;
      burst = [];
      continue;
    }
    const ev = e.event;
    const target = editTarget(ev);
    if (ev.sender === ownMxid) {
      // An edit of one of our messages is no new word; an empty line is the bridge's.
      if (target) continue;
      if (!humanText(ev.content)) continue;
      // Typed by hand on the account: one of our messages, it ends the burst like any other.
      burst = [];
      continue;
    }
    if (target) continue; // an edit of an earlier message: not a new word
    const text = humanText(ev.content);
    if (!text) continue;
    if (burst.length === 0) campaignOfBurst = lastCampaignId;
    burst.push({ eventId: ev.event_id, at: new Date(ev.origin_server_ts).toISOString(), text: text.slice(0, MESSAGE_TEXT_CAP) });
  }

  if (burst.length === 0) return { kind: "answered" };
  return { kind: "unanswered", campaignId: campaignOfBurst, burst };
}
