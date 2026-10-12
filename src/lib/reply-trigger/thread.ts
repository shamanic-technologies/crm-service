/**
 * PURE: read one mirrored thread a campaign may have opened, and say whether a
 * person is waiting for our answer in it. No database, no model.
 *
 * Channel-agnostic: a thread is the Matrix room of any personal channel we
 * mirror (WhatsApp today, LinkedIn when a send route writes there). What makes
 * a thread OURS is a send through our own send route (`RoomSend`), never the
 * channel.
 *
 * The rules (owner 2026-10-12, WA-RESPONDER-1012):
 *  - a thread no campaign wrote to through our send route is never read: the
 *    owner's personal chats are never auto-answered (`not_campaign_thread`);
 *  - only what follows the FIRST campaign send counts: an older personal
 *    history in the same thread is not an answer to anything we sent;
 *  - a message the account sent that is NOT one of our sends (typed by hand on
 *    the phone or the app) after the campaign wrote = a person of ours took the
 *    thread: it is theirs for good (`taken_over`);
 *  - the person's words since the last outbound message (ours) are ONE burst:
 *    three messages in a row are one answer to give, not three;
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
  | { kind: "not_campaign_thread" }
  /** One of our sends into this thread is in flight: its event cannot be told from a hand-typed one yet. */
  | { kind: "send_in_flight" }
  /** Nobody is waiting: the last word since the campaign wrote is ours (or they never wrote). */
  | { kind: "answered" }
  | { kind: "taken_over"; takenOverBy: { eventId: string; at: string }; burst: BurstMessage[] }
  | { kind: "unanswered"; campaignId: string; burst: BurstMessage[] };

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
  const campaignSends = sends.filter((s) => s.status === "sent" && s.campaignId);
  if (campaignSends.length === 0) return { kind: "not_campaign_thread" };
  if (sends.some((s) => s.status === "sending")) return { kind: "send_in_flight" };

  const messages = events.filter((e) => e.type === "m.room.message").sort(compareEvents);
  const byId = new Map(messages.map((m) => [m.event_id, m]));
  const sent = sends.filter((s) => s.status === "sent" && s.eventId);
  const ourIds = new Set(sent.map((s) => s.eventId!));

  // Our sends, placed where the mirror put them, or at their send time when the
  // mirror has not carried them in yet (the thread is ours either way).
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

  const firstCampaignAt = Math.min(
    ...campaignSends.map((s) => {
      const mirrored = s.eventId ? byId.get(s.eventId) : undefined;
      return mirrored ? mirrored.origin_server_ts : (s.sentAt?.getTime() ?? Number.POSITIVE_INFINITY);
    }),
  );
  if (!Number.isFinite(firstCampaignAt)) return { kind: "not_campaign_thread" };

  let started = false;
  let lastCampaignId: string | null = null;
  let campaignOfBurst: string | null = null;
  let takenOverBy: { eventId: string; at: string } | null = null;
  let burst: BurstMessage[] = [];

  for (const e of entries) {
    if (!started) {
      if (e.kind === "ours" && e.campaignId && e.at === firstCampaignAt) started = true;
      else continue;
    }
    if (e.kind === "ours") {
      if (e.campaignId) lastCampaignId = e.campaignId;
      burst = [];
      continue;
    }
    const ev = e.event;
    const target = editTarget(ev);
    if (ev.sender === ownMxid) {
      // An edit of one of our sends is still ours; an empty line is the bridge's.
      if (target && ourIds.has(target)) continue;
      const words = humanText((target ? (ev.content?.["m.new_content"] as Record<string, unknown> | undefined) : undefined) ?? ev.content);
      if (!words) continue;
      takenOverBy ??= { eventId: ev.event_id, at: new Date(ev.origin_server_ts).toISOString() };
      burst = [];
      continue;
    }
    if (target) continue; // an edit of an earlier message: not a new word
    const text = humanText(ev.content);
    if (!text) continue;
    if (burst.length === 0) campaignOfBurst = lastCampaignId;
    burst.push({ eventId: ev.event_id, at: new Date(ev.origin_server_ts).toISOString(), text: text.slice(0, MESSAGE_TEXT_CAP) });
  }

  if (takenOverBy) return { kind: "taken_over", takenOverBy, burst };
  if (burst.length === 0 || !campaignOfBurst) return { kind: "answered" };
  return { kind: "unanswered", campaignId: campaignOfBurst, burst };
}
