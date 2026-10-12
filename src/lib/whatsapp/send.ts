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
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixGhostPhones, matrixLinks, people, whatsappSends } from "../../db/schema.js";
import { BridgeError, bridgeLogins, createDm, resolveIdentifier } from "../matrix/bridge.js";
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

interface SendingAccount {
  connectionId: string;
  matrixUserId: string;
  accessToken: string;
  loginId: string;
}

/** The brand's linked WhatsApp accounts that are CONNECTED right now, oldest link first. */
async function connectedAccounts(req: SendRequest): Promise<SendingAccount[]> {
  const rows = await db
    .select({
      connectionId: matrixConnections.id,
      matrixUserId: matrixConnections.matrixUserId,
      accessToken: matrixConnections.accessToken,
      connStatus: matrixConnections.status,
      loginId: matrixLinks.remoteLoginId,
    })
    .from(matrixLinks)
    .innerJoin(matrixConnections, eq(matrixConnections.id, matrixLinks.connectionId))
    .where(
      and(
        eq(matrixLinks.orgId, req.orgId),
        eq(matrixLinks.brandId, req.brandId),
        eq(matrixLinks.channel, "whatsapp"),
        eq(matrixLinks.status, "linked"),
      ),
    )
    .orderBy(asc(matrixLinks.linkedAt), asc(matrixLinks.id));
  const wanted = req.fromAccount ? digitsOf(req.fromAccount) : null;
  const linked = rows.filter(
    (r): r is typeof r & { accessToken: string; loginId: string } =>
      !!r.accessToken && !!r.loginId && r.connStatus !== "paused" && (!wanted || digitsOf(r.loginId) === wanted),
  );
  if (linked.length === 0) {
    throw new SendRefusal(
      "whatsapp_not_linked",
      wanted
        ? `The brand has no linked WhatsApp account for +${wanted}.`
        : "The brand has no linked WhatsApp account. Link one from the dashboard first.",
    );
  }
  const connected: SendingAccount[] = [];
  for (const r of linked) {
    const logins = await bridgeLogins("whatsapp", r.matrixUserId);
    const login = logins.find((l) => l.id === r.loginId);
    if (login?.state?.state_event === "CONNECTED") {
      connected.push({ connectionId: r.connectionId, matrixUserId: r.matrixUserId, accessToken: r.accessToken, loginId: r.loginId });
    }
  }
  if (connected.length === 0) {
    throw new SendRefusal(
      "whatsapp_not_connected",
      "The brand's WhatsApp is linked but not connected right now (logged out or offline). Relink it from the dashboard.",
    );
  }
  return connected;
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

    // 3. From which account, into which room. An account already in a DM with
    //    the person keeps the conversation in one thread.
    const accounts = await connectedAccounts(req);
    let chosen: { account: SendingAccount; roomId: string | null; ghost: string } | null = null;
    for (const account of accounts) {
      let resolved;
      try {
        resolved = await resolveIdentifier("whatsapp", account.matrixUserId, account.loginId, phone);
      } catch (err) {
        if (err instanceof BridgeError && err.status === 404) {
          throw new SendRefusal("not_on_whatsapp", `${phone} is not on WhatsApp.`);
        }
        throw err;
      }
      if (!chosen) chosen = { account, roomId: resolved.dmRoomId, ghost: resolved.mxid };
      if (resolved.dmRoomId) {
        chosen = { account, roomId: resolved.dmRoomId, ghost: resolved.mxid };
        break;
      }
    }
    const { account } = chosen!;
    let roomId = chosen!.roomId;
    let ghost = chosen!.ghost;
    if (!roomId) {
      const dm = await createDm("whatsapp", account.matrixUserId, account.loginId, phone);
      if (!dm.dmRoomId) throw new Error(`[crm-service][whatsapp] create_dm for ${phone} answered no room`);
      roomId = dm.dmRoomId;
      ghost = dm.mxid;
    }

    // 4. The bridge said this ghost IS this number: recorded, so the mirrored
    //    thread carries the phone and merges with the person.
    await db
      .insert(matrixGhostPhones)
      .values({ ghostMxid: ghost, phone })
      .onConflictDoUpdate({ target: matrixGhostPhones.ghostMxid, set: { phone, resolvedAt: new Date() } });

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
