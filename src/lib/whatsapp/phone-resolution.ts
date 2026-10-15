/**
 * ONE PERSON, EVERY CHANNEL, WhatsApp included (owner 2026-10-12: « tu n'as pas
 * bien mergé tous les canaux de conversation sur une même personne »).
 *
 * WhatsApp now names almost every counterpart by an opaque LID ghost
 * (`@whatsapp_lid-…`): 514 of 514 mirrored WhatsApp contacts carried no phone,
 * so a signup who had talked with the owner for weeks on WhatsApp stayed a
 * separate, phone-less person, and read as "never answered" (6 of the first 13
 * a campaign wrote to, 2026-10-12).
 *
 * The fix asks the bridge, ONCE per phone the brand's CRM knows (any source but
 * Matrix itself), "who is this on WhatsApp" (`resolve_identifier`, read-only, the
 * same call a send makes). The answer is WhatsApp's own: the ghost standing for
 * that number. It is recorded in `matrix_ghost_phones` (the Matrix silver reads
 * it back on every rebuild) and written onto the brand's mirrored contacts of
 * that ghost, so the next people build merges the thread into the person on the
 * phone key — positive evidence, no guess.
 *
 * Asked once per phone, globally (WhatsApp ids are the same from every
 * account): `whatsapp_phone_lookups`. A number not on WhatsApp is asked again
 * after 30 days. Bounded per pass, spaced, so a brand with thousands of CRM
 * phones is resolved over a few passes, never in a burst.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contacts, matrixGhostPhones, whatsappPhoneLookups } from "../../db/schema.js";
import { resolveIdentifier } from "../matrix/bridge.js";
import { bridgeSaysNoSuchNumber } from "./number-validity.js";
import { connectedOnly, linkedWhatsappAccounts } from "./accounts.js";

const MAX_PER_PASS = Number(process.env.WHATSAPP_PHONE_LOOKUPS_PER_PASS) || 150;
const GAP_MS = Number(process.env.WHATSAPP_PHONE_LOOKUP_GAP_MS ?? 400);
const RETRY_NOT_FOUND_DAYS = 30;

export interface PhoneResolutionResult {
  status: "not_connected" | "ok";
  asked: number;
  found: number;
  notOnWhatsapp: number;
  contactsUpdated: number;
  /** Phones still to ask (the pass cap was reached). */
  remaining: number;
}

/** Record the bridge's answer "this ghost IS this number" and put it on the brand's mirrored contacts. */
export async function recordGhostPhone(ghostMxid: string, phone: string, orgId: string, brandId: string): Promise<number> {
  await db
    .insert(matrixGhostPhones)
    .values({ ghostMxid, phone })
    .onConflictDoUpdate({ target: matrixGhostPhones.ghostMxid, set: { phone, resolvedAt: new Date() } });
  const updated = await db
    .update(contacts)
    .set({ phoneE164: phone })
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.brandId, brandId),
        eq(contacts.source, "matrix"),
        eq(contacts.channelHandle, ghostMxid),
        isNull(contacts.phoneE164),
      ),
    )
    .returning({ id: contacts.id });
  return updated.length;
}

/** International phones the brand's CRM knows outside Matrix, never asked (or not found > 30 days ago). */
async function phonesToAsk(orgId: string, brandId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH known AS (
      SELECT DISTINCT ph AS phone
      FROM people p, jsonb_array_elements_text(p.phones) AS ph
      WHERE p.org_id = ${orgId} AND p.brand_id = ${brandId}
      UNION
      SELECT DISTINCT c.phone_e164 FROM contacts c
      WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source <> 'matrix' AND c.phone_e164 IS NOT NULL
    )
    SELECT k.phone FROM known k
    WHERE k.phone ~ '^\\+[0-9]{8,15}$'
      AND NOT EXISTS (SELECT 1 FROM matrix_ghost_phones g WHERE g.phone = k.phone)
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_phone_lookups l
        WHERE l.phone = k.phone
          AND (l.outcome = 'found' OR l.looked_up_at > now() - ${`${RETRY_NOT_FOUND_DAYS} days`}::interval)
      )
    ORDER BY k.phone
  `)) as unknown as { phone: string }[];
  return rows.map((r) => r.phone);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One pass for one brand. A bridge failure other than "no such number" (404, or
 * a 500 on a number that cannot exist: number-validity.ts) stops the pass and
 * throws (the caller logs it; the next pass resumes).
 */
export async function resolveBrandWhatsappPhones(orgId: string, brandId: string): Promise<PhoneResolutionResult> {
  const empty = { asked: 0, found: 0, notOnWhatsapp: 0, contactsUpdated: 0, remaining: 0 };
  const linked = await linkedWhatsappAccounts(orgId, brandId);
  if (linked.length === 0) return { status: "not_connected", ...empty };
  const phones = await phonesToAsk(orgId, brandId);
  if (phones.length === 0) return { status: "ok", ...empty };
  const [account] = await connectedOnly(linked);
  if (!account) return { status: "not_connected", ...empty, remaining: phones.length };

  const result: PhoneResolutionResult = { status: "ok", ...empty, remaining: Math.max(0, phones.length - MAX_PER_PASS) };
  for (const phone of phones.slice(0, MAX_PER_PASS)) {
    if (result.asked > 0 && GAP_MS > 0) await sleep(GAP_MS);
    result.asked += 1;
    try {
      const who = await resolveIdentifier("whatsapp", account.matrixUserId, account.loginId, phone);
      await db
        .insert(whatsappPhoneLookups)
        .values({ phone, ghostMxid: who.mxid, outcome: "found" })
        .onConflictDoUpdate({ target: whatsappPhoneLookups.phone, set: { ghostMxid: who.mxid, outcome: "found", lookedUpAt: new Date() } });
      result.found += 1;
      result.contactsUpdated += await recordGhostPhone(who.mxid, phone, orgId, brandId);
    } catch (err) {
      const outcome = bridgeSaysNoSuchNumber(err, phone);
      if (outcome) {
        await db
          .insert(whatsappPhoneLookups)
          .values({ phone, ghostMxid: null, outcome })
          .onConflictDoUpdate({ target: whatsappPhoneLookups.phone, set: { ghostMxid: null, outcome, lookedUpAt: new Date() } });
        result.notOnWhatsapp += 1;
        continue;
      }
      throw err;
    }
  }
  return result;
}
