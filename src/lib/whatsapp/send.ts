/**
 * SEND one WhatsApp message from the brand's linked WhatsApp account (owner
 * 2026-10-12: a campaign writes first to the brand's product signups, from the
 * brand's own number). The ONE write path of the Matrix integration.
 *
 * How it reaches WhatsApp: the brand's linked account is a mautrix-whatsapp
 * login held by a dedicated Matrix account (lib/matrix/account.ts). The bridge
 * resolves the phone to the WhatsApp user and opens (or finds) the DM room
 * (`resolve_identifier` / `create_dm`); the text is a plain `m.room.message`
 * sent as that account, which the bridge relays to WhatsApp. The message then
 * comes back through the normal mirror (sender == account → outbound), so the
 * person's merged thread shows it and the person counts as written to.
 *
 * Refusals are NAMED, never a bare 500 (`SendRefusal.code`), so a workflow can
 * record why and end its run: see `SEND_REFUSAL_CODES`.
 *
 * Idempotent on the caller's key: a retry answers the first outcome and never
 * sends twice (the row here, and Matrix's own txnId dedupe underneath).
 * No cost: the bridge and the homeserver are ours, WhatsApp charges nothing.
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixLinks, people, whatsappSends } from "../../db/schema.js";
import { createDm, resolveIdentifier } from "../matrix/bridge.js";
import { bridgeSaysNoSuchNumber } from "./number-validity.js";
import { alertRefusal } from "./staff-alert.js";
import { connectedOnly, linkedWhatsappAccounts, personaOf, type SenderPersona, type WhatsappAccount } from "./accounts.js";
import { recordGhostPhone } from "./phone-resolution.js";
import { joinRoom, readRoomBridgeInfo, sendText } from "../matrix/client.js";
import { expectedChannelIds, roomDeliversTo } from "./room-check.js";
import { emailKey, normalizeEmail, normalizePhone, phoneKey, type Presence } from "../people/identity.js";
import { personReplied } from "../people/conversation.js";

export const SEND_REFUSAL_CODES = [
  /** The brand has no linked WhatsApp account (or not the one `fromAccount` names). */
  "whatsapp_not_linked",
  /** Linked, but WhatsApp has logged the account out / it is not connected right now. */
  "whatsapp_not_connected",
  /** No phone given and none known for this person in the brand's CRM. */
  "no_phone_known",
  /**
   * The brand has linked WhatsApp accounts, but none may send automated
   * messages (`automationAllowed` off on every one, or on the one `fromAccount`
   * names). Nothing is sent: an automated message never falls back to an
   * account the brand kept for its own hand (SOPHIE-WA-1016).
   */
  "automation_not_allowed",
  /** WhatsApp says the number has no WhatsApp account (or the number cannot exist: number-validity.ts). */
  "not_on_whatsapp",
  /** `skipIfReplied` and the person has written to the brand on some channel. */
  "person_replied",
  /** Another call with the same idempotency key is sending right now. */
  "send_in_progress",
  /**
   * The DM room the bridge answered for this number delivers to SOMEONE ELSE
   * (its `m.bridge` channel is another person: room-check.ts), and no fresh DM
   * fixed it. Nothing was sent; the room needs repairing on the bridge.
   */
  "wrong_room",
] as const;
export type SendRefusalCode = (typeof SEND_REFUSAL_CODES)[number];

export class SendRefusal extends Error {
  constructor(
    readonly code: SendRefusalCode,
    message: string,
    readonly httpStatus: number = 422,
  ) {
    super(message);
  }
}

export interface SendRequest {
  orgId: string;
  brandId: string;
  runId: string;
  campaignId: string | null;
  idempotencyKey: string;
  text: string;
  email: string | null;
  phone: string | null;
  /** The linked account to send from, as its own number (digits, `+` optional). */
  fromAccount: string | null;
  skipIfReplied: boolean;
  /** Who asked (`x-user-id`), only to read names for a staff alert. */
  userId: string | null;
}

export interface SendResult {
  sendId: string;
  status: "sent";
  /** True when this key had already sent: nothing was sent again. */
  duplicate: boolean;
  to: string;
  phoneSource: string;
  fromAccount: string;
  /** The persona the brand gave the account that sent (null when none stated). */
  persona: SenderPersona | null;
  roomId: string;
  eventId: string;
  sentAt: string;
  /** Messages already sent to this person on WhatsApp through this route BEFORE this one. */
  previousSends: number;
}

/** A send stuck in `sending` this long belongs to a dead process: the key may be taken over. */
const STALE_SENDING_MS = 2 * 60_000;

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Matrix txn id: stable per (org, brand, key), so a retried PUT returns the same event. */
export function txnIdFor(orgId: string, brandId: string, key: string): string {
  return `crmwa-${createHash("sha256").update(`${orgId}|${brandId}|${key}`).digest("hex").slice(0, 40)}`;
}

type SendRow = typeof whatsappSends.$inferSelect;

function resultOf(row: SendRow, duplicate: boolean, previousSends: number, persona: SenderPersona | null): SendResult {
  return {
    sendId: row.id,
    status: "sent",
    duplicate,
    to: row.phone!,
    phoneSource: row.phoneSource!,
    fromAccount: row.fromAccount!,
    persona,
    roomId: row.roomId!,
    eventId: row.eventId!,
    sentAt: row.sentAt!.toISOString(),
    previousSends,
  };
}

/**
 * Claim the idempotency key. Returns the row to send under, or the earlier
 * outcome (sent → its result; refused → the same refusal).
 */
async function claim(req: SendRequest): Promise<{ row: SendRow } | { earlier: SendRow }> {
  const inserted = await db
    .insert(whatsappSends)
    .values({
      orgId: req.orgId,
      brandId: req.brandId,
      idempotencyKey: req.idempotencyKey,
      email: req.email,
      text: req.text,
      status: "sending",
      runId: req.runId,
      campaignId: req.campaignId,
    })
    .onConflictDoNothing({ target: [whatsappSends.orgId, whatsappSends.brandId, whatsappSends.idempotencyKey] })
    .returning();
  if (inserted.length > 0) return { row: inserted[0] };

  // The key exists. A failed send (5xx, transport) or a dead process's claim is
  // taken over; anything else is the earlier outcome.
  const retaken = await db
    .update(whatsappSends)
    .set({ status: "sending", text: req.text, email: req.email, runId: req.runId, error: null, errorCode: null, updatedAt: new Date() })
    .where(
      and(
        eq(whatsappSends.orgId, req.orgId),
        eq(whatsappSends.brandId, req.brandId),
        eq(whatsappSends.idempotencyKey, req.idempotencyKey),
        sql`(${whatsappSends.status} = 'failed' OR (${whatsappSends.status} = 'sending' AND ${whatsappSends.updatedAt} < now() - ${`${STALE_SENDING_MS / 1000} seconds`}::interval))`,
      ),
    )
    .returning();
  if (retaken.length > 0) return { row: retaken[0] };

  const [earlier] = await db
    .select()
    .from(whatsappSends)
    .where(
      and(
        eq(whatsappSends.orgId, req.orgId),
        eq(whatsappSends.brandId, req.brandId),
        eq(whatsappSends.idempotencyKey, req.idempotencyKey),
      ),
    );
  return { earlier };
}

async function finish(id: string, set: Partial<SendRow>): Promise<SendRow> {
  const [row] = await db
    .update(whatsappSends)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(whatsappSends.id, id))
    .returning();
  return row;
}

interface PersonView {
  phones: string[];
  presences: Presence[];
}

/** The brand's merged person holding any of these keys (people/), or null. */
async function findPersonByKeys(orgId: string, brandId: string, keys: string[]): Promise<PersonView | null> {
  for (const key of keys) {
    const [row] = await db
      .select({ phones: people.phones, presences: people.presences })
      .from(people)
      .where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), sql`${people.identityKeys} @> ${JSON.stringify([key])}::jsonb`))
      .limit(1);
    if (row) return { phones: row.phones as string[], presences: row.presences as Presence[] };
  }
  return null;
}

/** Which source told us this person's phone (the presence holding it), for provenance. */
function phoneSourceOf(person: PersonView, phone: string): string {
  const holder = person.presences.find((p) => p.phones.some((x) => normalizePhone(x) === phone));
  return holder ? `crm:${holder.source}` : "crm:evidence";
}

/**
 * The brand's linked WhatsApp accounts allowed for this send (`fromAccount`
 * narrows to one), CONNECTED right now. Refuses with a named code otherwise.
 */
async function sendableAccounts(req: ReachRequest): Promise<WhatsappAccount[]> {
  const wanted = req.fromAccount ? digitsOf(req.fromAccount) : null;
  const linked = (await linkedWhatsappAccounts(req.orgId, req.brandId)).filter((a) => !wanted || digitsOf(a.loginId) === wanted);
  if (linked.length === 0) {
    throw new SendRefusal(
      "whatsapp_not_linked",
      wanted
        ? `The brand has no linked WhatsApp account for +${wanted}.`
        : "The brand has no linked WhatsApp account. Link one from the dashboard first.",
    );
  }
  // Every send through this path is automated (a workflow): an account the brand
  // keeps for its own hand is never picked, even where the person already talks to it.
  const allowed = linked.filter((a) => a.automationAllowed);
  if (allowed.length === 0) {
    throw new SendRefusal(
      "automation_not_allowed",
      wanted
        ? `The brand's WhatsApp account +${wanted} is not allowed to send automated messages.`
        : "None of the brand's linked WhatsApp accounts is allowed to send automated messages. Allow one (or link a dedicated number) from the dashboard.",
    );
  }
  const connected = await connectedOnly(allowed);
  if (connected.length === 0) {
    throw new SendRefusal(
      "whatsapp_not_connected",
      "The brand's WhatsApp is linked but not connected right now (logged out or offline). Relink it from the dashboard.",
    );
  }
  return connected;
}

/**
 * WHICH ACCOUNT WRITES (owner 2026-10-12: « envoie sur le canal WA professionnel,
 * pas mon perso, sauf si on a déjà une conversation commencée dessus »):
 *  1. the account that already has a conversation WITH MESSAGES with this person
 *     (the latest one), so a thread is never restarted from another number;
 *  2. else the account the brand marked as its outreach default;
 *  3. else the oldest linked account.
 * Only accounts the brand allows automated sends from reach here (SOPHIE-WA-1016):
 * a conversation on a disallowed account is not followed, the message starts a
 * new thread from an allowed one.
 * A DM room with no message (WhatsApp opens some on its own) is not a conversation.
 */
export async function chooseAccount(accounts: WhatsappAccount[], ghostMxid: string): Promise<WhatsappAccount> {
  const ids = sql.join(accounts.map((a) => sql`${a.connectionId}::uuid`), sql`, `);
  const [talking] = (await db.execute(sql`
    SELECT v.connection_id FROM conversations v
    JOIN contacts c ON c.id = v.contact_id
    WHERE c.channel_handle = ${ghostMxid} AND v.connection_id IN (${ids}) AND v.message_count > 0
    ORDER BY v.last_message_at DESC NULLS LAST, v.id
    LIMIT 1
  `)) as unknown as { connection_id: string }[];
  return (
    (talking && accounts.find((a) => a.connectionId === talking.connection_id)) ||
    accounts.find((a) => a.outreachDefault) ||
    accounts[0]
  );
}

/** Has the person written to the brand: any channel (people), or on WhatsApp since the last mirror read. */
async function hasReplied(req: ReachRequest, person: PersonView | null, phone: string): Promise<boolean> {
  if (person && personReplied(person.presences)) return true;
  // The people index is rebuilt every 15 min; the WhatsApp mirror every 5. Read
  // the mirror directly for an answer to a message we sent.
  const rows = (await db.execute(sql`
    SELECT 1 FROM conversations v
    JOIN contacts c ON c.id = v.contact_id
    WHERE v.org_id = ${req.orgId} AND v.brand_id = ${req.brandId} AND v.inbound_count > 0
      AND (c.phone_e164 = ${phone}
           OR c.channel_handle IN (SELECT ghost_mxid FROM matrix_ghost_phones WHERE phone = ${phone}))
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

async function countPreviousSends(req: SendRequest, phone: string, excludeId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM whatsapp_sends
    WHERE org_id = ${req.orgId} AND brand_id = ${req.brandId} AND status = 'sent'
      AND phone = ${phone} AND id <> ${excludeId}
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/**
 * Join `roomId` and check, from the bridge's own room state, that it delivers
 * to the person resolved for `phone` on this account's login. A room naming
 * someone else is never written to: the bridge is asked for a fresh DM once,
 * used only when it is ANOTHER room that names the person; otherwise the send
 * is refused `wrong_room`, logged loud. Returns the room (and its ghost) to send into.
 */
async function verifiedRoom(
  account: WhatsappAccount,
  resolvedId: string,
  phone: string,
  target: { roomId: string; ghost: string },
): Promise<{ roomId: string; ghost: string }> {
  const { roomId } = target;
  const check = async (room: string, id: string) => {
    await joinRoom(account.accessToken, room);
    return roomDeliversTo(await readRoomBridgeInfo(account.accessToken, room), expectedChannelIds(id, phone), account.loginId);
  };
  const first = await check(roomId, resolvedId);
  if (first.ok) return target;
  console.error(
    `[crm-service][whatsapp] WRONG ROOM: the bridge answered ${roomId} for ${phone} (from +${digitsOf(account.loginId)}), ` +
      `but the room delivers to ${first.actual}. Not sending there; asking the bridge for a fresh DM.`,
  );
  let freshNote = "";
  try {
    const dm = await createDm("whatsapp", account.matrixUserId, account.loginId, phone);
    if (dm.dmRoomId && dm.dmRoomId !== roomId) {
      const fresh = await check(dm.dmRoomId, dm.id);
      if (fresh.ok) {
        console.error(`[crm-service][whatsapp] WRONG ROOM avoided: ${phone} gets the fresh DM ${dm.dmRoomId} instead of ${roomId}.`);
        return { roomId: dm.dmRoomId, ghost: dm.mxid };
      }
      freshNote = ` The fresh DM ${dm.dmRoomId} delivers to ${fresh.actual} too.`;
    } else {
      freshNote = " The bridge answered the same room again.";
    }
  } catch (err) {
    freshNote = ` Asking for a fresh DM failed: ${(err as Error).message}`;
  }
  const message =
    `The WhatsApp room the bridge answered for ${phone} (${roomId}) delivers to ${first.actual}, not to ${phone}. ` +
    `Nothing was sent.${freshNote}`;
  console.error(`[crm-service][whatsapp] WRONG ROOM refused: ${message}`);
  throw new SendRefusal("wrong_room", message);
}

export interface ReachRequest {
  orgId: string;
  brandId: string;
  email: string | null;
  phone: string | null;
  fromAccount: string | null;
  skipIfReplied: boolean;
}

interface Reach {
  phone: string;
  phoneSource: string;
  accounts: WhatsappAccount[];
  who: Awaited<ReturnType<typeof resolveIdentifier>>;
}

/**
 * Every reachability check of a send, in the send's order: the person's
 * phone (`no_phone_known`), `skipIfReplied` (`person_replied`), the brand's
 * linked + connected accounts (`whatsapp_not_linked` / `whatsapp_not_connected`),
 * then ONE bridge `resolve_identifier` (`not_on_whatsapp`, a number that cannot
 * exist included). Throws the SendRefusal the send answers; a bridge failure on
 * a valid number propagates as BridgeError. `onPhone` lets the send record the
 * phone on its row the moment it is known. Sends nothing.
 */
async function resolveReach(req: ReachRequest, onPhone?: (phone: string, source: string) => Promise<unknown>): Promise<Reach> {
  // 1. Who, at which number.
  const email = normalizeEmail(req.email);
  const askedPhone = normalizePhone(req.phone);
  const person = await findPersonByKeys(req.orgId, req.brandId, [
    ...(email ? [emailKey(email)] : []),
    ...(askedPhone ? [phoneKey(askedPhone)] : []),
  ]);
  let phone = askedPhone;
  let phoneSource = "request";
  if (!phone && person) {
    phone = person.phones.map((p) => normalizePhone(p)).find((p): p is string => !!p) ?? null;
    if (phone) phoneSource = phoneSourceOf(person, phone);
  }
  if (!phone) {
    throw new SendRefusal(
      "no_phone_known",
      email ? `No phone number is known for ${email}.` : "No phone number given and no person named.",
    );
  }
  if (onPhone) await onPhone(phone, phoneSource);

  // 2. Stop when they already answered (follow-ups).
  if (req.skipIfReplied && (await hasReplied(req, person, phone))) {
    throw new SendRefusal("person_replied", "This person has already written to the brand; no follow-up is sent.");
  }

  // 3. Who the number is on WhatsApp (the same answer from every account).
  const accounts = await sendableAccounts(req);
  let who;
  try {
    who = await resolveIdentifier("whatsapp", accounts[0].matrixUserId, accounts[0].loginId, phone);
  } catch (err) {
    const none = bridgeSaysNoSuchNumber(err, phone);
    if (none === "not_on_whatsapp") throw new SendRefusal("not_on_whatsapp", `${phone} is not on WhatsApp.`);
    if (none === "invalid_number") {
      throw new SendRefusal("not_on_whatsapp", `${phone} is not a valid phone number: WhatsApp has no account for it.`);
    }
    throw err;
  }
  // 4. The bridge said this ghost IS this number: recorded, so the mirrored
  //    thread carries the phone and merges with the person.
  await recordGhostPhone(who.mxid, phone, req.orgId, req.brandId);
  return { phone, phoneSource, accounts, who };
}

export interface ReachResult {
  reachable: true;
  to: string;
  phoneSource: string;
  /** The linked account a send would write from right now. */
  fromAccount: string;
  /** That account's sender persona, as the brand stated it (null when none). */
  persona: SenderPersona | null;
}

/**
 * CAN THIS BRAND'S WHATSAPP REACH THIS PERSON, NOW? (LLM-SPEND-NO-SEND-1016)
 * The send's own checks (resolveReach), without sending: a workflow asks
 * before it pays a model to write the message. Writes no send row, posts
 * nothing, opens no room. Throws the SendRefusal the send would answer.
 * Not covered: `wrong_room` (needs joining / opening the room) and a later
 * transient bridge failure.
 */
export async function reachWhatsApp(req: ReachRequest): Promise<ReachResult> {
  const { phone, phoneSource, accounts, who } = await resolveReach(req);
  const account = await chooseAccount(accounts, who.mxid);
  return { reachable: true, to: phone, phoneSource, fromAccount: `+${digitsOf(account.loginId)}`, persona: account.persona };
}

export async function sendWhatsApp(req: SendRequest): Promise<SendResult> {
  const claimed = await claim(req);
  if ("earlier" in claimed) {
    const e = claimed.earlier;
    if (e.status === "sent") return resultOf(e, true, await countPreviousSends(req, e.phone!, e.id), await personaOfConnection(e.connectionId));
    if (e.status === "refused") throw new SendRefusal(e.errorCode as SendRefusalCode, e.error ?? e.errorCode!);
    throw new SendRefusal("send_in_progress", "A send with this idempotency key is in progress.", 409);
  }
  const row = claimed.row;

  try {
    // 1-4. Who, at which number, and who that number is on WhatsApp: the
    //      SAME checks the reach check answers (reachWhatsApp).
    const { phone, phoneSource, accounts, who } = await resolveReach(req, (p, src) => finish(row.id, { phone: p, phoneSource: src }));

    const account = await chooseAccount(accounts, who.mxid);
    const onAccount =
      account === accounts[0] ? who : await resolveIdentifier("whatsapp", account.matrixUserId, account.loginId, phone);
    let roomId = onAccount.dmRoomId;
    let ghost = onAccount.mxid;
    if (!roomId) {
      const dm = await createDm("whatsapp", account.matrixUserId, account.loginId, phone);
      if (!dm.dmRoomId) throw new Error(`[crm-service][whatsapp] create_dm for ${phone} answered no room`);
      roomId = dm.dmRoomId;
      ghost = dm.mxid;
    }

    // 5. The room must deliver to THIS person: never post into a room the
    //    bridge maps to someone else (room-check.ts).
    ({ roomId, ghost } = await verifiedRoom(account, onAccount.id, phone, { roomId, ghost }));

    // 6. Send.
    const eventId = await sendText(account.accessToken, roomId, txnIdFor(req.orgId, req.brandId, req.idempotencyKey), req.text);
    const sent = await finish(row.id, {
      status: "sent",
      connectionId: account.connectionId,
      fromAccount: `+${digitsOf(account.loginId)}`,
      roomId,
      ghostMxid: ghost,
      eventId,
      sentAt: new Date(),
    });
    return resultOf(sent, false, await countPreviousSends(req, phone, sent.id), account.persona);
  } catch (err) {
    if (err instanceof SendRefusal) {
      await finish(row.id, { status: "refused", errorCode: err.code, error: err.message });
      void alertRefusal({
        code: err.code,
        orgId: req.orgId,
        brandId: req.brandId,
        campaignId: req.campaignId,
        runId: req.runId,
        userId: req.userId,
        at: new Date(),
      });
    } else {
      await finish(row.id, { status: "failed", error: (err as Error).message.slice(0, 1000) }).catch((e) =>
        console.error(`[crm-service][whatsapp] could not record failed send ${row.id}:`, e),
      );
    }
    throw err;
  }
}

/** The persona of the account a recorded send went out on (its link, now). */
async function personaOfConnection(connectionId: string | null): Promise<SenderPersona | null> {
  if (!connectionId) return null;
  const [link] = await db
    .select({ personaName: matrixLinks.personaName, personaRole: matrixLinks.personaRole, personaInstructions: matrixLinks.personaInstructions })
    .from(matrixLinks)
    .where(eq(matrixLinks.connectionId, connectionId))
    .limit(1);
  return link ? personaOf(link) : null;
}

/** The connection a send went out on (to pull the sent message into the mirror at once). */
export async function sendConnection(sendId: string): Promise<string | null> {
  const [row] = await db.select({ c: whatsappSends.connectionId }).from(whatsappSends).where(eq(whatsappSends.id, sendId));
  return row?.c ?? null;
}
