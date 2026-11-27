/**
 * ANSWER A PERSON IN THEIR OWN CONVERSATION, ON ANY BRIDGED APP (LEAD-REPLY-CHANNEL-1127).
 *
 * Owner 2026-10-13: « never another thread nor another persona »; owner 2026-10-10: « NE CRÉE PLUS JAMAIS DES CAS
 * PARTICULIERS ». A brand links accounts on every app crm bridges (WhatsApp, Telegram, LinkedIn, ...); a person writes
 * to one of them; the Lead event writer must answer in THAT conversation, same app, same account. Before, the only
 * automated write was the WhatsApp send (resolve a phone, open a DM on a WhatsApp line): a client who wrote on Telegram
 * was answered on WhatsApp from another line, another persona (prod 2026-11-27, Distribute.you).
 *
 * One path for every app, no per-app branch: a conversation IS a Matrix room the person wrote in, held by ONE of the
 * brand's linked accounts (its connection). Writing there = a plain `m.room.message` sent as that account into that
 * room; the bridge of that app relays it. Nothing is resolved by phone, no room is opened: the conversation exists.
 *
 *  - `reachConversation`: which conversation (the one named, else the person's conversation holding their LATEST
 *    message, any app) and whether automation may write there, from which account. Sends nothing.
 *  - `sendInConversation`: the same checks, then the text (or 1..5 paced bubbles) into that room as that account.
 *
 * The account rules are the WhatsApp send's (ACCOUNT-TYPES-1028, SOPHIE-WA-1016, SOPHIE-NEVER-SENT-1119), read off the
 * account that holds the conversation: a personal line (`personal_human`) is never written from, an account the brand
 * keeps for its own hand (`automation_allowed` off) neither; an account a human of the brand typed to this person by
 * hand on is theirs (a `pro_ai` account excepted); a person the brand stated not theirs is never written to; the
 * bridge login must be connected. Every refusal is NAMED (`CONVERSATION_REFUSAL_CODES`).
 *
 * Recorded in `whatsapp_sends` with its `channel` (the table holds every automated Matrix send of the brand), so every
 * reader of our own sends (echo, hand-typed, pings, message_sent, sent-after) sees it. Idempotent on the caller's key.
 * No cost: the bridges and the homeserver are ours.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixLinks, people, whatsappSends } from "../../db/schema.js";
import { bridgeLogins } from "./bridge.js";
import type { MatrixChannel } from "./events.js";
import { sendText, setTyping } from "./client.js";
import { automationOn, isAccountType, type AccountType } from "./account-types.js";
import { personaOf, type SenderPersona } from "./persona.js";
import { handTypedByAccount } from "./human-takeover.js";
import { ownSenderSql } from "./own-senders.js";
import { loginStatus } from "../whatsapp/accounts.js";
import { emailKey, normalizeEmail, normalizePhone, phoneKey } from "../people/identity.js";
import { matrixContactKeys, statedNotToBrand } from "../people/stated-not-to-brand.js";
import {
  bubbleDelayMs,
  bubbleKey,
  claim,
  finish,
  MAX_BUBBLES,
  messageInRoom,
  replyToResult,
  SendRefusal,
  txnIdFor,
  type BubblePacing,
  type ReplyToResult,
  type SendRequest,
  type SendRow,
} from "../whatsapp/send.js";
import { endTypingIn } from "../whatsapp/typing.js";

export const CONVERSATION_REFUSAL_CODES = [
  /** No one-to-one conversation of the brand holds a message from this person (or the one named is not the brand's). */
  "no_conversation",
  /**
   * The account holding the conversation may not be written from by automation: a personal line (`personal_human`),
   * or the brand turned automated sends off on it. Nothing is ever written from another account in its place.
   */
  "automation_not_allowed",
  /** The account holding the conversation is no longer linked (unlinked, paused, or registered by hand: no token). */
  "account_not_linked",
  /** The app logged the account out: only a relink brings it back. */
  "account_not_connected",
  /** A human of the brand typed to this person by hand on this account (not a pro_ai account): theirs, not automation's. */
  "human_in_conversation",
  /** The brand stated this person is not someone of theirs. */
  "stated_not_to_brand",
  /** Another call with the same idempotency key is sending right now. */
  "send_in_progress",
] as const;
export type ConversationRefusalCode = (typeof CONVERSATION_REFUSAL_CODES)[number];

/** A conversation as the writer reads it: where it is and who holds it. */
export interface ConversationTarget {
  conversationId: string;
  /** The app ('whatsapp', 'telegram', 'linkedin', ...): the connection's own channel, never inferred. */
  channel: string;
  roomId: string;
  connectionId: string;
  contactId: string;
  /** The person's handle in that app (the bridge ghost). */
  ghost: string | null;
  /** The person's number when the conversation's own contact states one (a WhatsApp ghost does). */
  phone: string | null;
  name: string | null;
  /** When the person last wrote in it (null: never wrote, only when the conversation was named). */
  lastInboundAt: string | null;
}

export interface ConversationAccount {
  linkId: string | null;
  /** The account's own id in that app (a number on WhatsApp / Telegram, a member id on LinkedIn), as the bridge names it. */
  account: string | null;
  accountName: string | null;
  accountType: AccountType | null;
  automationAllowed: boolean;
  persona: SenderPersona | null;
}

interface AccountRow extends ConversationAccount {
  matrixUserId: string;
  accessToken: string | null;
  connStatus: string;
  linkStatus: string | null;
  loginId: string | null;
}

export interface ConversationReachRequest {
  orgId: string;
  brandId: string;
  /** The conversation to answer in (a Lead event's `item.conversationId`). Wins over the person's keys. */
  conversationId: string | null;
  email: string | null;
  phone: string | null;
}

export interface ConversationReachOk {
  reachable: true;
  conversation: Omit<ConversationTarget, "connectionId" | "contactId" | "ghost">;
  fromAccount: Omit<ConversationAccount, "automationAllowed">;
}

export interface ConversationReachRefused {
  reachable: false;
  code: ConversationRefusalCode;
  error: string;
  /** The conversation the answer was about, when one was found: the writer knows WHICH app it could not write on. */
  conversation: ConversationReachOk["conversation"] | null;
  fromAccount: ConversationReachOk["fromAccount"] | null;
}

export class ConversationRefusal extends SendRefusal {
  constructor(
    readonly conversationCode: ConversationRefusalCode,
    message: string,
    readonly target: ConversationTarget | null = null,
    readonly account: ConversationAccount | null = null,
    httpStatus = 422,
  ) {
    // The send row stores the code as text; SendRefusal's type names the WhatsApp codes, this one is wider.
    super(conversationCode as never, message, httpStatus);
  }
}

/** PURE: the conversation holding the person's latest message: most recent inbound first, ties by id. */
export function latestInbound<T extends { lastInboundAt: string | null; conversationId: string }>(rows: T[]): T | null {
  const wrote = rows.filter((r) => r.lastInboundAt);
  wrote.sort((a, b) => Date.parse(b.lastInboundAt!) - Date.parse(a.lastInboundAt!) || a.conversationId.localeCompare(b.conversationId));
  return wrote[0] ?? null;
}

/**
 * PURE: may automation write from this account into this conversation? The WhatsApp send's own account rules, read
 * off the ONE account holding the conversation: never another account in its place. Null = yes.
 */
export function accountRefusal(
  a: Pick<AccountRow, "accountType" | "automationAllowed" | "accessToken" | "connStatus" | "linkStatus" | "loginId" | "account">,
  channel: string,
  handTypedAt: string | null,
): { code: ConversationRefusalCode; error: string } | null {
  const name = `the brand's ${channel} account${a.account ? ` ${a.account}` : ""}`;
  if (a.accountType === "personal_human") {
    return { code: "automation_not_allowed", error: `The conversation is on ${name}, a personal line: automated messages never go out from it.` };
  }
  if (!automationOn(a)) {
    return { code: "automation_not_allowed", error: `The conversation is on ${name}, which the brand does not allow to send automated messages.` };
  }
  if (!a.accessToken || !a.loginId || a.linkStatus !== "linked" || a.connStatus === "paused") {
    return { code: "account_not_linked", error: `The conversation is on ${name}, which is no longer linked (or paused): nothing can be written there.` };
  }
  if (handTypedAt && a.accountType !== "pro_ai") {
    return {
      code: "human_in_conversation",
      error: `Someone of the brand wrote to this person by hand on ${name} (last on ${handTypedAt}): automation never writes from a human's own account in their place.`,
    };
  }
  return null;
}

/** The brand's one-to-one conversations whose contact is one of these, with when the person last wrote. */
async function conversationsOf(orgId: string, brandId: string, where: ReturnType<typeof sql>): Promise<ConversationTarget[]> {
  const rows = (await db.execute(sql`
    SELECT v.id, v.channel, v.room_id, v.connection_id, v.contact_id, c.channel_handle, c.phone_e164, c.full_name,
      (SELECT max(e.origin_server_ts) FROM matrix_raw_events e
        WHERE e.connection_id = v.connection_id AND e.room_id = v.room_id AND e.event_type = 'm.room.message'
          AND NOT ${ownSenderSql(sql`e.sender`, sql`e.connection_id`)}) AS last_inbound_at
    FROM conversations v
    JOIN contacts c ON c.id = v.contact_id
    WHERE v.org_id = ${orgId} AND v.brand_id = ${brandId} AND ${where}
  `)) as unknown as {
    id: string;
    channel: string;
    room_id: string;
    connection_id: string;
    contact_id: string;
    channel_handle: string | null;
    phone_e164: string | null;
    full_name: string | null;
    last_inbound_at: Date | string | null;
  }[];
  return rows.map((r) => ({
    conversationId: r.id,
    channel: r.channel,
    roomId: r.room_id,
    connectionId: r.connection_id,
    contactId: r.contact_id,
    ghost: r.channel_handle,
    phone: r.phone_e164,
    name: r.full_name,
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
  }));
}

/** The person (people index) holding any of these keys: every Matrix conversation of theirs + their keys. */
async function personOf(orgId: string, brandId: string, keys: string[]): Promise<{ identityKeys: string[]; emails: string[]; conversationIds: string[] } | null> {
  for (const key of keys) {
    const [row] = await db
      .select({ identityKeys: people.identityKeys, emails: people.emails, presences: people.presences })
      .from(people)
      .where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), sql`${people.identityKeys} @> ${JSON.stringify([key])}::jsonb`))
      .limit(1);
    if (!row) continue;
    const presences = (row.presences as { source: string; detail?: { conversationId?: unknown } }[]) ?? [];
    return {
      identityKeys: row.identityKeys as string[],
      emails: (row.emails as string[]) ?? [],
      conversationIds: presences
        .filter((p) => p.source === "matrix" && typeof p.detail?.conversationId === "string")
        .map((p) => p.detail!.conversationId as string),
    };
  }
  return null;
}

async function personHoldingConversation(orgId: string, brandId: string, conversationId: string): Promise<{ identityKeys: string[]; emails: string[] } | null> {
  const [row] = await db
    .select({ identityKeys: people.identityKeys, emails: people.emails })
    .from(people)
    .where(
      and(
        eq(people.orgId, orgId),
        eq(people.brandId, brandId),
        sql`${people.presences} @> ${JSON.stringify([{ source: "matrix", detail: { conversationId } }])}::jsonb`,
      ),
    )
    .limit(1);
  return row ? { identityKeys: row.identityKeys as string[], emails: (row.emails as string[]) ?? [] } : null;
}

async function accountOf(connectionId: string): Promise<AccountRow> {
  const [row] = await db
    .select({
      linkId: matrixLinks.id,
      linkStatus: matrixLinks.status,
      loginId: matrixLinks.remoteLoginId,
      remoteName: matrixLinks.remoteName,
      accountType: matrixLinks.accountType,
      automationAllowed: matrixLinks.automationAllowed,
      personaName: matrixLinks.personaName,
      personaRole: matrixLinks.personaRole,
      personaInstructions: matrixLinks.personaInstructions,
      matrixUserId: matrixConnections.matrixUserId,
      accessToken: matrixConnections.accessToken,
      connStatus: matrixConnections.status,
    })
    .from(matrixConnections)
    .leftJoin(matrixLinks, eq(matrixLinks.connectionId, matrixConnections.id))
    .where(eq(matrixConnections.id, connectionId))
    .orderBy(sql`(${matrixLinks.status} = 'linked') DESC NULLS LAST`, sql`${matrixLinks.linkedAt} DESC NULLS LAST`)
    .limit(1);
  if (!row) throw new Error(`[crm-service][conversation-send] connection ${connectionId} not found`);
  const accountType = isAccountType(row.accountType) ? row.accountType : null;
  return {
    linkId: row.linkId,
    account: row.loginId ? (/^\+?\d+$/.test(row.loginId.trim()) ? `+${row.loginId.replace(/\D/g, "")}` : row.loginId) : null,
    accountName: row.remoteName,
    accountType,
    // A connection registered by hand (no link) states no permission: never written from (no token either).
    automationAllowed: row.automationAllowed ?? false,
    persona: personaOf({ personaName: row.personaName ?? null, personaRole: row.personaRole ?? null, personaInstructions: row.personaInstructions ?? null }),
    matrixUserId: row.matrixUserId,
    accessToken: row.accessToken,
    connStatus: row.connStatus,
    linkStatus: row.linkStatus,
    loginId: row.loginId,
  };
}

interface Resolved {
  target: ConversationTarget;
  account: AccountRow;
  personEmails: string[];
}

interface Found {
  target: ConversationTarget;
  person: { identityKeys: string[]; emails: string[] } | null;
}

/** The conversation: the one named, else the person's conversation holding their latest message, any app. */
async function findConversation(req: ConversationReachRequest): Promise<Found> {
  const email = normalizeEmail(req.email);
  const phone = normalizePhone(req.phone);
  const person = await personOf(req.orgId, req.brandId, [...(email ? [emailKey(email)] : []), ...(phone ? [phoneKey(phone)] : [])]);
  if (req.conversationId) {
    const [target] = await conversationsOf(req.orgId, req.brandId, sql`v.id = ${req.conversationId}::uuid`);
    if (!target) throw new ConversationRefusal("no_conversation", `Conversation ${req.conversationId} is not a conversation of this brand.`);
    // The person holding the conversation: their keys (a "not theirs" statement) and the address a send row names.
    return { target, person: person ?? (await personHoldingConversation(req.orgId, req.brandId, target.conversationId)) };
  }
  const ids = person?.conversationIds ?? [];
  const byId = ids.length > 0 ? sql`v.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`;
  const byPhone = phone ? sql`c.phone_e164 = ${phone}` : sql`false`;
  const target = latestInbound(await conversationsOf(req.orgId, req.brandId, sql`(${byId} OR ${byPhone})`));
  if (!target) {
    throw new ConversationRefusal(
      "no_conversation",
      `${email ?? phone ?? "This person"} never wrote to the brand in a conversation on a linked account (WhatsApp, Telegram, LinkedIn...).`,
    );
  }
  return { target, person };
}

/**
 * Every check on the found conversation, in order, sending nothing: the account's rules, the brand's "not theirs"
 * statement, a human's hand on the account, the bridge login. Throws the ConversationRefusal the send answers; a
 * bridge failure propagates (BridgeError).
 */
async function checkConversation(req: ConversationReachRequest, found: Found): Promise<Resolved> {
  const { target, person } = found;
  const account = await accountOf(target.connectionId);
  // The account's own rules first (no read of the person needed to refuse a personal line).
  const early = accountRefusal(account, target.channel, null);
  if (early) throw new ConversationRefusal(early.code, early.error, target, account);
  const contactKeys = matrixContactKeys({
    contactId: target.contactId,
    channel: target.channel,
    channelHandle: target.ghost,
    counterpartPrefix: (await counterpartPrefixOf(target.connectionId)) ?? "",
    phone: target.phone,
  });
  if (await statedNotToBrand(req.orgId, req.brandId, [...(person?.identityKeys ?? []), ...contactKeys])) {
    throw new ConversationRefusal("stated_not_to_brand", "The brand stated this person is not someone of theirs: no automated message is sent.", target, account);
  }
  const handTyped = target.ghost
    ? await handTypedByAccount({ orgId: req.orgId, brandId: req.brandId, channel: target.channel, ghosts: [target.ghost] })
    : new Map<string, { at: string }>();
  const human = accountRefusal(account, target.channel, handTyped.get(target.connectionId)?.at ?? null);
  if (human) throw new ConversationRefusal(human.code, human.error, target, account);
  const status = loginStatus(await bridgeLogins(target.channel as MatrixChannel, account.matrixUserId), account.loginId!);
  if (status.kind === "logged_out") {
    throw new ConversationRefusal(
      "account_not_connected",
      `${target.channel} logged out the brand's account${account.account ? ` ${account.account}` : ""}${status.message ? ` (the bridge says: "${status.message}")` : ""}. Relink it from the Integrations page.`,
      target,
      account,
    );
  }
  // Connected, or reconnecting on its own: the homeserver holds the message until the bridge is back.
  return { target, account, personEmails: person?.emails ?? [] };
}

async function counterpartPrefixOf(connectionId: string): Promise<string | null> {
  const [c] = await db.select({ p: matrixConnections.counterpartPrefix }).from(matrixConnections).where(eq(matrixConnections.id, connectionId));
  return c?.p ?? null;
}

function viewOf(r: Pick<Resolved, "target" | "account">): ConversationReachOk {
  const { target: t, account: a } = r;
  return {
    reachable: true,
    conversation: { conversationId: t.conversationId, channel: t.channel, roomId: t.roomId, phone: t.phone, name: t.name, lastInboundAt: t.lastInboundAt },
    fromAccount: { linkId: a.linkId, account: a.account, accountName: a.accountName, accountType: a.accountType, persona: a.persona },
  };
}

/** CAN AUTOMATION ANSWER THIS PERSON IN THEIR CONVERSATION, AND FROM WHICH ACCOUNT? Nothing sent. */
export async function reachConversation(req: ConversationReachRequest): Promise<ConversationReachOk | ConversationReachRefused> {
  try {
    return viewOf(await checkConversation(req, await findConversation(req)));
  } catch (err) {
    if (!(err instanceof ConversationRefusal)) throw err;
    const view = err.target && err.account ? viewOf({ target: err.target, account: err.account as AccountRow }) : null;
    return {
      reachable: false,
      code: err.conversationCode,
      error: err.message,
      conversation: view?.conversation ?? null,
      fromAccount: view?.fromAccount ?? null,
    };
  }
}

export interface ConversationSendRequest extends ConversationReachRequest {
  runId: string;
  callerRunId: string | null;
  campaignId: string | null;
  idempotencyKey: string;
  /** 1..MAX_BUBBLES texts, sent in order, paced like the WhatsApp bubbles. */
  messages: string[];
  replyToEventId: string | null;
  userId: string | null;
}

export interface ConversationSendResult extends ConversationReachOk {
  /** Never served: the route pulls the sent message into the mirror from it. */
  connectionId: string;
  sendId: string;
  status: "sent";
  duplicate: boolean;
  eventId: string;
  sentAt: string;
  messages: { index: number; sendId: string; eventId: string; sentAt: string; duplicate: boolean }[];
  replyTo?: ReplyToResult;
}

const realPacing: BubblePacing = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };

/**
 * WRITE IN THE PERSON'S CONVERSATION as the account holding it. Every check is decided ONCE before bubble 1
 * (checkConversation); bubbles 2+ go to the same room, same account. Each bubble is its own send row (bubble 1 =
 * the caller's key), idempotent: a retry answers what went out and sends the rest into the room bubble 1 went to.
 */
export async function sendInConversation(req: ConversationSendRequest, pacing: BubblePacing = realPacing): Promise<ConversationSendResult> {
  if (req.messages.length < 1 || req.messages.length > MAX_BUBBLES) {
    throw new Error(`[crm-service][conversation-send] 1..${MAX_BUBBLES} messages expected, got ${req.messages.length}`);
  }
  const base = (i: number, channel: string, email: string | null): SendRequest => ({
    orgId: req.orgId,
    brandId: req.brandId,
    runId: req.runId,
    callerRunId: req.callerRunId,
    campaignId: req.campaignId,
    idempotencyKey: bubbleKey(req.idempotencyKey, i),
    text: req.messages[i],
    email,
    phone: null,
    fromAccount: null,
    skipIfReplied: false,
    userId: req.userId,
    channel,
  });

  // The conversation is found BEFORE the key is claimed, so every row carries the app it goes out on. No conversation
  // = nothing to key a row to: refused, nothing recorded (asking again simply looks again).
  let found: Found | null = null;
  let resolved: Resolved;
  const pending: { index: number; row: SendRow }[] = [];
  const done: { index: number; row: SendRow; duplicate: boolean }[] = [];
  const firstEarlier = await earlierSend(req.orgId, req.brandId, req.idempotencyKey);
  if (!firstEarlier) found = await findConversation(req);
  const firstClaim = await claim(base(0, found?.target.channel ?? "whatsapp", normalizeEmail(req.email) ?? found?.person?.emails[0] ?? null));
  if ("earlier" in firstClaim) {
    // Bubble 1 already decided: a retry reuses its room and account, nothing re-checked.
    const e = firstClaim.earlier;
    if (e.status === "refused") throw new ConversationRefusal(e.errorCode as ConversationRefusalCode, e.error ?? e.errorCode!);
    if (e.status !== "sent") throw new ConversationRefusal("send_in_progress", "A send with this idempotency key is in progress.", null, null, 409);
    const [target] = await conversationsOf(req.orgId, req.brandId, sql`v.connection_id = ${e.connectionId}::uuid AND v.room_id = ${e.roomId}`);
    if (!target) throw new ConversationRefusal("no_conversation", `The conversation the first message went to (${e.roomId}) is gone; the rest was not sent.`);
    resolved = { target, account: await accountOf(target.connectionId), personEmails: e.email ? [e.email] : [] };
    done.push({ index: 0, row: e, duplicate: true });
  } else {
    try {
      resolved = await checkConversation(req, found ?? (await findConversation(req)));
      await finish(firstClaim.row.id, { channel: resolved.target.channel, phone: resolved.target.phone, phoneSource: resolved.target.phone ? "conversation" : null });
    } catch (err) {
      await closeUnsent([firstClaim.row], err);
      throw err;
    }
    pending.push({ index: 0, row: firstClaim.row });
  }
  const { target, account } = resolved;
  const email = (done[0]?.row.email ?? ("row" in firstClaim ? firstClaim.row.email : null)) ?? normalizeEmail(req.email) ?? resolved.personEmails[0] ?? null;

  const quoteFirst = req.replyToEventId && pending.some((p) => p.index === 0) ? await messageInRoom(target.roomId, req.replyToEventId) : false;
  try {
    for (let i = 1; i < req.messages.length; i++) {
      const c = await claim(base(i, target.channel, email), target.phone ? { phone: target.phone, phoneSource: "conversation" } : null);
      if ("row" in c) pending.push({ index: i, row: c.row });
      else if (c.earlier.status === "sent") done.push({ index: i, row: c.earlier, duplicate: true });
      else throw new ConversationRefusal("send_in_progress", "A send with this idempotency key is in progress.", null, null, 409);
    }
    pending.sort((a, b) => a.index - b.index);
    while (pending.length > 0) {
      const { index, row } = pending[0];
      if (index > 0) {
        const pause = bubbleDelayMs(req.messages[index], pacing.random);
        await setTyping(account.accessToken!, target.roomId, account.matrixUserId, true, pause + 2_000);
        await pacing.sleep(pause);
      }
      const eventId = await sendText(
        account.accessToken!,
        target.roomId,
        txnIdFor(req.orgId, req.brandId, bubbleKey(req.idempotencyKey, index)),
        req.messages[index],
        index === 0 && quoteFirst ? req.replyToEventId! : null,
      );
      const sent = await finish(row.id, {
        status: "sent",
        channel: target.channel,
        connectionId: target.connectionId,
        fromAccount: account.account,
        roomId: target.roomId,
        ghostMxid: target.ghost,
        eventId,
        sentAt: new Date(),
      });
      pending.shift();
      done.push({ index, row: sent, duplicate: false });
    }
  } catch (err) {
    await closeUnsent(pending.map((p) => p.row), err instanceof SendRefusal ? new Error(err.message) : err);
    throw err;
  }
  endTypingIn(target.roomId, account.matrixUserId);
  done.sort((a, b) => a.index - b.index);
  const first = done[0].row;
  const replyTo = replyToResult(req.replyToEventId, done[0].duplicate ? "already_sent" : quoteFirst);
  return {
    ...viewOf(resolved),
    connectionId: target.connectionId,
    sendId: first.id,
    status: "sent",
    duplicate: done.every((d) => d.duplicate),
    eventId: first.eventId!,
    sentAt: first.sentAt!.toISOString(),
    messages: done.map((d) => ({ index: d.index, sendId: d.row.id, eventId: d.row.eventId!, sentAt: d.row.sentAt!.toISOString(), duplicate: d.duplicate })),
    ...(replyTo ? { replyTo } : {}),
  };
}

/**
 * Close rows that did not go out: a named refusal is recorded as such (the same key answers it again), anything else
 * `failed` (the same key retries). No staff alert: a conversation on a line automation may not use is an ordinary
 * answer, the brand chose it.
 */
async function closeUnsent(rows: SendRow[], err: unknown): Promise<void> {
  for (const row of rows) {
    if (err instanceof SendRefusal) await finish(row.id, { status: "refused", errorCode: err.code, error: err.message });
    else await finish(row.id, { status: "failed", error: ((err as Error).message ?? String(err)).slice(0, 1000) });
  }
}

/** The send row already holding this key, if any (a retry). */
async function earlierSend(orgId: string, brandId: string, key: string): Promise<SendRow | null> {
  const [row] = await db
    .select()
    .from(whatsappSends)
    .where(and(eq(whatsappSends.orgId, orgId), eq(whatsappSends.brandId, brandId), eq(whatsappSends.idempotencyKey, key)));
  return row ?? null;
}
