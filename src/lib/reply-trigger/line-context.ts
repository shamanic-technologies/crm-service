/**
 * WHAT THE WRITER OF A LEAD EVENT KNOWS ABOUT THE LINE AND THE PERSON (ONE-AI-CONVERSES-1029, owner 2026-10-29:
 * « ON VEUT UNE PUTAIN D'IA QUI CONVERSE AVEC LES LEADS ET LES CLIENTS AU BON MOMENT ET DE LA BONNE FAÇON »).
 *
 * Every burst a person writes on any linked line is ONE Lead event occurrence (./watch.ts); the Lead event
 * campaign's workflow decides and answers. This module builds what the occurrence carries about the line and the
 * person, so the answer leaves from the right number with the right persona (it used to travel only in the hand-off
 * to chat-service's Copilot, SOPHIE-COPILOT-WA-1018, retired by ONE-AI-CONVERSES-1029):
 *  - `receivedOn`: the line the person wrote to (number, account type, persona);
 *  - `answeringLine`: the line the answer leaves from (SOPHIE-ANSWERS-FROM-HER-LINE-1029, owner 2026-10-29: « the
 *    Sophie talk must be from her number »): a `pro_ai` line answers on itself; any other line hands it to one of the
 *    brand's `pro_ai` lines (the one the person already talks with, else the outreach default, else the oldest); none
 *    = the line written to. The send route picks the same line by itself (`fromAccountType`), this states it;
 *  - `sender`: the person's dialable number, name, the emails our records tie to it (COPILOT-WA-REPEAT-1027: never
 *    ask a known person who they are) and `linkedBy {orgId, userId}` when the number is a WhatsApp account linked in
 *    crm (owner 2026-10-18 « FAUX j'ai intégré ces deux nums »: answered with that user's access);
 *  - `thread`: the conversation before the burst on EVERY line of the brand the person talks with (personal lines
 *    never), oldest first, the latest 30, a call the bridge mirrored said in plain words.
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
  type MatrixConnection,
  type ReplyTriggerReport,
} from "../../db/schema.js";
import type { MatrixEvent } from "../matrix/client.js";
import { callNotice, describeCall, editTarget, foldEdits, humanText, phoneFromMxid } from "../matrix/events.js";
import { automationOn, isAccountType, type AccountType } from "../matrix/account-types.js";
import { personaOf, type SenderPersona } from "../matrix/persona.js";
import { overlayVoiceTranscripts } from "../matrix/voice-notes.js";
import { dialablePhone } from "../trigger-door.js";
import type { BurstMessage } from "./thread.js";

/**
 * LEGACY statuses of the retired Copilot hand-off (SOPHIE-COPILOT-WA-1018 → ONE-AI-CONVERSES-1029): rows written
 * before it still carry them (`handed_off` / `copilot` = chat-service took it). Nothing writes them any more.
 */
export const HANDOFF_STATUS = {
  PENDING: "handoff_pending",
  HANDED_OFF: "handed_off",
  FAILED: "handoff_failed",
} as const;
export const HANDOFF_STATUSES: readonly string[] = Object.values(HANDOFF_STATUS);

/** At most this many earlier messages of the conversation travel with an occurrence. */
export const THREAD_MAX = 30;
/** Each thread line is cut to this many characters (the latest words are the burst's own messages). */
export const THREAD_TEXT_MAX = 2000;

export interface ThreadLine {
  at: string;
  direction: "inbound" | "outbound";
  /** `call` = a WhatsApp call the bridge mirrored (COPILOT-WA-REPEAT-1027), its text says it in plain words. */
  kind: "message" | "call";
  text: string;
  /** The brand's number this line happened on, present only when it is NOT the number answering (`fromAccount`). */
  account?: string;
}

/** At most this many emails travel as `sender.knownEmails`. */
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
 * PURE: a burst message as the writer reads it: a call the bridge mirrored is
 * said in plain words (its body is the bridge's "Incoming call. Use the
 * WhatsApp app to answer.", an instruction to a Matrix user, not the person's).
 */
export function burstInWords(messages: BurstMessage[], events: MatrixEvent[], ownMxid: string): BurstMessage[] {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  return messages.map((m) => {
    const e = byId.get(m.eventId);
    const call = e ? callNotice(e.content) : null;
    return call && e ? { ...m, text: describeCall(call, e.sender === ownMxid ? "outbound" : "inbound") } : m;
  });
}

/**
 * PURE: the conversation BEFORE the burst (messages strictly before its first
 * one), oldest first, the latest `max`. Our sends (campaign,
 * Copilot) are mirrored as the account's messages: outbound. Only human words
 * (`humanText`), edits folded into what they rewrite (`foldEdits`), plus every
 * call the bridge mirrored as a `kind: "call"` line in its time order.
 */
export function threadBeforeBurst(
  events: MatrixEvent[],
  ownMxid: string,
  burstFirstEventId: string,
  burstFirstAt: string,
  max: number = THREAD_MAX,
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
  return lines.slice(-THREAD_MAX);
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
 * person talks with, oldest first, the latest `THREAD_MAX`, each text cut at `THREAD_TEXT_MAX`. A line on
 * another number than the one answering carries `account`.
 */
export function threadAcrossLines(rooms: PersonRoom[], answeringAccount: string, burstFirstEventId: string, burstFirstAt: string): ThreadLine[] {
  const lines = rooms.flatMap((room) =>
    threadBeforeBurst(room.events, room.ownMxid, burstFirstEventId, burstFirstAt, Infinity).map((l) =>
      room.account && room.account !== answeringAccount ? { ...l, account: room.account } : l,
    ),
  );
  // Stable: lines of one room keep their order on a tie.
  return lines
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-THREAD_MAX)
    .map((l) => (l.text.length > THREAD_TEXT_MAX ? { ...l, text: l.text.slice(0, THREAD_TEXT_MAX) } : l));
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

/** A line as an occurrence names it: its number, its type, its persona. */
export interface LineView {
  account: string;
  accountType: AccountType | null;
  name: string | null;
  role: string | null;
  instructions: string | null;
}

/** What a Lead event occurrence carries about the line and the person (`item.line`, `item.sender`, `item.thread`). */
export interface LineContext {
  line: { receivedOn: LineView; answeringLine: LineView };
  sender: { phone?: string; name?: string; linkedBy?: LinkedBy; knownEmails?: string[] };
  thread: ThreadLine[];
}

/** PURE: a brand line as the occurrence names it. */
export function lineView(l: Pick<BrandLine, "account" | "accountType" | "persona">): LineView {
  return {
    account: l.account,
    accountType: l.accountType,
    name: l.persona?.name ?? null,
    role: l.persona?.role ?? null,
    instructions: l.persona?.instructions ?? null,
  };
}

/** PURE: the context an occurrence carries. Absent values OMITTED, never null (campaign-service's item is opaque). */
export function lineContextOf(input: {
  received: Pick<BrandLine, "account" | "accountType" | "persona">;
  answering: Pick<BrandLine, "account" | "accountType" | "persona">;
  sender: { phone: string | null; name: string | null; linkedBy?: LinkedBy | null; knownEmails?: string[] };
  thread: ThreadLine[];
}): LineContext {
  const sender: LineContext["sender"] = {};
  if (input.sender.phone) sender.phone = input.sender.phone;
  if (input.sender.name) sender.name = input.sender.name.slice(0, 300);
  if (input.sender.linkedBy) sender.linkedBy = input.sender.linkedBy;
  if (input.sender.knownEmails?.length) sender.knownEmails = input.sender.knownEmails.slice(0, KNOWN_EMAILS_MAX);
  return {
    line: { receivedOn: lineView(input.received), answeringLine: lineView(input.answering) },
    sender,
    thread: input.thread,
  };
}

/** Who wrote: the person's dialable number + name, from what we know of the thread's ghost. */
async function senderOf(
  r: Pick<ReplyTriggerReport, "orgId" | "brandId" | "roomId" | "conversationId">,
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
 * holding the conversation. The writer never asks a known person who they are.
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
  phone: string | null,
): Promise<{ connectionId: string; roomId: string; ownMxid: string }[]> {
  if (lines.length === 0 || (ghosts.length === 0 && !phone)) return [];
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
        ghosts.length > 0
          ? phone
            ? sql`(${inArray(contacts.channelHandle, ghosts)} OR ${contacts.phoneE164} = ${phone})`
            : inArray(contacts.channelHandle, ghosts)
          : eq(contacts.phoneE164, phone!),
      ),
    )
    .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, conversations.id);
  return rows.map((x) => ({ connectionId: x.connectionId, roomId: x.roomId, ownMxid: x.ownMxid }));
}

/**
 * The context of ONE recorded Matrix burst (nothing sent): the line written to, the line answering, who wrote and the
 * conversation before the burst across the brand's lines; plus the burst's messages in words (a call said plainly).
 */
export async function readLineContext(
  r: Pick<ReplyTriggerReport, "orgId" | "brandId" | "roomId" | "conversationId" | "anchorEventId">,
  conn: MatrixConnection,
  messages: BurstMessage[],
): Promise<{ context: LineContext; messages: BurstMessage[] }> {
  const sender = await senderOf(r, conn);
  const lines = await brandLines(conn);
  // A connection with no link (registered by hand) is its own line, untyped.
  const received: BrandLine = lines.find((l) => l.connectionId === conn.id) ?? {
    connectionId: conn.id,
    account: "",
    accountType: null,
    automationAllowed: true,
    outreachDefault: false,
    linkedAt: null,
    persona: null,
  };
  const ghosts = sender.phone ? await personGhosts(sender.ghost, sender.phone) : sender.ghost ? [sender.ghost] : [];
  const talks = await personConversations(lines, ghosts, sender.phone);
  const answering = answeringLine(received, lines, talks.map((t) => t.connectionId));
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
  const context = lineContextOf({
    received,
    answering,
    sender: {
      phone: sender.phone,
      name: sender.name,
      linkedBy: sender.phone ? await linkedByOf(sender.phone) : null,
      knownEmails: sender.phone ? await knownEmailsForSender(conn, sender.phone, sender.personEmails) : knownEmailsOf(sender.personEmails),
    },
    thread: threadAcrossLines(rooms, answering.account, r.anchorEventId, messages[0].at),
  });
  return { context, messages: burstInWords(messages, ownEvents, conn.matrixUserId) };
}
