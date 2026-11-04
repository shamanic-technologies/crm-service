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
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { people, peopleCorrections } from "../../db/schema.js";
import { handleOf } from "../matrix/events.js";
import { emailKey, handleKey, phoneKey } from "./identity.js";

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
