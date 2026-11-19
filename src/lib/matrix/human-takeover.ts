/**
 * HAND-TYPED ACCOUNTS (SOPHIE-NEVER-SENT-1119, replaces HUMAN-IN-THREAD-1016's
 * "forever, person-level" takeover).
 *
 * Owner 2026-10-16: « je ne veux plus que ça lui autoréponde à ma place, mais pour
 * un nouveau lead et un premier message de bienvenue oui ». Owner 2026-11-05 (newer):
 * « A hand reply by Kevin never locks a thread: it sits in the Unibox timeline and
 * the AI weighs it to write now or later ». Both hold together:
 *  - automation never writes FROM a human's account once that human typed to the
 *    person by hand on it (that would be writing « à ma place », as him);
 *  - but a hand reply never silences the brand's OTHER accounts (its `pro_ai` line
 *    answers the person there) and never hides the person's messages from the
 *    answering AI: the reply trigger reports every burst, the AI reads the whole
 *    thread (hand messages included) and decides now / later / nothing.
 * Before (2026-11-19, youcreatives.se): the owner typed by hand on his founder line,
 * the person-level takeover closed the assistant line too, the AI answered by email
 * a lead who wrote on WhatsApp; 70 bursts in 7 days never reached it.
 *
 * A `pro_ai` account is the AI's own line by the brand's statement (ACCOUNT-TYPES-1028):
 * a human typing on it joins the AI's conversation, it is never taken from the AI.
 *
 * Which message is HAND-TYPED: an `m.room.message` sent as the brand's own
 * linked account (with double puppeting the phone's own messages arrive as the
 * account), carrying words a person wrote (`humanText`), not an edit, and not
 * one of our automated sends (its event id, or its text when the send's event
 * id is not recorded yet: a send in flight is mirrored before it finishes).
 *
 * The brand's OWN linked accounts are never a person a human typed to
 * (SOPHIE-COPILOT-WA-1018): the owner typing between his own two linked numbers.
 * A person whose ghost stands for a number linked on the brand's channel
 * (`matrix_ghost_phones`, the mirrored contact's phone, or a phone ghost) holds none.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { MatrixEvent } from "./client.js";
import { editTarget, foldEdits, humanText, phoneFromMxid, WHATSAPP_GHOST_PREFIX } from "./events.js";

export interface OurSend {
  eventId: string | null;
  text: string;
}

/** PURE: the latest message a human of the brand typed by hand in these events, or null. */
export function lastHandTyped(events: MatrixEvent[], ownMxid: string, ours: OurSend[]): MatrixEvent | null {
  const ourIds = new Set(ours.map((s) => s.eventId).filter((x): x is string => !!x));
  const ourTexts = new Set(ours.map((s) => s.text.trim()).filter((t) => t.length > 0));
  let last: MatrixEvent | null = null;
  for (const e of foldEdits(events)) {
    if (e.sender !== ownMxid || editTarget(e)) continue;
    if (ourIds.has(e.event_id)) continue;
    const text = humanText(e.content);
    if (!text || ourTexts.has(text)) continue;
    if (!last || e.origin_server_ts > last.origin_server_ts) last = e;
  }
  return last;
}

export interface HandTyped {
  connectionId: string;
  roomId: string;
  eventId: string;
  at: string;
}

/**
 * Per linked account (connection) of the brand on `channel`: the latest message a
 * human typed by hand on THAT account to the person behind these ghosts. An account
 * absent from the map holds no hand-typed message to them (only our automated sends,
 * or no conversation at all).
 */
export async function handTypedByAccount(input: {
  orgId: string;
  brandId: string;
  channel: string;
  ghosts: string[];
}): Promise<Map<string, HandTyped>> {
  const found = new Map<string, HandTyped>();
  const ghosts = [...new Set(input.ghosts.filter((g) => !!g))];
  if (ghosts.length === 0) return found;
  if (await isOwnLinkedAccount({ ...input, ghosts })) return found;
  const rooms = (await db.execute(sql`
    SELECT DISTINCT v.connection_id, v.room_id, m.matrix_user_id
    FROM conversations v
    JOIN contacts c ON c.id = v.contact_id
    JOIN matrix_connections m ON m.id = v.connection_id
    WHERE v.org_id = ${input.orgId} AND v.brand_id = ${input.brandId} AND v.channel = ${input.channel}
      AND v.room_id IS NOT NULL
      AND c.channel_handle IN (${sql.join(ghosts.map((g) => sql`${g}`), sql`, `)})
  `)) as unknown as { connection_id: string; room_id: string; matrix_user_id: string }[];

  for (const r of rooms) {
    const events = (await db.execute(sql`
      SELECT payload FROM matrix_raw_events
      WHERE connection_id = ${r.connection_id} AND room_id = ${r.room_id}
        AND event_type = 'm.room.message' AND sender = ${r.matrix_user_id}
    `)) as unknown as { payload: MatrixEvent }[];
    if (events.length === 0) continue;
    const ours = (await db.execute(sql`
      SELECT event_id, text FROM whatsapp_sends
      WHERE org_id = ${input.orgId} AND brand_id = ${input.brandId}
        AND (room_id = ${r.room_id} OR status = 'sending')
    `)) as unknown as { event_id: string | null; text: string }[];
    const hit = lastHandTyped(
      events.map((e) => e.payload),
      r.matrix_user_id,
      ours.map((s) => ({ eventId: s.event_id, text: s.text })),
    );
    const prev = found.get(r.connection_id);
    if (hit && (!prev || Date.parse(prev.at) < hit.origin_server_ts)) {
      found.set(r.connection_id, { connectionId: r.connection_id, roomId: r.room_id, eventId: hit.event_id, at: new Date(hit.origin_server_ts).toISOString() });
    }
  }
  return found;
}

/**
 * PURE: the accounts automation may still write from to this person. An account a
 * human of the brand typed to them by hand on is theirs (never written from « à ma
 * place »), unless it is typed `pro_ai` (the AI's own line).
 */
export function accountsLeftToAutomation<A extends { connectionId: string; accountType: string | null }>(
  accounts: A[],
  handTyped: Map<string, HandTyped>,
): A[] {
  return accounts.filter((a) => a.accountType === "pro_ai" || !handTyped.has(a.connectionId));
}

/**
 * Do these ghosts stand for one of the brand's own linked accounts on `channel`?
 * Their number (the bridge's answer, the mirrored contact's phone, a phone
 * ghost) is the login of a `linked` link of the brand.
 */
export async function isOwnLinkedAccount(input: { orgId: string; brandId: string; channel: string; ghosts: string[] }): Promise<boolean> {
  if (input.ghosts.length === 0) return false;
  const ghostList = sql.join(input.ghosts.map((g) => sql`${g}`), sql`, `);
  const known = (await db.execute(sql`
    SELECT phone FROM matrix_ghost_phones WHERE ghost_mxid IN (${ghostList})
    UNION
    SELECT phone_e164 FROM contacts
    WHERE org_id = ${input.orgId} AND brand_id = ${input.brandId} AND channel_handle IN (${ghostList}) AND phone_e164 IS NOT NULL
  `)) as unknown as { phone: string }[];
  const phones = new Set(known.map((r) => r.phone));
  for (const g of input.ghosts) {
    const p = phoneFromMxid(g, WHATSAPP_GHOST_PREFIX);
    if (p) phones.add(p);
  }
  if (phones.size === 0) return false;
  const digits = [...phones].map((p) => p.replace(/[^0-9]/g, "")).filter((d) => d.length > 0);
  if (digits.length === 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1 FROM matrix_links
    WHERE org_id = ${input.orgId} AND brand_id = ${input.brandId} AND channel = ${input.channel}
      AND status = 'linked' AND remote_login_id IS NOT NULL
      AND regexp_replace(remote_login_id, '[^0-9]', '', 'g') IN (${sql.join(digits.map((d) => sql`${d}`), sql`, `)})
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}
