/**
 * ACCOUNT-EVENTS-ONE-OFFER-1108: which ONE offer an ACCOUNT fact about a person goes out on (a refused Stripe charge,
 * credit ran out / restored). Owner 2026-11-07 (AUDIENCE-PER-OFFER-1107): a person is contacted for ONE offer of a
 * brand only, and one event = one answer. Before, these facts fanned out one Lead event PER active offer when the person
 * carried no offer tag (3 offers = up to 3 messages for one fact).
 *
 * The SAME resolver as every other trigger (lib/offer-pick.ts), fed with what crm-service holds about the person:
 *  - held: the person's offer tags (`people.offer_ids`, Jev on their conversations);
 *  - evidence: the fact itself + whatever the trigger knows of them (the charge, the contact record, the account's
 *    Copilot words and actions). Nothing about the person at all = `eventOnly`: Jev picks on the event and the
 *    offers, logged loud and persisted on the verdict, never a hard-coded default.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { people } from "../db/schema.js";
import { emailKey, phoneKey } from "./people/identity.js";
import { resolveOccurrenceOffer, type Ledger, type OfferPick } from "./offer-pick.js";
import type { SiblingIdentity } from "./people/siblings.js";

export interface AccountPerson {
  personId: string | null;
  name: string | null;
  offerIds: string[];
}

/** The brand's person holding this address / number: their id, name and the offers their conversations are about. */
export async function accountPersonOf(orgId: string, brandId: string, email: string | null, phone: string | null): Promise<AccountPerson> {
  const key = email ? emailKey(email) : phone ? phoneKey(phone) : null;
  if (!key) return { personId: null, name: null, offerIds: [] };
  const [p] = await db
    .select({ personId: people.personId, name: people.displayName, offerIds: people.offerIds })
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), sql`${people.identityKeys} @> ${JSON.stringify([key])}::jsonb`))
    .limit(1);
  return { personId: p?.personId ?? null, name: p?.name ?? null, offerIds: (p?.offerIds as string[] | undefined) ?? [] };
}

/** The one offer the account fact goes out on. Throws when a sibling or Jev is down (the caller records `offer_pick_failed`). */
export async function resolveAccountFactOffer(
  identity: SiblingIdentity,
  input: {
    ledger: Extract<Ledger, "refusal" | "credit">;
    reportId: string;
    persisted: { offerId: string | null; offerBasis: string | null; offerVerdict: unknown };
    person: { email: string | null; phone: string | null };
    who: AccountPerson;
    what: string;
    /** What the trigger knows of the fact and the person. */
    facts: Record<string, unknown>;
    /** True when `facts` carries something the person said or did (beyond the bare event). */
    hasPersonEvidence: boolean;
  },
): Promise<OfferPick> {
  return resolveOccurrenceOffer(identity, {
    ledger: input.ledger,
    reportId: input.reportId,
    formId: null,
    persisted: input.persisted,
    person: input.person,
    held:
      input.who.offerIds.length > 0
        ? { offerIds: input.who.offerIds, verdict: { via: "person_offer_tags", personId: input.who.personId, scores: null } }
        : null,
    evidence: { what: input.what, facts: input.facts, eventOnly: !input.hasPersonEvidence },
  });
}
