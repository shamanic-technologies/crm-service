/**
 * THE COPILOT ANSWERS ON THE ASSISTANT NUMBER (SOPHIE-COPILOT-WA-1018, owner
 * 2026-10-18: « Le copilot devient Sophie, une continuation Web, mais même accès,
 * même règles, même esprit, même personnalité »).
 *
 * A linked account the brand allows automation on, whose brand is the one the
 * Copilot serves (the staff Unibox scope `COPILOT_UNIBOX_ORG_ID` +
 * `COPILOT_UNIBOX_BRAND_ID`, the same scope Copilot turns are filed under), is
 * the Copilot's own line: EVERY burst a person writes there is handed to
 * chat-service (`POST /internal/copilot/channel-messages`), and NO
 * `positive_reply_received` fires for it (one agent answers, never two). No Jev
 * verdict, no own-team skip: the owner and staff test from their own numbers and
 * must get an answer. Kept: history before the watch (`before_watch`) and the
 * human takeover (a human of the brand typed by hand to this person =
 * `human_in_conversation`, one responder).
 *
 * chat-service answers the person itself through `POST /orgs/whatsapp/messages`
 * (idempotency key `copilot:<messageId>`): a send recorded in `whatsapp_sends`,
 * so it ends the burst and is never read as hand-typed.
 *
 * Statuses on `reply_trigger_reports`: `handoff_pending` → `handed_off` (reason
 * `copilot`), `handoff_failed` (retried with backoff for 24h, same messageId),
 * or `skipped` / `copilot_phone_unknown` (a LID ghost no number is known for:
 * chat-service could not answer them).
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixGhostPhones,
  matrixLinks,
  matrixRawEvents,
  people,
  replyTriggerReports,
  type MatrixConnection,
  type ReplyTriggerReport,
} from "../../db/schema.js";
import { isCopilotDestination } from "../copilot/messages.js";
import type { MatrixEvent } from "../matrix/client.js";
import { compareEvents, humanText, phoneFromMxid } from "../matrix/events.js";
import { personaOf, type SenderPersona } from "../matrix/persona.js";
import { dialablePhone } from "../trigger-door.js";
import type { BurstMessage } from "./thread.js";

export const HANDOFF_STATUS = {
  PENDING: "handoff_pending",
  HANDED_OFF: "handed_off",
  FAILED: "handoff_failed",
} as const;
export const HANDOFF_STATUSES: readonly string[] = Object.values(HANDOFF_STATUS);
export const HANDOFF_REASONS = {
  /** Handed to the Copilot (chat-service), which answers the person itself. */
  COPILOT: "copilot",
  /** chat-service did not take it (down, or any answer but 202 / 200 duplicate): retried. */
  COPILOT_UNREACHABLE: "copilot_unreachable",
  /** No dialable number is known for the person (a LID ghost never resolved): nobody to answer. */
  COPILOT_PHONE_UNKNOWN: "copilot_phone_unknown",
} as const;

/** At most this many earlier messages of the conversation travel with a hand-off. */
export const HANDOFF_THREAD_MAX = 30;
export const HANDOFF_TEXT_MAX = 20_000;
const HANDOFF_RETRY_WINDOW_MS = 24 * 3_600_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const HANDOFF_TIMEOUT_MS = 25_000;

/**
 * PURE: is this account the Copilot's own line? Automation allowed on it AND its
 * (org, brand) is the scope the Copilot serves. Anything else = the reply trigger.
 */
export function copilotAnswersOn(conn: Pick<MatrixConnection, "orgId" | "brandId">, automationAllowed: boolean): boolean {
  return automationAllowed && isCopilotDestination(conn.orgId, conn.brandId);
}

export interface ThreadLine {
  at: string;
  direction: "inbound" | "outbound";
  text: string;
}

function isEdit(e: MatrixEvent): boolean {
  const rel = e.content?.["m.relates_to"] as { rel_type?: unknown } | undefined;
  return rel?.rel_type === "m.replace";
}

/**
 * PURE: the conversation BEFORE the burst (messages strictly before its first
 * one), oldest first, the latest `HANDOFF_THREAD_MAX`. Our sends (campaign,
 * Copilot) are mirrored as the account's messages: outbound. Only human words
 * (`humanText`), no edit.
 */
export function threadBeforeBurst(events: MatrixEvent[], ownMxid: string, burstFirstEventId: string, burstFirstAt: string): ThreadLine[] {
  const firstTs = Date.parse(burstFirstAt);
  const lines: ThreadLine[] = [];
  for (const e of [...events].filter((x) => x.type === "m.room.message").sort(compareEvents)) {
    if (e.event_id === burstFirstEventId || e.origin_server_ts >= firstTs || isEdit(e)) continue;
    const text = humanText(e.content);
    if (!text) continue;
    lines.push({ at: new Date(e.origin_server_ts).toISOString(), direction: e.sender === ownMxid ? "outbound" : "inbound", text });
  }
  return lines.slice(-HANDOFF_THREAD_MAX);
}

/** PURE: chat-service's `POST /internal/copilot/channel-messages` body. */
export function copilotHandoffBody(input: {
  messageId: string;
  orgId: string;
  brandId: string;
  accountUserId: string;
  fromAccount: string;
  persona: SenderPersona | null;
  sender: { phone: string; name: string | null };
  messages: BurstMessage[];
  thread: ThreadLine[];
}): Record<string, unknown> {
  const last = input.messages[input.messages.length - 1];
  return {
    channel: "whatsapp",
    messageId: input.messageId,
    orgId: input.orgId,
    brandId: input.brandId,
    accountUserId: input.accountUserId,
    fromAccount: input.fromAccount,
    assistant: {
      name: input.persona?.name ?? null,
      role: input.persona?.role ?? null,
      instructions: input.persona?.instructions ?? null,
    },
    sender: { phone: input.sender.phone, name: input.sender.name },
    text: input.messages.map((m) => m.text).join("\n").slice(0, HANDOFF_TEXT_MAX),
    at: last.at,
    thread: input.thread,
  };
}

/** PURE: when a failed hand-off is next due. */
export function nextHandoffDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  return lastAttemptAt.getTime() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

async function settle(r: ReplyTriggerReport, now: number, set: Partial<ReplyTriggerReport>): Promise<void> {
  await db
    .update(replyTriggerReports)
    .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now) })
    .where(eq(replyTriggerReports.id, r.id));
}

/** Who wrote: the person's dialable number + name, from what we know of the thread's ghost. */
async function senderOf(r: ReplyTriggerReport, conn: MatrixConnection): Promise<{ phone: string | null; name: string | null }> {
  const [row] = await db
    .select({ phone: contacts.phoneE164, ghost: contacts.channelHandle, name: contacts.fullName })
    .from(conversations)
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(conversations.connectionId, conn.id), eq(conversations.roomId, r.roomId!)));
  const ghost = row?.ghost ?? null;
  const resolved = ghost
    ? await db.select({ phone: matrixGhostPhones.phone }).from(matrixGhostPhones).where(eq(matrixGhostPhones.ghostMxid, ghost))
    : [];
  let personName: string | null = null;
  let personPhones: string[] = [];
  if (r.conversationId) {
    const [p] = await db
      .select({ name: people.displayName, phones: people.phones })
      .from(people)
      .where(
        and(
          eq(people.orgId, r.orgId),
          eq(people.brandId, r.brandId),
          sql`${people.presences} @> ${JSON.stringify([{ source: "matrix", detail: { conversationId: r.conversationId } }])}::jsonb`,
        ),
      )
      .limit(1);
    personName = p?.name ?? null;
    personPhones = (p?.phones as string[] | undefined) ?? [];
  }
  const phone = dialablePhone([
    row?.phone,
    ...resolved.map((x) => x.phone),
    ghost ? phoneFromMxid(ghost, conn.counterpartPrefix) : null,
    ...personPhones,
  ]);
  return { phone, name: row?.name ?? personName };
}

/** Hand ONE recorded burst to chat-service. */
export async function handOffBurst(r: ReplyTriggerReport, conn: MatrixConnection, now: number): Promise<{ status: string; reason: string | null }> {
  const sender = await senderOf(r, conn);
  if (!sender.phone) {
    console.warn(
      `[crm-service][copilot-handoff] report ${r.id} (brand ${r.brandId}, room ${r.roomId}): no dialable number is known for the person, ` +
        "the Copilot cannot answer them",
    );
    await settle(r, now, { status: "skipped", reason: HANDOFF_REASONS.COPILOT_PHONE_UNKNOWN, lastError: null, fullName: sender.name });
    return { status: "skipped", reason: HANDOFF_REASONS.COPILOT_PHONE_UNKNOWN };
  }
  const [link] = await db
    .select({
      remoteLoginId: matrixLinks.remoteLoginId,
      personaName: matrixLinks.personaName,
      personaRole: matrixLinks.personaRole,
      personaInstructions: matrixLinks.personaInstructions,
    })
    .from(matrixLinks)
    .where(eq(matrixLinks.connectionId, conn.id))
    .limit(1);
  const events = await db
    .select({ payload: matrixRawEvents.payload })
    .from(matrixRawEvents)
    .where(
      and(eq(matrixRawEvents.connectionId, conn.id), eq(matrixRawEvents.roomId, r.roomId!), eq(matrixRawEvents.eventType, "m.room.message")),
    );
  const messages = r.messages as BurstMessage[];
  const body = copilotHandoffBody({
    messageId: r.anchorEventId,
    orgId: conn.orgId,
    brandId: conn.brandId,
    accountUserId: conn.createdByUserId,
    fromAccount: link?.remoteLoginId ? `+${link.remoteLoginId.replace(/\D/g, "")}` : "",
    persona: link ? personaOf(link) : null,
    sender: { phone: sender.phone, name: sender.name },
    messages,
    thread: threadBeforeBurst(events.map((e) => e.payload as unknown as MatrixEvent), conn.matrixUserId, r.anchorEventId, messages[0].at),
  });
  const who = { phone: sender.phone, fullName: sender.name };
  try {
    if (!body.fromAccount) throw new Error(`the account's link holds no number (connection ${conn.id})`);
    const url = process.env.CHAT_SERVICE_URL;
    const key = process.env.CHAT_SERVICE_API_KEY;
    if (!url || !key) throw new Error("CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY are not set");
    const res = await fetch(`${url.replace(/\/$/, "")}/internal/copilot/channel-messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    });
    const text = await res.text();
    let answer: { status?: unknown } = {};
    try {
      answer = JSON.parse(text);
    } catch {
      // not JSON: judged by its status below
    }
    const ok = (res.status === 202 && answer.status === "accepted") || (res.status === 200 && answer.status === "duplicate");
    if (!ok) throw new Error(`chat-service answered ${res.status}: ${text.slice(0, 500)}`);
    await settle(r, now, { ...who, status: HANDOFF_STATUS.HANDED_OFF, reason: HANDOFF_REASONS.COPILOT, lastError: null, reportedAt: new Date() });
    console.log(
      `[crm-service][copilot-handoff] handed ${messages.length} message(s) from ${sender.phone} on ${body.fromAccount} (brand ${r.brandId}) ` +
        `to the Copilot as ${r.anchorEventId} (${String(answer.status)})`,
    );
    return { status: HANDOFF_STATUS.HANDED_OFF, reason: HANDOFF_REASONS.COPILOT };
  } catch (err) {
    const error = (err as Error).message.slice(0, 1000);
    console.warn(`[crm-service][copilot-handoff] report ${r.id} (brand ${r.brandId}) not handed off, retried: ${error}`);
    await settle(r, now, { ...who, status: HANDOFF_STATUS.FAILED, reason: HANDOFF_REASONS.COPILOT_UNREACHABLE, lastError: error });
    return { status: HANDOFF_STATUS.FAILED, reason: HANDOFF_REASONS.COPILOT_UNREACHABLE };
  }
}

let handingOff = false;

/** Hand every due burst to the Copilot: pending, or failed and past its backoff, inside 24h. */
export async function deliverDueHandoffs(now: number = Date.now()): Promise<{ reportId: string; status: string; reason: string | null }[]> {
  if (handingOff) return [];
  handingOff = true;
  try {
    const due = (
      await db
        .select()
        .from(replyTriggerReports)
        .where(
          and(
            eq(replyTriggerReports.source, "matrix"),
            inArray(replyTriggerReports.status, [HANDOFF_STATUS.PENDING, HANDOFF_STATUS.FAILED]),
            gt(replyTriggerReports.firstMessageAt, new Date(now - HANDOFF_RETRY_WINDOW_MS)),
          ),
        )
        .orderBy(replyTriggerReports.firstMessageAt, replyTriggerReports.id)
    ).filter((r) => nextHandoffDue(r.attempts, r.lastAttemptAt) <= now);
    if (due.length === 0) return [];
    const conns = await db
      .select()
      .from(matrixConnections)
      .where(inArray(matrixConnections.id, [...new Set(due.map((r) => r.connectionId!))]));
    const byId = new Map(conns.map((c) => [c.id, c]));
    const out: { reportId: string; status: string; reason: string | null }[] = [];
    for (const r of due) {
      const conn = byId.get(r.connectionId!);
      if (!conn) continue; // the account was unlinked: nothing to answer from
      out.push({ reportId: r.id, ...(await handOffBurst(r, conn, now)) });
    }
    return out;
  } finally {
    handingOff = false;
  }
}
