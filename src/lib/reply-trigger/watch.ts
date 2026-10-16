/**
 * THE REPLY TRIGGER: a person who writes to the brand on a personal channel we
 * mirror (WhatsApp today) is reported to campaign-service's trigger door as
 * `positive_reply_received` (the trigger the email path fires for an answer),
 * for the brand and an OFFER. campaign-service files the person on the
 * answering campaign, whose pipe's strategy decides whether to answer them; the
 * responder reads the person's merged timeline from us and answers.
 *
 * EVERY THREAD (owner 2026-10-15, REPLY-ANY-LEAD-1015, « NE CRÉE PLUS JAMAIS DES
 * CAS PARTICULIERS »): whoever opened the thread (one of our campaigns, the
 * owner by hand, the person themselves). Who is answered is the answering
 * pipe's strategy at campaign-service (leads only), never filtered here. What
 * stays here is FACT, not targeting: a human wrote a POSITIVE answer (Jev:
 * interested, asks for info, asks for a meeting; an away message or a "no
 * thanks" is no positive reply, `not_positive`, owner 2026-10-16), one report per unanswered burst, history before the watch never
 * reported, the brand's own team is not a person writing to the brand.
 *
 * WHERE IT RUNS: inside the Matrix sync (the live watch every ~10s on the rooms
 * that just moved, and the 5-min pass over every thread that moved in 24h, which
 * heals a failed live pass), AFTER the mirror wrote the new messages to bronze
 * and rebuilt the conversations. Detection reads bronze, so when we report, the
 * person's timeline (which serves Matrix messages live from bronze) already
 * holds the message. Delivery refuses to report a person whose merged record
 * does not hold the thread yet (`person_not_built`: the brand's people are
 * rebuilt, then it is delivered).
 *
 * Every rule of a thread is `thread.ts`, pure. Here: which threads to read, Jev
 * on whether a PERSON wrote the burst, the record, the offer, the delivery.
 *
 * NEW, ONCE, NEVER HISTORY: `matrix_connections.reply_watch_since` (threads a
 * campaign wrote to, read since 2026-10-12) and `open_reply_watch_since` (every
 * other thread, read since REPLY-ANY-LEAD-1015) are set the first time the watch
 * looks; a message mirrored before them is history (`before_watch`, never
 * reported). One row per burst (UNIQUE on its first message), and
 * campaign-service gets `idempotencyKey = crm:<source>:reply:<first message event id>`.
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  conversationVerdicts,
  conversations,
  matrixConnections,
  matrixRawEvents,
  people,
  peopleScopes,
  replyTriggerReports,
  whatsappSends,
  type MatrixConnection,
  type ReplyTriggerReport,
} from "../../db/schema.js";
import type { MatrixEvent } from "../matrix/client.js";
import { judgeChoices } from "../judgments-client.js";
import { runScopeBuild } from "../people/build.js";
import { normalizeEmail, type Presence } from "../people/identity.js";
import { createRun, updateRun } from "../runs-client.js";
import {
  CampaignRefusal,
  campaignServiceConfigured,
  doorPersonKey,
  FINAL_REFUSAL_STATUSES,
  NO_EMAIL_OR_PHONE,
  readCampaignOffer,
  recordTriggerEvent,
  type DoorIdentity,
} from "../trigger-door.js";
import { phoneFromMxid } from "../matrix/events.js";
import { readBrandOffers } from "../form-trigger/offer.js";
import { ownTeamMatch, readOwnTeam, type OwnTeam } from "./own-team.js";
import { readThreadForReply, type BurstMessage, type RoomSend } from "./thread.js";

const SERVICE_NAME = "crm-service";
const SOURCE = "matrix";
export const POSITIVE_REPLY_TRIGGER = "positive_reply_received";

/** A thread is re-read while it moved in this window (a failed pass heals on the next). */
export const REPLY_LOOKBACK_MS = 24 * 3_600_000;
export const REPORT_RETRY_WINDOW_MS = 24 * 3_600_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const IN_FLIGHT_MS = 2 * 60_000;
/** Below this, an `automated` verdict does not silence a person (coin flips stay human). */
export const AUTOMATED_MIN_CONFIDENCE = 0.75;

/**
 * What a burst says, judged by Jev (one `choice` call per burst). The trigger is
 * `positive_reply_received`, so only a POSITIVE answer rings it: the SAME three
 * kinds the email path calls positive (instantly-service `REPLY_KIND_CLASSIFICATION`:
 * interested, info requested, meeting requested). A "no thanks", a stop, a wrong
 * person, a plain "ok" is no positive reply (owner 2026-10-16, it was reported
 * as one since REPLY-ANY-LEAD-1015).
 */
export const REPLY_KINDS = [
  "interested",
  "info_requested",
  "meeting_requested",
  "not_interested",
  "opt_out",
  "wrong_person",
  "neutral",
  "automated",
] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export const POSITIVE_REPLY_KINDS: readonly ReplyKind[] = ["interested", "info_requested", "meeting_requested"];
/** A burst rings the trigger when Jev's probability that it is positive (the three kinds summed) reaches this. */
export const POSITIVE_MIN_PROBABILITY = 0.5;

const REPLY_KIND_CRITERIA: Record<ReplyKind, string> = {
  interested: "The person shows interest in what the business offers: yes, sounds good, let's talk, tell me more, I want it.",
  info_requested: "The person asks a question about the offer, the price, how it works, or asks for details or documents.",
  meeting_requested:
    "The person asks for, accepts or proposes a call, a meeting or a time slot, or gives a number to be called on.",
  not_interested: "The person declines: not interested, no thanks, not now, already have a solution, too expensive.",
  opt_out: "The person asks to stop: stop writing, unsubscribe, remove me, do not contact me.",
  wrong_person: "The person says they are not the right contact, changed job, or the message reached the wrong person.",
  neutral:
    "A person wrote, but with no interest, no question and no refusal: ok, thanks, who is this?, a greeting, small talk, an unrelated topic.",
  automated:
    "No person wrote any of them: automatic replies the account sends on its own (an away message, a greeting " +
    "message, 'thanks for contacting us, we will get back to you', an out-of-office), or a system notice.",
};

/** At most this many messages of one burst are carried to campaign-service (the latest ones). */
export const MAX_REPORT_MESSAGES = 10;

export const REPLY_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;
export const REPLY_REASONS = {
  /** The other side is the brand's own team (a linked account or its sales rep phone): never a prospect. */
  OWN_TEAM: "own_team",
  /** Jev: no person wrote it (away message, greeting, auto-reply). */
  AUTOMATED_REPLY: "automated_reply",
  /** Jev: a person wrote, but no positive answer (declined, stop, wrong person, a plain "ok"). */
  NOT_POSITIVE: "not_positive",
  /** Every message of the burst was mirrored before the watch started. */
  BEFORE_WATCH: "before_watch",
  /**
   * The person holds no email AND no international phone: the door cannot name them
   * (REPLY-PHONE-ONLY-1015; a phone-only writer is reported by phone). Older rows say `no_email`.
   */
  NO_EMAIL_OR_PHONE,
  /** The brand's people do not hold this thread yet: rebuilt, then delivered. */
  PERSON_NOT_BUILT: "person_not_built",
  OFFER_UNKNOWN: "offer_unknown",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
} as const;

export interface ReplyDetection {
  connectionId: string;
  baseline: boolean;
  threadsRead: number;
  detected: number;
  skipped: { reason: string; roomId: string }[];
  error?: string;
}

/** PURE: when a failed report is next due. */
export function nextAttemptDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  return lastAttemptAt.getTime() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

export const idempotencyKeyFor = (anchorEventId: string) => `crm:${SOURCE}:reply:${anchorEventId}`;

/**
 * The threads (one-to-one conversations: a group is no conversation) of this
 * connection that moved in the lookback, restricted to `onlyRooms` when given
 * (the live watch reads only what it just mirrored). `campaign` = one of our
 * campaigns wrote in it through our send route (its watch started earlier).
 */
async function threadsThatMoved(
  conn: MatrixConnection,
  now: number,
  onlyRooms?: string[],
): Promise<{ roomId: string; campaign: boolean }[]> {
  if (onlyRooms && onlyRooms.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT v.room_id,
      EXISTS (
        SELECT 1 FROM whatsapp_sends s
        WHERE s.connection_id = v.connection_id AND s.room_id = v.room_id AND s.status = 'sent' AND s.campaign_id IS NOT NULL
      ) AS campaign
    FROM conversations v
    WHERE v.connection_id = ${conn.id} AND v.room_id IS NOT NULL
      ${onlyRooms ? sql`AND v.room_id IN (${sql.join(onlyRooms.map((r) => sql`${r}`), sql`, `)})` : sql``}
      AND EXISTS (
        SELECT 1 FROM matrix_raw_events e
        WHERE e.connection_id = v.connection_id AND e.room_id = v.room_id AND e.event_type = 'm.room.message'
          AND e.ingested_at > ${new Date(now - REPLY_LOOKBACK_MS).toISOString()}::timestamptz
      )
  `)) as unknown as { room_id: string; campaign: boolean }[];
  return rows.map((r) => ({ roomId: r.room_id, campaign: r.campaign === true }));
}

export interface Judgment {
  status: "ok" | "failed";
  choice: string | null;
  confidence: number | null;
  model: string | null;
  error: string | null;
  /** Jev's distribution over `REPLY_KINDS` (absent on rows judged before 2026-10-16). */
  probabilities?: Record<string, number>;
  /** P(interested) + P(info_requested) + P(meeting_requested). */
  positive?: number;
}

/** A recorded reason that does not END a burst: a person may still write in it, and the burst is judged again. */
export const PASS_THROUGH_REASONS: readonly string[] = [
  REPLY_REASONS.AUTOMATED_REPLY,
  REPLY_REASONS.BEFORE_WATCH,
  REPLY_REASONS.NOT_POSITIVE,
];

/**
 * PURE: what a judged burst becomes. Jev down = reported (never silence a person
 * because a judge was unavailable); automated >= 0.75 = `automated_reply`; a
 * positive probability >= 0.5 = reported; anything else = `not_positive`.
 */
export function burstVerdict(judgment: Judgment): { report: true } | { report: false; reason: string } {
  if (judgment.status === "failed") return { report: true };
  const p = judgment.probabilities ?? {};
  if ((p.automated ?? 0) >= AUTOMATED_MIN_CONFIDENCE) return { report: false, reason: REPLY_REASONS.AUTOMATED_REPLY };
  if ((judgment.positive ?? 0) >= POSITIVE_MIN_PROBABILITY) return { report: true };
  return { report: false, reason: REPLY_REASONS.NOT_POSITIVE };
}

/** Who a burst's Jev call is billed to and which channel it was written on. */
export interface BurstJudgeIdentity {
  orgId: string;
  userId: string;
  brandId: string;
  channel: string;
  /** For the log line: the connection / scope the burst was read from. */
  where: string;
}

/**
 * Jev: what does this burst say (`REPLY_KINDS`)? One call per burst. The burst
 * judged is every message the person wrote since our last word (and since the
 * watch started), so a later "actually, tell me more" after a "no" is read in
 * its context; the latest words decide.
 */
export async function judgeBurst(who: BurstJudgeIdentity, runId: () => Promise<string>, burst: BurstMessage[]): Promise<Judgment> {
  try {
    const result = await judgeChoices(
      {
        context:
          `A business talks with someone on ${who.channel}. These are the messages that came from that ` +
          "person's account since the business last wrote (or since the start), in order. The latest ones say " +
          "where the person stands now.",
        messages: burst.map((m) => ({ at: m.at, text: m.text })),
      },
      {
        reply: {
          type: "choice",
          instructions: "What do these messages say to the business, as of the latest one?",
          criteria: REPLY_KIND_CRITERIA,
        },
      },
      { orgId: who.orgId, userId: who.userId, runId: await runId(), brandIds: [who.brandId] },
    );
    const a = result.answers?.reply;
    if (!a || !(REPLY_KINDS as readonly string[]).includes(a.choice) || !a.probabilities) {
      throw new Error(`unexpected answer ${JSON.stringify(a)}`);
    }
    const positive = POSITIVE_REPLY_KINDS.reduce((sum, k) => sum + (a.probabilities[k] ?? 0), 0);
    return {
      status: "ok",
      choice: a.choice,
      confidence: a.confidence,
      model: result.model,
      error: null,
      probabilities: a.probabilities,
      positive,
    };
  } catch (err) {
    // Jev down = reported (never silence someone because a judge was unavailable).
    const error = (err as Error).message.slice(0, 500);
    console.error(`[crm-service][reply-trigger] Jev on a burst failed (${who.where}), reported as a reply: ${error}`);
    return { status: "failed", choice: null, confidence: null, model: null, error };
  }
}

/**
 * Read every thread of this connection that moved (or only `opts.rooms`), and
 * record each unanswered burst once (pending) or skipped with its reason.
 * Called by the Matrix sync after bronze + silver; never sends anything.
 * `runId` is asked only when a run is needed (a Jev call, the rep phone read).
 */
export async function detectReplies(
  conn: MatrixConnection,
  runId: () => Promise<string>,
  now: number = Date.now(),
  opts: { rooms?: string[] } = {},
): Promise<ReplyDetection> {
  const out: ReplyDetection = { connectionId: conn.id, baseline: false, threadsRead: 0, detected: 0, skipped: [] };
  if (!conn.replyWatchSince || !conn.openReplyWatchSince) {
    const at = new Date(now);
    if (!conn.replyWatchSince) {
      await db
        .update(matrixConnections)
        .set({ replyWatchSince: at })
        .where(and(eq(matrixConnections.id, conn.id), isNull(matrixConnections.replyWatchSince)));
    }
    if (!conn.openReplyWatchSince) {
      await db
        .update(matrixConnections)
        .set({ openReplyWatchSince: at })
        .where(and(eq(matrixConnections.id, conn.id), isNull(matrixConnections.openReplyWatchSince)));
    }
    out.baseline = true;
    return out;
  }
  const threads = await threadsThatMoved(conn, now, opts.rooms);
  if (threads.length === 0) return out;
  const roomIds = threads.map((t) => t.roomId);

  const sends = await db
    .select({
      roomId: whatsappSends.roomId,
      eventId: whatsappSends.eventId,
      campaignId: whatsappSends.campaignId,
      status: whatsappSends.status,
      sentAt: whatsappSends.sentAt,
      phone: whatsappSends.phone,
    })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.connectionId, conn.id), inArray(whatsappSends.roomId, roomIds)));
  // Read once, only when a burst is about to be recorded (brand-service owns the rep phone).
  let ownTeam: OwnTeam | null = null;
  const team = async () =>
    (ownTeam ??= await readOwnTeam({ orgId: conn.orgId, userId: conn.createdByUserId, runId: await runId(), brandId: conn.brandId }));
  // A send still in flight carries no room yet: any of ours for this brand in flight holds the pass back
  // (its message, mirrored before the send recorded its event id, would read as typed by hand).
  const inFlight = await db
    .select({ id: whatsappSends.id })
    .from(whatsappSends)
    .where(
      and(
        eq(whatsappSends.orgId, conn.orgId),
        eq(whatsappSends.brandId, conn.brandId),
        eq(whatsappSends.status, "sending"),
        // A claim older than this belongs to a dead process (whatsapp/send.ts takes it over).
        gt(whatsappSends.updatedAt, new Date(now - IN_FLIGHT_MS)),
      ),
    )
    .limit(1);

  for (const { roomId, campaign } of threads) {
    const since = (campaign ? conn.replyWatchSince : conn.openReplyWatchSince).getTime();
    const roomSends: RoomSend[] = sends.filter((s) => s.roomId === roomId);
    if (inFlight.length > 0) roomSends.push({ eventId: null, campaignId: null, status: "sending", sentAt: null });
    const rows = await db
      .select({
        payload: matrixRawEvents.payload,
        eventId: matrixRawEvents.eventId,
        ingestedAt: matrixRawEvents.ingestedAt,
        sender: matrixRawEvents.sender,
      })
      .from(matrixRawEvents)
      .where(
        and(
          eq(matrixRawEvents.connectionId, conn.id),
          eq(matrixRawEvents.roomId, roomId),
          eq(matrixRawEvents.eventType, "m.room.message"),
        ),
      );
    out.threadsRead += 1;
    const reading = readThreadForReply(
      rows.map((r) => r.payload as unknown as MatrixEvent),
      conn.matrixUserId,
      roomSends,
    );
    if (reading.kind !== "unanswered") continue;

    // What of this burst is already recorded: a reported / pending / skipped row ends it, except an
    // auto-reply or history, after which a person may still write in the same burst.
    const existing = await db
      .select()
      .from(replyTriggerReports)
      .where(
        and(
          eq(replyTriggerReports.connectionId, conn.id),
          eq(replyTriggerReports.roomId, roomId),
          inArray(replyTriggerReports.anchorEventId, reading.burst.map((m) => m.eventId)),
        ),
      );
    if (existing.some((r) => !PASS_THROUGH_REASONS.includes(r.reason ?? ""))) continue;
    const coveredThrough = Math.max(0, ...existing.map((r) => r.lastMessageAt.getTime()));
    const uncovered = reading.burst.filter((m) => Date.parse(m.at) > coveredThrough);
    if (uncovered.length === 0) continue;

    // Only what was mirrored after the watch started is new; anything before it is history.
    const ingested = new Map(rows.map((r) => [r.eventId, r.ingestedAt.getTime()]));
    const fresh = uncovered.filter((m) => (ingested.get(m.eventId) ?? 0) >= since);
    const burst = fresh.length > 0 ? fresh : uncovered;
    const [conversation] = await db
      .select({ id: conversations.id, contactPhone: contacts.phoneE164 })
      .from(conversations)
      .leftJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(conversations.connectionId, conn.id), eq(conversations.roomId, roomId)));

    // Who is on the other side: the numbers our sends addressed, the mirrored contact, the bridge's ghost.
    const otherSide = [
      ...sends.filter((s) => s.roomId === roomId).map((s) => s.phone),
      conversation?.contactPhone,
      ...rows.filter((r) => r.sender !== conn.matrixUserId).map((r) => phoneFromMxid(r.sender, conn.counterpartPrefix)),
    ];
    const own = fresh.length > 0 ? ownTeamMatch(otherSide, await team()) : null;

    let status: string = REPLY_STATUS.PENDING;
    let reason: string | null = null;
    let judgment: Judgment | null = null;
    if (fresh.length === 0) {
      status = REPLY_STATUS.SKIPPED;
      reason = REPLY_REASONS.BEFORE_WATCH;
    } else if (own) {
      status = REPLY_STATUS.SKIPPED;
      reason = REPLY_REASONS.OWN_TEAM;
    } else {
      judgment = await judgeBurst(
        { orgId: conn.orgId, userId: conn.createdByUserId, brandId: conn.brandId, channel: conn.channel, where: `connection ${conn.id}` },
        runId,
        reading.burst.filter((m) => (ingested.get(m.eventId) ?? 0) >= since),
      );
      const verdict = burstVerdict(judgment);
      if (!verdict.report) {
        status = REPLY_STATUS.SKIPPED;
        reason = verdict.reason;
      }
    }
    const inserted = await db
      .insert(replyTriggerReports)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        source: SOURCE,
        channel: conn.channel,
        connectionId: conn.id,
        roomId,
        conversationId: conversation?.id ?? null,
        anchorEventId: burst[0].eventId,
        campaignId: reading.campaignId,
        messages: burst,
        firstMessageAt: new Date(burst[0].at),
        lastMessageAt: new Date(burst[burst.length - 1].at),
        judgment,
        detectedAt: new Date(now),
        status,
        reason,
      })
      .onConflictDoNothing()
      .returning({ id: replyTriggerReports.id });
    if (inserted.length === 0) continue;
    if (status === REPLY_STATUS.PENDING) out.detected += 1;
    else out.skipped.push({ reason: reason!, roomId });
    console.log(
      `[crm-service][reply-trigger] ${status === REPLY_STATUS.PENDING ? "detected" : `skipped (${reason})`} a reply burst of ` +
        `${burst.length} message(s) in ${conn.channel} room ${roomId} (brand ${conn.brandId}, ` +
        `${reading.campaignId ? `campaign ${reading.campaignId}` : "no campaign wrote in it"}), first ${burst[0].at}` +
        (own ? `: ${own.phone} is ${own.role}, never a prospect` : ""),
    );
  }
  return out;
}

// ─── delivery ───────────────────────────────────────────────────────────────

/** A report of a Matrix thread (source `matrix`): its connection and room are always set. */
type MatrixReport = ReplyTriggerReport & { connectionId: string; roomId: string };

interface PersonRow {
  personId: string | null;
  displayName: string | null;
  emails: string[];
  phones: string[];
  presences: Presence[];
}

/** The brand's merged person holding this mirrored conversation, or null when not built yet. */
async function personOfConversation(orgId: string, brandId: string, conversationId: string): Promise<PersonRow | null> {
  const [row] = await db
    .select({
      personId: people.personId,
      displayName: people.displayName,
      emails: people.emails,
      phones: people.phones,
      presences: people.presences,
    })
    .from(people)
    .where(
      and(
        eq(people.orgId, orgId),
        eq(people.brandId, brandId),
        sql`${people.presences} @> ${JSON.stringify([{ source: "matrix", detail: { conversationId } }])}::jsonb`,
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    personId: row.personId,
    displayName: row.displayName,
    emails: row.emails as string[],
    phones: row.phones as string[],
    presences: row.presences as Presence[],
  };
}

/** The burst as bronze holds it NOW (it may have grown since detection), from its first message. */
async function currentBurst(r: MatrixReport, ownMxid: string): Promise<BurstMessage[]> {
  const rows = await db
    .select({ payload: matrixRawEvents.payload })
    .from(matrixRawEvents)
    .where(
      and(
        eq(matrixRawEvents.connectionId, r.connectionId),
        eq(matrixRawEvents.roomId, r.roomId),
        eq(matrixRawEvents.eventType, "m.room.message"),
      ),
    );
  const sends = await db
    .select({ eventId: whatsappSends.eventId, campaignId: whatsappSends.campaignId, status: whatsappSends.status, sentAt: whatsappSends.sentAt })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.connectionId, r.connectionId), eq(whatsappSends.roomId, r.roomId)));
  const reading = readThreadForReply(rows.map((x) => x.payload as unknown as MatrixEvent), ownMxid, sends);
  const burst = reading.kind === "unanswered" ? reading.burst : [];
  const from = burst.findIndex((m) => m.eventId === r.anchorEventId);
  // Answered since, or the anchor is not in the current burst: what was detected stands.
  return from >= 0 ? burst.slice(from) : (r.messages as BurstMessage[]);
}

export async function settle(r: ReplyTriggerReport, now: number, set: Partial<ReplyTriggerReport>): Promise<void> {
  await db
    .update(replyTriggerReports)
    .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now) })
    .where(eq(replyTriggerReports.id, r.id));
}

/**
 * Which offer the burst is about (campaign-service runs a campaign per (brand, offer)), the first that answers:
 *  1. the offer of the last campaign that wrote in the thread;
 *  2. the offer Jev tagged this conversation about (people/relevance.ts, highest yes-probability);
 *  3. the brand's ONLY active offer.
 * Nothing else: `offerId: null` = offer_unknown, never a guess.
 */
export async function resolveReplyOffer(
  identity: DoorIdentity,
  r: ReplyTriggerReport,
): Promise<{ offerId: string | null; offerBasis: string | null }> {
  if (r.campaignId) return { offerId: await readCampaignOffer(identity, r.campaignId), offerBasis: "campaign" };
  // The conversation Jev judged (people/relevance.ts): a Matrix conversation, or a Gmail address.
  const conversationKey = r.source === "gmail" ? (r.address ? `gmail:${r.address}` : null) : r.conversationId ? `matrix:${r.conversationId}` : null;
  if (conversationKey) {
    const [v] = await db
      .select({ offerIds: conversationVerdicts.offerIds, offerScores: conversationVerdicts.offerScores })
      .from(conversationVerdicts)
      .where(
        and(
          eq(conversationVerdicts.orgId, r.orgId),
          eq(conversationVerdicts.brandId, r.brandId),
          eq(conversationVerdicts.conversationKey, conversationKey),
        ),
      );
    const tagged = pickTaggedOffer((v?.offerIds as string[] | undefined) ?? [], (v?.offerScores as Record<string, number> | null) ?? null);
    if (tagged) return { offerId: tagged, offerBasis: "conversation" };
  }
  const active = (await readBrandOffers(identity)).filter((o) => o.status === "active");
  if (active.length === 1) return { offerId: active[0].offerId, offerBasis: "only_offer" };
  return { offerId: null, offerBasis: null };
}

/** PURE: of the offers Jev tagged a conversation about, the one it is most sure of. */
export function pickTaggedOffer(offerIds: string[], scores: Record<string, number> | null): string | null {
  if (offerIds.length === 0) return null;
  return [...offerIds].sort((a, b) => (scores?.[b] ?? 0) - (scores?.[a] ?? 0) || (a < b ? -1 : 1))[0];
}

/** PURE: the door's body (campaign-service `RecordTriggerEventBody`). Absent values OMITTED, never null. */
export function replyOccurrenceBody(input: {
  brandId: string;
  offerId: string;
  report: Pick<ReplyTriggerReport, "anchorEventId" | "channel" | "campaignId" | "conversationId" | "roomId" | "source">;
  /** Email when held; else `phone` is the E.164 number the door names them by (`doorPersonKey`). */
  person: { email: string | null; name: string | null; phone: string | null; personId: string | null };
  messages: BurstMessage[];
}): Record<string, unknown> {
  const person: Record<string, unknown> = {};
  if (input.person.email) person.email = input.person.email;
  if (input.person.name) person.name = input.person.name.slice(0, 300);
  if (input.person.phone) person.phone = input.person.phone.slice(0, 50);
  // The latest words of a long burst: what there is to answer.
  const messages = input.messages.slice(-MAX_REPORT_MESSAGES);
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    triggerId: POSITIVE_REPLY_TRIGGER,
    brandId: input.brandId,
    offerId: input.offerId,
    idempotencyKey: idempotencyKeyFor(input.report.anchorEventId),
    occurredAt: first.at,
    person,
    item: {
      kind: "reply",
      source: input.report.source,
      channel: input.report.channel,
      // The last campaign that wrote in the thread before the burst; null = none did (hand-written or person-opened).
      campaignId: input.report.campaignId,
      openedBy: input.report.campaignId ? "campaign" : "not_campaign",
      personId: input.person.personId,
      conversationId: input.report.conversationId,
      roomId: input.report.roomId,
      firstMessageAt: first.at,
      lastMessageAt: last.at,
      messages,
    },
  };
}

/**
 * Deliver ONE recorded burst under a run the caller opened. Returns the outcome;
 * `person_not_built` asks the caller to rebuild the brand's people and retry.
 */
export async function deliverReply(
  r: MatrixReport,
  conn: MatrixConnection,
  identity: DoorIdentity,
  now: number,
): Promise<{ status: string; reason: string | null }> {
  if (!r.conversationId) {
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.connectionId, r.connectionId), eq(conversations.roomId, r.roomId)));
    if (conversation) r = { ...r, conversationId: conversation.id };
  }
  const person = r.conversationId ? await personOfConversation(r.orgId, r.brandId, r.conversationId) : null;
  if (!person) {
    await settle(r, now, {
      status: REPLY_STATUS.FAILED,
      reason: REPLY_REASONS.PERSON_NOT_BUILT,
      lastError: "the brand's people do not hold this thread yet",
      conversationId: r.conversationId,
      runId: identity.runId,
    });
    return { status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.PERSON_NOT_BUILT };
  }

  // The address the campaign wrote to, when the person holds it; else the person's first.
  const sentTo = await db
    .selectDistinct({ email: whatsappSends.email })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.connectionId, r.connectionId), eq(whatsappSends.roomId, r.roomId), eq(whatsappSends.status, "sent")));
  const held = new Set(person.emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e));
  const email = sentTo.map((s) => normalizeEmail(s.email)).find((e): e is string => !!e && held.has(e)) ?? [...held][0] ?? null;
  const phone = person.presences.find((p) => p.source === "matrix" && p.detail.conversationId === r.conversationId)?.phones[0] ?? person.phones[0] ?? null;
  // Named by email when held, else by their E.164 phone (a WhatsApp writer usually has only that).
  const key = doorPersonKey(email, phone);
  const who = { personId: person.personId, fullName: person.displayName, email, phone: key?.phone ?? phone, conversationId: r.conversationId };
  if (!key) {
    console.warn(
      `[crm-service][reply-trigger] ${person.displayName ?? phone ?? "a person"} (brand ${r.brandId}) wrote${r.campaignId ? ` after campaign ${r.campaignId}` : ""} ` +
        `on ${r.channel} but holds neither an email nor an international phone: not reported (campaign-service cannot name them). Report ${r.id}`,
    );
    await settle(r, now, { ...who, status: REPLY_STATUS.SKIPPED, reason: REPLY_REASONS.NO_EMAIL_OR_PHONE, lastError: null, runId: identity.runId });
    return { status: REPLY_STATUS.SKIPPED, reason: REPLY_REASONS.NO_EMAIL_OR_PHONE };
  }

  let offerId = r.offerId;
  let offerBasis = r.offerBasis;
  try {
    if (!offerId) ({ offerId, offerBasis } = await resolveReplyOffer(identity, r));
  } catch (err) {
    const final = err instanceof CampaignRefusal && err.status === 404;
    await settle(r, now, {
      ...who,
      status: REPLY_STATUS.FAILED,
      reason: final ? REPLY_REASONS.OFFER_UNKNOWN : REPLY_REASONS.CAMPAIGN_UNREACHABLE,
      lastError: (err as Error).message.slice(0, 1000),
      runId: identity.runId,
    });
    return { status: REPLY_STATUS.FAILED, reason: final ? REPLY_REASONS.OFFER_UNKNOWN : REPLY_REASONS.CAMPAIGN_UNREACHABLE };
  }
  if (!offerId) {
    const lastError = r.campaignId
      ? `campaign ${r.campaignId} states no offer`
      : "no campaign wrote in this thread, Jev tagged it with no offer, and the brand has no single active offer";
    console.warn(`[crm-service][reply-trigger] report ${r.id} (brand ${r.brandId}) not reported: ${lastError}`);
    await settle(r, now, { ...who, status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.OFFER_UNKNOWN, lastError, runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.OFFER_UNKNOWN };
  }

  const messages = await currentBurst(r, conn.matrixUserId);
  const body = replyOccurrenceBody({
    brandId: r.brandId,
    offerId,
    report: r,
    person: { email: key.email, name: person.displayName, phone: key.phone, personId: person.personId },
    messages,
  });
  try {
    const recorded = await recordTriggerEvent(identity, body);
    const reportedAt = new Date();
    await settle(r, now, {
      ...who,
      offerId,
      offerBasis,
      messages,
      lastMessageAt: new Date(messages[messages.length - 1].at),
      status: REPLY_STATUS.REPORTED,
      reason: null,
      lastError: null,
      runId: identity.runId,
      reportedAt,
      campaignEventId: recorded.eventId,
      campaignRecordedAt: recorded.recordedAt,
      campaignOutcome: recorded.event,
    });
    console.log(
      `[crm-service][reply-trigger] reported ${messages.length} message(s) from ${key.email ?? key.phone} (brand ${r.brandId}, offer ${offerId}, ` +
        `campaign ${r.campaignId ?? "-"}, offer from ${offerBasis}) as event ${recorded.eventId}${recorded.replayed ? " (replayed)" : ""}: first message ` +
        `${messages[0].at}, detected ${r.detectedAt.toISOString()}, reported ${reportedAt.toISOString()}, outcome ` +
        `${String(recorded.event.outcome ?? recorded.event.status ?? "-")}${recorded.event.skipReason ? `/${String(recorded.event.skipReason)}` : ""}`,
    );
    return { status: REPLY_STATUS.REPORTED, reason: null };
  } catch (err) {
    const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
    const reason = final ? REPLY_REASONS.CAMPAIGN_REFUSED : REPLY_REASONS.CAMPAIGN_UNREACHABLE;
    console.warn(`[crm-service][reply-trigger] report ${r.id} (brand ${r.brandId}) not reported: ${(err as Error).message}`);
    await settle(r, now, { ...who, offerId, offerBasis, status: REPLY_STATUS.FAILED, reason, lastError: (err as Error).message.slice(0, 1000), runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason };
  }
}

/** Recorded bursts of `source` due a delivery: pending, or failed and past their backoff, inside the window. */
export async function dueReports(now: number, source: string): Promise<ReplyTriggerReport[]> {
  const rows = await db
    .select()
    .from(replyTriggerReports)
    .where(
      and(
        eq(replyTriggerReports.source, source),
        inArray(replyTriggerReports.status, [REPLY_STATUS.PENDING, REPLY_STATUS.FAILED]),
        or(isNull(replyTriggerReports.reason), ne(replyTriggerReports.reason, REPLY_REASONS.CAMPAIGN_REFUSED)),
        gt(replyTriggerReports.firstMessageAt, new Date(now - REPORT_RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(replyTriggerReports.firstMessageAt, replyTriggerReports.id);
  return rows.filter((r) => nextAttemptDue(r.attempts, r.lastAttemptAt) <= now);
}

let delivering = false;

/**
 * Report every due burst: one ORG run per (org, brand). A burst whose person is
 * not built yet makes the brand's people rebuild, then it is delivered at once.
 */
export async function deliverDueReplies(
  now: number = Date.now(),
  opts: { rebuild?: (orgId: string, brandId: string) => Promise<void> } = {},
): Promise<{ reportId: string; status: string; reason: string | null }[]> {
  if (!campaignServiceConfigured() || delivering) return [];
  delivering = true;
  try {
    const delivered: { reportId: string; status: string; reason: string | null }[] = [];
    const groups = new Map<string, MatrixReport[]>();
    for (const r of (await dueReports(now, SOURCE)) as MatrixReport[]) groups.set(`${r.orgId}|${r.brandId}`, [...(groups.get(`${r.orgId}|${r.brandId}`) ?? []), r]);
    for (const reports of groups.values()) {
      const { orgId, brandId } = reports[0];
      const conns = await db
        .select()
        .from(matrixConnections)
        .where(inArray(matrixConnections.id, [...new Set(reports.map((r) => r.connectionId))]));
      const byId = new Map(conns.map((c) => [c.id, c]));
      const userId = conns[0]?.createdByUserId;
      if (!userId) continue; // the connection was removed: nothing to answer from
      const ids = { orgId, userId, brandIds: [brandId] };
      const run = await createRun({ ...ids, serviceName: SERVICE_NAME, taskName: "reply-trigger.report" });
      const identity = { orgId, brandId, userId, runId: run.id };
      let failed = false;
      const notBuilt: MatrixReport[] = [];
      for (const r of reports) {
        const conn = byId.get(r.connectionId);
        if (!conn) continue;
        const outcome = await deliverReply(r, conn, identity, now);
        if (outcome.reason === REPLY_REASONS.PERSON_NOT_BUILT) notBuilt.push(r);
        else if (outcome.status !== REPLY_STATUS.REPORTED) failed = true;
        delivered.push({ reportId: r.id, ...outcome });
      }
      if (notBuilt.length > 0) {
        await (opts.rebuild ?? rebuildBrandPeople)(orgId, brandId);
        for (const stale of notBuilt) {
          const [r] = (await db.select().from(replyTriggerReports).where(eq(replyTriggerReports.id, stale.id))) as MatrixReport[];
          const outcome = await deliverReply(r, byId.get(r.connectionId)!, identity, Date.now());
          if (outcome.status !== REPLY_STATUS.REPORTED && outcome.status !== REPLY_STATUS.SKIPPED) failed = true;
          delivered.push({ reportId: r.id, ...outcome });
        }
      }
      await updateRun(run.id, failed ? "failed" : "completed", { ...ids, runId: run.id });
    }
    return delivered;
  } finally {
    delivering = false;
  }
}

export async function rebuildBrandPeople(orgId: string, brandId: string): Promise<void> {
  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
  if (!scope) return;
  const result = await runScopeBuild(scope);
  if (!result.ok) console.error(`[crm-service][reply-trigger] people rebuild for brand ${brandId} failed: ${result.error}`);
}
