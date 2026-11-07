/**
 * DUALIST-WA-SILENCE-1104 (owner 2026-11-04: « On le tag dans distribute.you comme PAS client de notre marque donc il
 * ne recevra pas de réponse de la part de nous »): a person the brand's user STATED is not someone of the brand
 * (an active person-level correction `tag_add professional_not_to_brand`, people/corrections.ts) is never answered,
 * reported or pinged by anything of ours on that brand: the reply trigger (WhatsApp / Matrix and Gmail), the phone
 * trigger, the owner's assistant pings and the WhatsApp send. Thierry Matin (Dualist Research) writes on the
 * assistant's number, which a device of HIS product also reads: only that device answers him.
 *
 * Only a human STATEMENT silences: Jev's own "not to brand" tag never does (the pipe's strategy decides who is
 * answered). Undo the correction and every path acts again on the next message.
 *
 * The person is found by any identity key the caller holds (an email, a phone, a Matrix contact, a messaging
 * handle) AND every key the built person holding one of them carries, so a new thread on another linked account
 * (same WhatsApp LID, a contact row the build has not merged yet) is recognised at once.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { people, peopleCorrections } from "../../db/schema.js";
import { handleOf } from "../matrix/events.js";
import { emailKey, handleKey, normalizeEmail, phoneKey } from "./identity.js";

export const NOT_TO_BRAND_TARGET = "tag_add:professional_not_to_brand";

export interface NotToBrandStatement {
  correctionId: string;
  reason: string | null;
  statedByUserId: string;
}

/** PURE: the identity keys a mirrored Matrix contact states (as the people build reads it), plus its phone. */
export function matrixContactKeys(c: {
  contactId: string;
  channel: string;
  channelHandle: string | null;
  counterpartPrefix: string;
  phone?: string | null;
}): string[] {
  const h = c.channelHandle ? handleOf(c.channel, c.channelHandle, c.counterpartPrefix) : null;
  return [`matrix:${c.contactId}`, ...(h ? [handleKey(h.network, h.id)] : []), ...(c.phone ? [phoneKey(c.phone)] : [])];
}

export const emailKeys = (emails: (string | null | undefined)[]) => emails.filter((e): e is string => !!e).map((e) => emailKey(e.toLowerCase()));

/** The active statement that this person is not someone of the brand, or null. */
export async function statedNotToBrand(orgId: string, brandId: string, keys: string[]): Promise<NotToBrandStatement | null> {
  const asked = [...new Set(keys.filter(Boolean))];
  if (asked.length === 0) return null;
  const statements = await db
    .select({
      id: peopleCorrections.id,
      personKeys: peopleCorrections.personKeys,
      reason: peopleCorrections.reason,
      statedByUserId: peopleCorrections.statedByUserId,
    })
    .from(peopleCorrections)
    .where(
      and(
        eq(peopleCorrections.orgId, orgId),
        eq(peopleCorrections.brandId, brandId),
        eq(peopleCorrections.targetKey, NOT_TO_BRAND_TARGET),
        isNull(peopleCorrections.undoneAt),
      ),
    );
  if (statements.length === 0) return null;
  const held = await db
    .select({ identityKeys: people.identityKeys })
    .from(people)
    .where(
      and(
        eq(people.orgId, orgId),
        eq(people.brandId, brandId),
        sql`${people.identityKeys} ?| ARRAY[${sql.join(asked.map((k) => sql`${k}`), sql`, `)}]::text[]`,
      ),
    );
  const all = new Set([...asked, ...held.flatMap((p) => p.identityKeys as string[])]);
  const hit = statements.find((s) => (s.personKeys as string[]).some((k) => all.has(k)));
  return hit ? { correctionId: hit.id, reason: hit.reason, statedByUserId: hit.statedByUserId } : null;
}

export interface StatedNotToBrandByEmail extends NotToBrandStatement {
  brandId: string;
}

/**
 * DUALIST-WA-SILENCE-EMAIL (owner 2026-11-04): the EMAIL senders' question, many addresses and brands at once (an
 * email send names its brands; instantly-service's status read asks for a whole batch). Per address, the first
 * active statement on one of the brands, matched exactly like `statedNotToBrand` (the address + every key of the
 * brand's built person holding it, so a statement made on their phone or WhatsApp handle silences their email too).
 * Keyed by the NORMALIZED address; an address that is not one is never stated. DB-only, fail loud.
 */
export async function statedNotToBrandByEmail(
  orgId: string,
  brandIds: string[],
  emails: string[],
): Promise<Map<string, StatedNotToBrandByEmail>> {
  const out = new Map<string, StatedNotToBrandByEmail>();
  const brands = [...new Set(brandIds.filter(Boolean))];
  const addresses = [...new Set(emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e))];
  if (brands.length === 0 || addresses.length === 0) return out;
  const statements = await db
    .select({
      id: peopleCorrections.id,
      brandId: peopleCorrections.brandId,
      personKeys: peopleCorrections.personKeys,
      reason: peopleCorrections.reason,
      statedByUserId: peopleCorrections.statedByUserId,
    })
    .from(peopleCorrections)
    .where(
      and(
        eq(peopleCorrections.orgId, orgId),
        inArray(peopleCorrections.brandId, brands),
        eq(peopleCorrections.targetKey, NOT_TO_BRAND_TARGET),
        isNull(peopleCorrections.undoneAt),
      ),
    )
    .orderBy(asc(peopleCorrections.createdAt), asc(peopleCorrections.id));
  if (statements.length === 0) return out;
  const asked = addresses.map((a) => emailKey(a));
  const held = await db
    .select({ brandId: people.brandId, identityKeys: people.identityKeys })
    .from(people)
    .where(
      and(
        eq(people.orgId, orgId),
        inArray(people.brandId, [...new Set(statements.map((s) => s.brandId))]),
        sql`${people.identityKeys} ?| ARRAY[${sql.join(asked.map((k) => sql`${k}`), sql`, `)}]::text[]`,
      ),
    );
  for (const address of addresses) {
    const key = emailKey(address);
    for (const s of statements) {
      const keys = new Set([key, ...held.filter((p) => p.brandId === s.brandId && (p.identityKeys as string[]).includes(key)).flatMap((p) => p.identityKeys as string[])]);
      if ((s.personKeys as string[]).some((k) => keys.has(k))) {
        out.set(address, { correctionId: s.id, brandId: s.brandId, reason: s.reason, statedByUserId: s.statedByUserId });
        break;
      }
    }
  }
  return out;
}

export interface StatedEmailSet {
  correctionId: string;
  brandId: string;
  /** Every NORMALIZED address of the stated person: the statement's own keys + every key of the brand's built person holding one. */
  emails: string[];
}

/**
 * PURE: per active statement, every address of the person it covers, so `statedNotToBrandByEmail(address)` hits
 * exactly when `address` is in one of these sets. Equivalence: that read hits when the address key is one of the
 * statement's keys, or a built person of the statement's brand holds the address key AND shares a key with the
 * statement; the set below is the statement's keys plus every key of each built person of that brand sharing one
 * with it, i.e. the same condition read from the statement's side. Order = the statements' order.
 */
export function statedEmailSets(
  statements: { id: string; brandId: string; personKeys: string[] }[],
  held: { brandId: string; identityKeys: string[] }[],
): StatedEmailSet[] {
  return statements.map((s) => {
    const stated = new Set(s.personKeys);
    const keys = new Set(s.personKeys);
    for (const p of held) {
      if (p.brandId !== s.brandId || !p.identityKeys.some((k) => stated.has(k))) continue;
      for (const k of p.identityKeys) keys.add(k);
    }
    const emails = [...keys].filter((k) => k.startsWith("email:")).map((k) => k.slice("email:".length)).sort();
    return { correctionId: s.id, brandId: s.brandId, emails };
  });
}

/**
 * STATUS-CRM-TIMEOUT-1107: the whole answer for (org, brands) at once, so a caller asking for thousands of addresses
 * a second (instantly-service's status read) reads it ONCE and matches locally, instead of one request per batch of
 * addresses (461 timeouts in 3 h under a features-service restart burst). Statements are few (44 fleet-wide on
 * 2026-11-07); an org with none answers after one indexed read. DB-only, fail loud.
 */
export async function statedNotToBrandEmailSets(orgId: string, brandIds: string[]): Promise<StatedEmailSet[]> {
  const brands = [...new Set(brandIds.filter(Boolean))];
  if (brands.length === 0) return [];
  const statements = await db
    .select({ id: peopleCorrections.id, brandId: peopleCorrections.brandId, personKeys: peopleCorrections.personKeys })
    .from(peopleCorrections)
    .where(
      and(
        eq(peopleCorrections.orgId, orgId),
        inArray(peopleCorrections.brandId, brands),
        eq(peopleCorrections.targetKey, NOT_TO_BRAND_TARGET),
        isNull(peopleCorrections.undoneAt),
      ),
    )
    .orderBy(asc(peopleCorrections.createdAt), asc(peopleCorrections.id));
  if (statements.length === 0) return [];
  const rows = statements.map((s) => ({ id: s.id, brandId: s.brandId, personKeys: s.personKeys as string[] }));
  const allKeys = [...new Set(rows.flatMap((s) => s.personKeys))];
  const held =
    allKeys.length === 0
      ? []
      : await db
          .select({ brandId: people.brandId, identityKeys: people.identityKeys })
          .from(people)
          .where(
            and(
              eq(people.orgId, orgId),
              inArray(people.brandId, [...new Set(rows.map((s) => s.brandId))]),
              sql`${people.identityKeys} ?| ARRAY[${sql.join(allKeys.map((k) => sql`${k}`), sql`, `)}]::text[]`,
            ),
          );
  return statedEmailSets(rows, held.map((p) => ({ brandId: p.brandId, identityKeys: p.identityKeys as string[] })));
}
