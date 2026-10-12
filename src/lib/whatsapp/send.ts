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
import { people, whatsappSends } from "../../db/schema.js";
import { BridgeError, createDm, resolveIdentifier } from "../matrix/bridge.js";
import { connectedOnly, linkedWhatsappAccounts, type WhatsappAccount } from "./accounts.js";
import { recordGhostPhone } from "./phone-resolution.js";
import { joinRoom, sendText } from "../matrix/client.js";
import { emailKey, normalizeEmail, normalizePhone, phoneKey, type Presence } from "../people/identity.js";
import { personReplied } from "../people/conversation.js";

export const SEND_REFUSAL_CODES = [
  /** The brand has no linked WhatsApp account (or not the one `fromAccount` names). */
  "whatsapp_not_linked",
  /** Linked, but WhatsApp has logged the account out / it is not connected right now. */
  "whatsapp_not_connected",
  /** No phone given and none known for this person in the brand's CRM. */
  "no_phone_known",
  /** WhatsApp says the number has no WhatsApp account. */
  "not_on_whatsapp",
  /** `skipIfReplied` and the person has written to the brand on some channel. */
  "person_replied",
  /** Another call with the same idempotency key is sending right now. */
  "send_in_progress",
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
}

export interface SendResult {
  sendId: string;
  status: "sent";
  /** True when this key had already sent: nothing was sent again. */
  duplicate: boolean;
  to: string;
  phoneSource: string;
  fromAccount: string;
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

function resultOf(row: SendRow, duplicate: boolean, previousSends: number): SendResult {
  return {
    sendId: row.id,
    status: "sent",
    duplicate,
    to: row.phone!,
    phoneSource: row.phoneSource!,
    fromAccount: row.fromAccount!,
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
async function sendableAccounts(req: SendRequest): Promise<WhatsappAccount[]> {
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
  const connected = await connectedOnly(linked);
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
async function hasReplied(req: SendRequest, person: PersonView | null, phone: string): Promise<boolean> {
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

export async function sendWhatsApp(req: SendRequest): Promise<SendResult> {
  const claimed = await claim(req);
  if ("earlier" in claimed) {
    const e = claimed.earlier;
    if (e.status === "sent") return resultOf(e, true, await countPreviousSends(req, e.phone!, e.id));
    if (e.status === "refused") throw new SendRefusal(e.errorCode as SendRefusalCode, e.error ?? e.errorCode!);
    throw new SendRefusal("send_in_progress", "A send with this idempotency key is in progress.", 409);
  }
  const row = claimed.row;

  try {
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
    await finish(row.id, { phone, phoneSource });

    // 2. Stop when they already answered (follow-ups).
    if (req.skipIfReplied && (await hasReplied(req, person, phone))) {
      throw new SendRefusal("person_replied", "This person has already written to the brand; no follow-up is sent.");
    }

    // 3. Who the number is on WhatsApp (the same answer from every account),
    //    then which account writes, into which room.
    const accounts = await sendableAccounts(req);
    let who;
    try {
      who = await resolveIdentifier("whatsapp", accounts[0].matrixUserId, accounts[0].loginId, phone);
    } catch (err) {
      if (err instanceof BridgeError && err.status === 404) {
        throw new SendRefusal("not_on_whatsapp", `${phone} is not on WhatsApp.`);
      }
      throw err;
    }
    // 4. The bridge said this ghost IS this number: recorded, so the mirrored
    //    thread carries the phone and merges with the person.
    await recordGhostPhone(who.mxid, phone, req.orgId, req.brandId);

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

    // 5. Send.
    await joinRoom(account.accessToken, roomId);
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
    return resultOf(sent, false, await countPreviousSends(req, phone, sent.id));
  } catch (err) {
    if (err instanceof SendRefusal) {
      await finish(row.id, { status: "refused", errorCode: err.code, error: err.message });
    } else {
      await finish(row.id, { status: "failed", error: (err as Error).message.slice(0, 1000) }).catch((e) =>
        console.error(`[crm-service][whatsapp] could not record failed send ${row.id}:`, e),
      );
    }
    throw err;
  }
}

/** The connection a send went out on (to pull the sent message into the mirror at once). */
export async function sendConnection(sendId: string): Promise<string | null> {
  const [row] = await db.select({ c: whatsappSends.connectionId }).from(whatsappSends).where(eq(whatsappSends.id, sendId));
  return row?.c ?? null;
}
