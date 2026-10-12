/**
 * THE REPLY TRIGGER (owner 2026-10-12, WA-RESPONDER-1012): a person who answers,
 * on a personal channel we mirror, a thread one of our campaigns opened through
 * our send route is reported to campaign-service's trigger door as
 * `positive_reply_received` (the trigger the email path fires for an answer),
 * for the brand and the OFFER of the campaign that wrote to them. campaign-service
 * files the person on the responder campaign, makes them due and dispatches it;
 * the responder reads the person's merged timeline from us and answers.
 *
 * WHERE IT RUNS: inside the Matrix sync pass (cron every 5 min, and right after
 * each of our sends), AFTER the mirror wrote the new messages to bronze and
 * rebuilt the conversations. Detection reads bronze, so when we report, the
 * person's timeline (which serves Matrix messages live from bronze) already
 * holds the message. Delivery runs at the end of the pass and refuses to report
 * a person whose merged record does not hold the thread yet (`person_not_built`:
 * the brand's people are rebuilt, then it is delivered).
 *
 * Every rule of a thread (campaign-opened only, one report per unanswered burst,
 * hand-typed = taken over for good, human words only) is `thread.ts`, pure.
 * Here: which threads to read, Jev on whether a PERSON wrote the burst (an
 * auto-reply / away message is not an answer), the record, the delivery.
 *
 * NEW, ONCE, NEVER HISTORY: `matrix_connections.reply_watch_since` is set the
 * first time the watch looks at a connection; a burst none of whose messages
 * was mirrored after it is history (`before_watch`, never reported).
 * One row per burst (UNIQUE on its first message), and campaign-service gets
 * `idempotencyKey = crm:<source>:reply:<first message event id>`.
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
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
  FINAL_REFUSAL_STATUSES,
  readCampaignOffer,
  recordTriggerEvent,
  type DoorIdentity,
} from "../trigger-door.js";
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

export const REPLY_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;
export const REPLY_REASONS = {
  /** A person of ours typed in the thread by hand after the campaign wrote: theirs for good. */
  HUMAN_TOOK_OVER: "human_took_over",
  /** Jev: no person wrote it (away message, greeting, auto-reply). */
  AUTOMATED_REPLY: "automated_reply",
  /** Every message of the burst was mirrored before the watch started. */
  BEFORE_WATCH: "before_watch",
  /** The person holds no email: the door files a person by email only. */
  NO_EMAIL: "no_email",
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

/** Rooms of this connection one of our CAMPAIGNS wrote to, whose thread moved in the lookback. */
async function campaignRoomsThatMoved(conn: MatrixConnection, now: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT s.room_id FROM whatsapp_sends s
    WHERE s.connection_id = ${conn.id} AND s.status = 'sent' AND s.campaign_id IS NOT NULL AND s.room_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM matrix_raw_events e
        WHERE e.connection_id = s.connection_id AND e.room_id = s.room_id AND e.event_type = 'm.room.message'
          AND e.ingested_at > ${new Date(now - REPLY_LOOKBACK_MS).toISOString()}::timestamptz
      )
  `)) as unknown as { room_id: string }[];
  return rows.map((r) => r.room_id);
}

interface Judgment {
  status: "ok" | "failed";
  choice: string | null;
  confidence: number | null;
  model: string | null;
  error: string | null;
}

/** Jev: did a PERSON write this burst, or is it an automatic reply? One call per burst. */
async function judgeBurst(conn: MatrixConnection, runId: string, burst: BurstMessage[]): Promise<Judgment> {
  try {
    const result = await judgeChoices(
      {
        context:
          `A business wrote first to someone on ${conn.channel}. These are the messages that came back from that ` +
          "person's account since, in order.",
        messages: burst.map((m) => ({ at: m.at, text: m.text })),
      },
      {
        sender: {
          type: "choice",
          instructions: "Who wrote these messages: a person, or the account's automatic replies?",
          criteria: {
            person:
              "A person typed at least one of them: any words a human wrote, even very short or negative " +
              "(ok, yes, who is this?, not interested, stop, a question, a price).",
            automated:
              "No person wrote any of them: automatic replies the account sends on its own (an away message, a " +
              "greeting message, 'thanks for contacting us, we will get back to you', an out-of-office), or a system notice.",
          },
        },
      },
      { orgId: conn.orgId, userId: conn.createdByUserId, runId, brandIds: [conn.brandId] },
    );
    const a = result.answers?.sender;
    if (!a || (a.choice !== "person" && a.choice !== "automated")) throw new Error(`unexpected answer ${JSON.stringify(a)}`);
    return { status: "ok", choice: a.choice, confidence: a.confidence, model: result.model, error: null };
  } catch (err) {
    // Jev down = a person (never silence someone because a judge was unavailable).
    const error = (err as Error).message.slice(0, 500);
    console.error(`[crm-service][reply-trigger] Jev on a burst failed (connection ${conn.id}), treated as a person: ${error}`);
    return { status: "failed", choice: null, confidence: null, model: null, error };
  }
}

/**
 * Read every campaign thread of this connection that moved, and record each
 * unanswered burst once (pending) or skipped with its reason. Called by the
 * Matrix sync pass after bronze + silver; never sends anything.
 */
export async function detectReplies(conn: MatrixConnection, runId: string, now: number = Date.now()): Promise<ReplyDetection> {
  const out: ReplyDetection = { connectionId: conn.id, baseline: false, threadsRead: 0, detected: 0, skipped: [] };
  if (!conn.replyWatchSince) {
    await db
      .update(matrixConnections)
      .set({ replyWatchSince: new Date(now) })
      .where(and(eq(matrixConnections.id, conn.id), isNull(matrixConnections.replyWatchSince)));
    out.baseline = true;
    return out;
  }
  const since = conn.replyWatchSince.getTime();
  const roomIds = await campaignRoomsThatMoved(conn, now);
  if (roomIds.length === 0) return out;

  const sends = await db
    .select({
      roomId: whatsappSends.roomId,
      eventId: whatsappSends.eventId,
      campaignId: whatsappSends.campaignId,
      status: whatsappSends.status,
      sentAt: whatsappSends.sentAt,
    })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.connectionId, conn.id), inArray(whatsappSends.roomId, roomIds)));
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

  for (const roomId of roomIds) {
    const roomSends: RoomSend[] = sends.filter((s) => s.roomId === roomId);
    if (inFlight.length > 0) roomSends.push({ eventId: null, campaignId: null, status: "sending", sentAt: null });
    const rows = await db
      .select({ payload: matrixRawEvents.payload, eventId: matrixRawEvents.eventId, ingestedAt: matrixRawEvents.ingestedAt })
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
    if (reading.kind !== "unanswered" && reading.kind !== "taken_over") continue;
    if (reading.burst.length === 0) continue;

    // What of this burst is already recorded: a reported / pending / skipped row ends it,
    // except an auto-reply, after which a person may still write in the same burst.
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
    if (existing.some((r) => r.reason !== REPLY_REASONS.AUTOMATED_REPLY)) continue;
    const coveredThrough = Math.max(0, ...existing.map((r) => r.lastMessageAt.getTime()));
    const uncovered = reading.burst.filter((m) => Date.parse(m.at) > coveredThrough);
    if (uncovered.length === 0) continue;

    const ingested = new Map(rows.map((r) => [r.eventId, r.ingestedAt.getTime()]));
    const fresh = uncovered.some((m) => (ingested.get(m.eventId) ?? 0) >= since);
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.connectionId, conn.id), eq(conversations.roomId, roomId)));

    let status: string = REPLY_STATUS.PENDING;
    let reason: string | null = null;
    let judgment: Judgment | null = null;
    if (!fresh) {
      status = REPLY_STATUS.SKIPPED;
      reason = REPLY_REASONS.BEFORE_WATCH;
    } else if (reading.kind === "taken_over") {
      status = REPLY_STATUS.SKIPPED;
      reason = REPLY_REASONS.HUMAN_TOOK_OVER;
    } else {
      judgment = await judgeBurst(conn, runId, uncovered);
      if (judgment.choice === "automated" && (judgment.confidence ?? 0) >= AUTOMATED_MIN_CONFIDENCE) {
        status = REPLY_STATUS.SKIPPED;
        reason = REPLY_REASONS.AUTOMATED_REPLY;
      }
    }
    const campaignId =
      reading.kind === "unanswered"
        ? reading.campaignId
        : (roomSends.filter((s) => s.campaignId && s.status === "sent").at(-1)?.campaignId ?? "");
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
        anchorEventId: uncovered[0].eventId,
        campaignId,
        messages: uncovered,
        firstMessageAt: new Date(uncovered[0].at),
        lastMessageAt: new Date(uncovered[uncovered.length - 1].at),
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
        `${uncovered.length} message(s) in ${conn.channel} room ${roomId} (brand ${conn.brandId}, campaign ${campaignId || "-"}), ` +
        `first ${uncovered[0].at}` +
        (reading.kind === "taken_over" ? `: the thread was taken over by hand at ${reading.takenOverBy.at}` : ""),
    );
  }
  return out;
}

// ─── delivery ───────────────────────────────────────────────────────────────

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
async function currentBurst(r: ReplyTriggerReport, ownMxid: string): Promise<BurstMessage[]> {
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

async function settle(r: ReplyTriggerReport, now: number, set: Partial<ReplyTriggerReport>): Promise<void> {
  await db
    .update(replyTriggerReports)
    .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now) })
    .where(eq(replyTriggerReports.id, r.id));
}

/** PURE: the door's body (campaign-service `RecordTriggerEventBody`). Absent values OMITTED, never null. */
export function replyOccurrenceBody(input: {
  brandId: string;
  offerId: string;
  report: Pick<ReplyTriggerReport, "anchorEventId" | "channel" | "campaignId" | "conversationId" | "roomId" | "source">;
  person: { email: string; name: string | null; phone: string | null; personId: string | null };
  messages: BurstMessage[];
}): Record<string, unknown> {
  const person: Record<string, unknown> = { email: input.person.email };
  if (input.person.name) person.name = input.person.name.slice(0, 300);
  if (input.person.phone) person.phone = input.person.phone.slice(0, 50);
  const first = input.messages[0];
  const last = input.messages[input.messages.length - 1];
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
      // The campaign whose message they answered (the thread's opener or its latest writer).
      campaignId: input.report.campaignId,
      personId: input.person.personId,
      conversationId: input.report.conversationId,
      roomId: input.report.roomId,
      firstMessageAt: first.at,
      lastMessageAt: last.at,
      messages: input.messages,
    },
  };
}

/**
 * Deliver ONE recorded burst under a run the caller opened. Returns the outcome;
 * `person_not_built` asks the caller to rebuild the brand's people and retry.
 */
export async function deliverReply(
  r: ReplyTriggerReport,
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
  const who = { personId: person.personId, fullName: person.displayName, email, phone, conversationId: r.conversationId };
  if (!email) {
    console.warn(
      `[crm-service][reply-trigger] ${person.displayName ?? phone ?? "a person"} (brand ${r.brandId}) answered campaign ${r.campaignId} ` +
        `on ${r.channel} but holds no email: not reported (campaign-service files a person by email only). Report ${r.id}`,
    );
    await settle(r, now, { ...who, status: REPLY_STATUS.SKIPPED, reason: REPLY_REASONS.NO_EMAIL, lastError: null, runId: identity.runId });
    return { status: REPLY_STATUS.SKIPPED, reason: REPLY_REASONS.NO_EMAIL };
  }

  let offerId = r.offerId;
  try {
    offerId ??= await readCampaignOffer(identity, r.campaignId);
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
    const lastError = `campaign ${r.campaignId} states no offer`;
    console.warn(`[crm-service][reply-trigger] report ${r.id} (brand ${r.brandId}) not reported: ${lastError}`);
    await settle(r, now, { ...who, status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.OFFER_UNKNOWN, lastError, runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.OFFER_UNKNOWN };
  }

  const messages = await currentBurst(r, conn.matrixUserId);
  const body = replyOccurrenceBody({
    brandId: r.brandId,
    offerId,
    report: r,
    person: { email, name: person.displayName, phone, personId: person.personId },
    messages,
  });
  try {
    const recorded = await recordTriggerEvent(identity, body);
    const reportedAt = new Date();
    await settle(r, now, {
      ...who,
      offerId,
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
      `[crm-service][reply-trigger] reported ${messages.length} message(s) from ${email} (brand ${r.brandId}, offer ${offerId}, ` +
        `campaign ${r.campaignId}) as event ${recorded.eventId}${recorded.replayed ? " (replayed)" : ""}: first message ` +
        `${messages[0].at}, detected ${r.detectedAt.toISOString()}, reported ${reportedAt.toISOString()}, outcome ` +
        `${String(recorded.event.outcome ?? recorded.event.status ?? "-")}${recorded.event.skipReason ? `/${String(recorded.event.skipReason)}` : ""}`,
    );
    return { status: REPLY_STATUS.REPORTED, reason: null };
  } catch (err) {
    const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
    const reason = final ? REPLY_REASONS.CAMPAIGN_REFUSED : REPLY_REASONS.CAMPAIGN_UNREACHABLE;
    console.warn(`[crm-service][reply-trigger] report ${r.id} (brand ${r.brandId}) not reported: ${(err as Error).message}`);
    await settle(r, now, { ...who, offerId, status: REPLY_STATUS.FAILED, reason, lastError: (err as Error).message.slice(0, 1000), runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason };
  }
}

/** Recorded bursts due a delivery: pending, or failed and past their backoff, inside the window. */
async function dueReports(now: number): Promise<ReplyTriggerReport[]> {
  const rows = await db
    .select()
    .from(replyTriggerReports)
    .where(
      and(
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
    const groups = new Map<string, ReplyTriggerReport[]>();
    for (const r of await dueReports(now)) groups.set(`${r.orgId}|${r.brandId}`, [...(groups.get(`${r.orgId}|${r.brandId}`) ?? []), r]);
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
      const notBuilt: ReplyTriggerReport[] = [];
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
          const [r] = await db.select().from(replyTriggerReports).where(eq(replyTriggerReports.id, stale.id));
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

async function rebuildBrandPeople(orgId: string, brandId: string): Promise<void> {
  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
  if (!scope) return;
  const result = await runScopeBuild(scope);
  if (!result.ok) console.error(`[crm-service][reply-trigger] people rebuild for brand ${brandId} failed: ${result.error}`);
}
