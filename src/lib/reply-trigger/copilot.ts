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
 * A sender whose number is a WhatsApp account LINKED in crm (Integrations, any
 * org / brand, status linked) carries `sender.linkedBy {orgId, userId}` = that
 * link's org and the user who linked it (the most recently linked when several):
 * chat-service answers with THAT user's access (owner 2026-10-18 « FAUX j'ai
 * intégré ces deux nums dans l'intégration »). Absent when linked nowhere.
 *
 * SOPHIE ANSWERS FROM HER LINE (SOPHIE-ANSWERS-FROM-HER-LINE-1029, owner 2026-10-29: « ok to
 * have a hello message from the founder, but the Sophie talk must be from her number »): a
 * burst received on a line NOT typed `pro_ai` (a `pro_human` founder line the founder hello
 * went out from) is answered from one of the brand's `pro_ai` lines (`answeringLine`: the one
 * the person already talks with, else the outreach default, else the oldest), with THAT line's
 * persona; `receivedOn` names the line they wrote to. Never a fallback to the line written to:
 * a pro_ai line that cannot send is refused loud by the send. No pro_ai line = answered from
 * the line written to, as before. The thread is the person's conversation on EVERY line of
 * the brand (`personThreadRooms`, personal lines never), so Sophie sees the founder hello and,
 * once they write on her line, still sees it; a line on another number than `fromAccount`
 * carries `account`. A burst on a pro_ai line with no other line's history: byte-identical.
 *
 * Statuses on `reply_trigger_reports`: `handoff_pending` → `handed_off` (reason
 * `copilot`), `handoff_failed` (retried with backoff for 24h, same messageId),
 * or `skipped` / `copilot_phone_unknown` (a LID ghost no number is known for:
 * chat-service could not answer them).
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixGhostPhones,
  matrixLinks,
  matrixRawEvents,
  people,
  whatsappSends,
  replyTriggerReports,
  type MatrixConnection,
  type ReplyTriggerReport,
} from "../../db/schema.js";
import { isCopilotDestination } from "../copilot/messages.js";
import type { MatrixEvent } from "../matrix/client.js";
import { callNotice, describeCall, editTarget, foldEdits, humanText, phoneFromMxid } from "../matrix/events.js";
import { automationOn, isAccountType, type AccountType } from "../matrix/account-types.js";
import { personaOf, type SenderPersona } from "../matrix/persona.js";
import { overlayVoiceTranscripts } from "../matrix/voice-notes.js";
import { dialablePhone } from "../trigger-door.js";
import { ourAutomatedEchoesOn } from "./own-automated.js";
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
  /** Every message of the burst is the echo of one of our own automated sends (SOPHIE-BOT-LOOP-1023): never answered. */
  OWN_AUTOMATED_SEND: "own_automated_send",
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
  /** `call` = a WhatsApp call the bridge mirrored (COPILOT-WA-REPEAT-1027), its text says it in plain words. */
  kind: "message" | "call";
  text: string;
  /** The brand's number this line happened on, present only when it is NOT the number answering (`fromAccount`). */
  account?: string;
}

/** At most this many emails travel as `sender.knownEmails` (chat-service's contract). */
export const KNOWN_EMAILS_MAX = 10;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * PURE: the emails our own records tie to the sender's number, lower-cased,
 * deduplicated, valid only, first stated first, at most `KNOWN_EMAILS_MAX`.
 */
export function knownEmailsOf(...lists: (readonly (string | null | undefined)[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const email = raw?.trim().toLowerCase();
      if (!email || !EMAIL_SHAPE.test(email) || out.includes(email)) continue;
      out.push(email);
      if (out.length === KNOWN_EMAILS_MAX) return out;
    }
  }
  return out;
}

/**
 * PURE: a burst message as the Copilot reads it: a call the bridge mirrored is
 * said in plain words (its body is the bridge's "Incoming call. Use the
 * WhatsApp app to answer.", an instruction to a Matrix user, not the person's).
 */
export function burstForCopilot(messages: BurstMessage[], events: MatrixEvent[], ownMxid: string): BurstMessage[] {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  return messages.map((m) => {
    const e = byId.get(m.eventId);
    const call = e ? callNotice(e.content) : null;
    return call && e ? { ...m, text: describeCall(call, e.sender === ownMxid ? "outbound" : "inbound") } : m;
  });
}

/**
 * PURE: the conversation BEFORE the burst (messages strictly before its first
 * one), oldest first, the latest `HANDOFF_THREAD_MAX`. Our sends (campaign,
 * Copilot) are mirrored as the account's messages: outbound. Only human words
 * (`humanText`), edits folded into what they rewrite (`foldEdits`), plus every
 * call the bridge mirrored as a `kind: "call"` line in its time order.
 */
export function threadBeforeBurst(
  events: MatrixEvent[],
  ownMxid: string,
  burstFirstEventId: string,
  burstFirstAt: string,
  max: number = HANDOFF_THREAD_MAX,
): ThreadLine[] {
  const firstTs = Date.parse(burstFirstAt);
  const lines: ThreadLine[] = [];
  for (const e of foldEdits(events)) {
    if (e.event_id === burstFirstEventId || e.origin_server_ts >= firstTs || editTarget(e)) continue;
    const at = new Date(e.origin_server_ts).toISOString();
    const direction = e.sender === ownMxid ? "outbound" : "inbound";
    const call = callNotice(e.content);
    if (call) {
      lines.push({ at, direction, kind: "call", text: describeCall(call, direction) });
      continue;
    }
    const text = humanText(e.content);
    if (!text) continue;
    lines.push({ at, direction, kind: "message", text });
  }
  return lines.slice(-HANDOFF_THREAD_MAX);
}

/** One of the person's rooms on one of the brand's linked lines: its events and whose account it is. */
export interface PersonRoom {
  /** The line's own number (E.164), "" when its link holds none. */
  account: string;
  ownMxid: string;
  events: MatrixEvent[];
}

/**
 * PURE: the conversation BEFORE the burst across every line of the brand the
 * person talks with, oldest first, the latest `HANDOFF_THREAD_MAX`. A line on
 * another number than the one answering carries `account`.
 */
export function threadAcrossLines(rooms: PersonRoom[], answeringAccount: string, burstFirstEventId: string, burstFirstAt: string): ThreadLine[] {
  const lines = rooms.flatMap((room) =>
    threadBeforeBurst(room.events, room.ownMxid, burstFirstEventId, burstFirstAt, Infinity).map((l) =>
      room.account && room.account !== answeringAccount ? { ...l, account: room.account } : l,
    ),
  );
  // Stable: lines of one room keep their order on a tie.
  return lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-HANDOFF_THREAD_MAX);
}

/** A linked line of the brand, as the answering pick reads it. */
export interface BrandLine {
  connectionId: string;
  account: string;
  accountType: AccountType | null;
  automationAllowed: boolean;
  outreachDefault: boolean;
  linkedAt: Date | null;
  persona: SenderPersona | null;
}

/**
 * PURE: which line answers a burst received on `received`. A pro_ai line
 * answers on itself. Any other line hands the answer to one of the brand's
 * pro_ai lines automation may use: the one the person last talked with
 * (`talkingConnectionIds`, latest first), else the outreach default, else the
 * oldest linked. None = the line written to (the brand typed no assistant).
 */
export function answeringLine(received: BrandLine, lines: BrandLine[], talkingConnectionIds: string[]): BrandLine {
  if (received.accountType === "pro_ai") return received;
  const ai = lines
    .filter((l) => l.accountType === "pro_ai" && automationOn(l) && l.account)
    .sort((a, b) => (a.linkedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.linkedAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  if (ai.length === 0) return received;
  for (const id of talkingConnectionIds) {
    const talking = ai.find((l) => l.connectionId === id);
    if (talking) return talking;
  }
  return ai.find((l) => l.outreachDefault) ?? ai[0];
}

/** Who linked a WhatsApp number in Integrations: the link's org + the user who linked it. */
export interface LinkedBy {
  orgId: string;
  userId: string;
}

/**
 * The WhatsApp account linked in crm with this number (status linked, any org /
 * brand), the most recently linked when several: its org + who linked it. Null
 * when the number is linked nowhere.
 */
export async function linkedByOf(phone: string): Promise<LinkedBy | null> {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  const [row] = await db
    .select({ orgId: matrixLinks.orgId, userId: matrixLinks.createdByUserId })
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.channel, "whatsapp"),
        eq(matrixLinks.status, "linked"),
        isNotNull(matrixLinks.remoteLoginId),
        sql`regexp_replace(${matrixLinks.remoteLoginId}, '[^0-9]', '', 'g') = ${digits}`,
      ),
    )
    .orderBy(sql`${matrixLinks.linkedAt} DESC NULLS LAST`, desc(matrixLinks.id))
    .limit(1);
  return row ?? null;
}

/** PURE: chat-service's `POST /internal/copilot/channel-messages` body. */
export function copilotHandoffBody(input: {
  messageId: string;
  orgId: string;
  brandId: string;
  accountUserId: string;
  fromAccount: string;
  persona: SenderPersona | null;
  /** The line the person wrote to, when another line answers (SOPHIE-ANSWERS-FROM-HER-LINE-1029). */
  receivedOn?: { account: string; persona: SenderPersona | null } | null;
  sender: { phone: string; name: string | null; linkedBy?: LinkedBy | null; knownEmails?: string[] };
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
    ...(input.receivedOn
      ? {
          receivedOn: {
            account: input.receivedOn.account,
            name: input.receivedOn.persona?.name ?? null,
            role: input.receivedOn.persona?.role ?? null,
          },
        }
      : {}),
    sender: {
      phone: input.sender.phone,
      name: input.sender.name,
      ...(input.sender.linkedBy ? { linkedBy: input.sender.linkedBy } : {}),
      ...(input.sender.knownEmails?.length ? { knownEmails: input.sender.knownEmails.slice(0, KNOWN_EMAILS_MAX) } : {}),
    },
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
async function senderOf(
  r: ReplyTriggerReport,
  conn: MatrixConnection,
): Promise<{ phone: string | null; name: string | null; personEmails: string[]; ghost: string | null }> {
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
  let personEmails: string[] = [];
  if (r.conversationId) {
    const [p] = await db
      .select({ name: people.displayName, phones: people.phones, emails: people.emails })
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
    personEmails = (p?.emails as string[] | undefined) ?? [];
  }
  const phone = dialablePhone([
    row?.phone,
    ...resolved.map((x) => x.phone),
    ghost ? phoneFromMxid(ghost, conn.counterpartPrefix) : null,
    ...personPhones,
  ]);
  return { phone, name: row?.name ?? personName, personEmails, ghost };
}

/**
 * The emails our own records tie to the sender's number for the receiving
 * brand (COPILOT-WA-REPEAT-1027, owner 2026-10-27 « BIEN SÛR QU'ON LE
 * CONNAÎT »): every send we made to that number naming the person (newest
 * first: a campaign wrote to them by email first), then the person record
 * holding the conversation. The Copilot never asks a known person who they are.
 */
export async function knownEmailsForSender(
  conn: Pick<MatrixConnection, "orgId" | "brandId">,
  phone: string,
  personEmails: readonly string[],
): Promise<string[]> {
  const sends = await db
    .select({ email: whatsappSends.email })
    .from(whatsappSends)
    .where(
      and(
        eq(whatsappSends.orgId, conn.orgId),
        eq(whatsappSends.brandId, conn.brandId),
        eq(whatsappSends.phone, phone),
        isNotNull(whatsappSends.email),
        inArray(whatsappSends.status, ["sent", "sending"]),
      ),
    )
    .orderBy(desc(whatsappSends.createdAt));
  return knownEmailsOf(
    sends.map((s) => s.email),
    personEmails,
  );
}

/** The brand's linked lines on the connection's channel (status linked), each with its type and persona. */
async function brandLines(conn: MatrixConnection): Promise<BrandLine[]> {
  const rows = await db
    .select({
      connectionId: matrixLinks.connectionId,
      remoteLoginId: matrixLinks.remoteLoginId,
      accountType: matrixLinks.accountType,
      automationAllowed: matrixLinks.automationAllowed,
      outreachDefault: matrixLinks.outreachDefault,
      linkedAt: matrixLinks.linkedAt,
      personaName: matrixLinks.personaName,
      personaRole: matrixLinks.personaRole,
      personaInstructions: matrixLinks.personaInstructions,
    })
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.orgId, conn.orgId),
        eq(matrixLinks.brandId, conn.brandId),
        eq(matrixLinks.channel, conn.channel),
        isNotNull(matrixLinks.connectionId),
        sql`(${matrixLinks.status} = 'linked' OR ${matrixLinks.connectionId} = ${conn.id})`,
      ),
    );
  return rows.map((l) => ({
    connectionId: l.connectionId!,
    account: l.remoteLoginId ? `+${l.remoteLoginId.replace(/\D/g, "")}` : "",
    accountType: isAccountType(l.accountType) ? l.accountType : null,
    automationAllowed: l.automationAllowed,
    outreachDefault: l.outreachDefault,
    linkedAt: l.linkedAt,
    persona: personaOf(l),
  }));
}

/** Every bridge ghost known to be this person: the thread's own, and every ghost resolved to their number. */
async function personGhosts(ghost: string | null, phone: string): Promise<string[]> {
  const resolved = await db.select({ ghost: matrixGhostPhones.ghostMxid }).from(matrixGhostPhones).where(eq(matrixGhostPhones.phone, phone));
  return [...new Set([...(ghost ? [ghost] : []), ...resolved.map((x) => x.ghost)])];
}

/** The person's one-to-one conversations on the brand's lines (by ghost or number), latest activity first. */
async function personConversations(
  lines: BrandLine[],
  ghosts: string[],
  phone: string,
): Promise<{ connectionId: string; roomId: string; ownMxid: string }[]> {
  if (lines.length === 0) return [];
  const rows = await db
    .select({ connectionId: conversations.connectionId, roomId: conversations.roomId, ownMxid: matrixConnections.matrixUserId })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(matrixConnections, eq(matrixConnections.id, conversations.connectionId))
    .where(
      and(
        inArray(
          conversations.connectionId,
          lines.map((l) => l.connectionId),
        ),
        gt(conversations.messageCount, 0),
        ghosts.length > 0 ? sql`(${inArray(contacts.channelHandle, ghosts)} OR ${contacts.phoneE164} = ${phone})` : eq(contacts.phoneE164, phone),
      ),
    )
    .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, conversations.id);
  return rows.map((x) => ({ connectionId: x.connectionId, roomId: x.roomId, ownMxid: x.ownMxid }));
}

/** The hand-off body for ONE recorded burst, nothing sent; `skip` when nobody can be answered. */
export async function buildHandoff(
  r: ReplyTriggerReport,
  conn: MatrixConnection,
): Promise<{ skip: "no_phone"; name: string | null } | { skip: null; sender: { phone: string; name: string | null }; body: Record<string, unknown> }> {
  const sender = await senderOf(r, conn);
  if (!sender.phone) return { skip: "no_phone", name: sender.name };
  const lines = await brandLines(conn);
  const received = lines.find((l) => l.connectionId === conn.id) ?? null;
  const ghosts = await personGhosts(sender.ghost, sender.phone);
  const talks = await personConversations(lines, ghosts, sender.phone);
  const answering = received ? answeringLine(received, lines, talks.map((t) => t.connectionId)) : null;
  // Personal lines never: their chats are the person's own, not the brand's (and never written from).
  const threadRooms = talks.filter((t) => lines.find((l) => l.connectionId === t.connectionId)?.accountType !== "personal_human");
  if (!threadRooms.some((t) => t.connectionId === conn.id && t.roomId === r.roomId)) {
    threadRooms.push({ connectionId: conn.id, roomId: r.roomId!, ownMxid: conn.matrixUserId });
  }
  const rooms: PersonRoom[] = [];
  let ownEvents: MatrixEvent[] = [];
  for (const t of threadRooms) {
    const rows = await db
      .select({ payload: matrixRawEvents.payload })
      .from(matrixRawEvents)
      .where(
        and(eq(matrixRawEvents.connectionId, t.connectionId), eq(matrixRawEvents.roomId, t.roomId), eq(matrixRawEvents.eventType, "m.room.message")),
      );
    const events = await overlayVoiceTranscripts(rows.map((e) => e.payload as unknown as MatrixEvent));
    if (t.connectionId === conn.id && t.roomId === r.roomId) ownEvents = events;
    rooms.push({ account: lines.find((l) => l.connectionId === t.connectionId)?.account ?? "", ownMxid: t.ownMxid, events });
  }
  const messages = r.messages as BurstMessage[];
  const fromAccount = answering?.account ?? "";
  const body = copilotHandoffBody({
    messageId: r.anchorEventId,
    orgId: conn.orgId,
    brandId: conn.brandId,
    accountUserId: conn.createdByUserId,
    fromAccount,
    persona: answering?.persona ?? null,
    receivedOn: received && answering && answering.connectionId !== received.connectionId ? { account: received.account, persona: received.persona } : null,
    sender: {
      phone: sender.phone,
      name: sender.name,
      linkedBy: await linkedByOf(sender.phone),
      knownEmails: await knownEmailsForSender(conn, sender.phone, sender.personEmails),
    },
    messages: burstForCopilot(messages, ownEvents, conn.matrixUserId),
    thread: threadAcrossLines(rooms, fromAccount, r.anchorEventId, messages[0].at),
  });
  return { skip: null, sender: { phone: sender.phone, name: sender.name }, body };
}

/** Hand ONE recorded burst to chat-service. */
export async function handOffBurst(r: ReplyTriggerReport, conn: MatrixConnection, now: number): Promise<{ status: string; reason: string | null }> {
  // A burst recorded before SOPHIE-BOT-LOOP-1023 (or still retried) that is only our own sends' echo: never answered.
  const recorded = r.messages as BurstMessage[];
  const echoes = await ourAutomatedEchoesOn(conn.id, conn.channel, recorded);
  if (recorded.length > 0 && recorded.every((m) => echoes.has(m.eventId))) {
    console.log(`[crm-service][copilot-handoff] report ${r.id} (brand ${r.brandId}): only the echo of our own automated sends, never handed off`);
    await settle(r, now, { status: "skipped", reason: HANDOFF_REASONS.OWN_AUTOMATED_SEND, lastError: null });
    return { status: "skipped", reason: HANDOFF_REASONS.OWN_AUTOMATED_SEND };
  }
  const built = await buildHandoff(r, conn);
  if (built.skip) {
    console.warn(
      `[crm-service][copilot-handoff] report ${r.id} (brand ${r.brandId}, room ${r.roomId}): no dialable number is known for the person, ` +
        "the Copilot cannot answer them",
    );
    await settle(r, now, { status: "skipped", reason: HANDOFF_REASONS.COPILOT_PHONE_UNKNOWN, lastError: null, fullName: built.name });
    return { status: "skipped", reason: HANDOFF_REASONS.COPILOT_PHONE_UNKNOWN };
  }
  const { sender, body } = built;
  const messages = r.messages as BurstMessage[];
  const who = { phone: sender.phone, fullName: sender.name };
  try {
    if (!body.fromAccount) throw new Error(`the answering account's link holds no number (connection ${conn.id})`);
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
