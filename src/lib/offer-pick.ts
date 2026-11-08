/**
 * WHICH OFFER A PERSON'S OCCURRENCE LANDS ON, for EVERY trigger crm-service reports
 * (a form fill, a WhatsApp number given, a message written to the brand). ONE
 * resolver (FORM-OFFER-PICK-1108, extended to every trigger by OFFER-PICK-ALL-1108):
 * a brand sells several offers, each to ONE audience (AUDIENCE-PER-OFFER-1107), and a
 * person is contacted for ONE offer of a brand only. Account facts about a person (a refused
 * Stripe charge, credit ran out / restored: ACCOUNT-EVENTS-ONE-OFFER-1108) use it too: ONE event
 * on ONE offer, never one per active offer. In order, the first that answers:
 *
 *  1. an offer STATED for this occurrence (the campaign that wrote in the thread names
 *     its offer; a form's own `form_offer_mappings` row), then the offer stated for
 *     every form of the brand (`'*'`), then the brand's ONLY active offer: a statement
 *     always wins;
 *  2. the pick already PERSISTED on this report (judged once: a retry never re-asks);
 *  3. the offer that already REACHED this person at this brand: any report of theirs
 *     (form fill, number given, message) we already reported on an offer, by email or
 *     phone, or an offer audience that SERVED them (human-service memberships by email,
 *     else by phone; provenance `served`); the earliest wins;
 *  4. a Jev verdict the occurrence already holds (the conversation's offer tags), else
 *     Jev (`choice` over the brand's active offers) reading the occurrence's own words
 *     (form answers, the message they wrote, the contact the number came with) against
 *     each offer as the client created it (name, what it sells) and its audience's text
 *     (human-service `targetText` of the offer's `role: "target"` audience).
 *
 * Never a default offer, never a rule on the words. What cannot be placed (no active
 * offer) answers `offerId: null`; a sibling or Jev down THROWS: each caller records it
 * loud (`offer_pick_failed`) and retries.
 */
import { and, asc, eq, isNotNull, ne, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { contacts, creditEventReports, formTriggerReports, paymentRefusalReports, phoneGivenReports, replyTriggerReports } from "../db/schema.js";
import { judgeChoices, type ChoiceQuestion } from "./judgments-client.js";
import { readBrandContext } from "./people/relevance.js";
import { siblingGetOk, siblingQuery, type SiblingIdentity } from "./people/siblings.js";
import { readStatedAndOffers, pickOffer } from "./form-trigger/offer.js";
import type { BrandOffer } from "./form-trigger/offer.js";

export type OfferBasis =
  | "stated_for_form"
  | "stated_for_brand"
  | "only_offer"
  /** The campaign that wrote in the thread names this offer. */
  | "campaign"
  | "person_reached"
  | "judged";

/** Persisted on the report (`offer_verdict`) when Jev placed the occurrence. */
export interface OfferVerdict {
  model: string;
  confidence: number;
  /** Per offer id. */
  probabilities: Record<string, number>;
  /** The offer audience each offer was judged against (null = the offer has no audience text). */
  audiences: Record<string, string | null>;
  judgedAt: string;
  /** Jev read the event and the brand's offers only: nothing the person said or did was held (loud, persisted). */
  eventOnly?: true;
}

/**
 * A verdict the occurrence already held: Jev's offer tags on the person's conversation (people/relevance.ts), or the
 * person's offer tags (`people.offer_ids`, the union of their conversations' tags) for an account fact.
 */
export type HeldVerdict =
  | { via: "conversation_verdict"; conversationKey: string; scores: Record<string, number> | null }
  | { via: "person_offer_tags"; personId: string | null; scores: null };

/** How a person was already reached for an offer (persisted as the verdict of a `person_reached` pick). */
export interface ReachedEvidence {
  via: "form_report" | "phone_report" | "reply_report" | "refusal_report" | "credit_report" | "audience_served";
  /** The earlier report id, or the audience id. */
  ref: string;
  at: string;
}

export type OfferPickVerdict = OfferVerdict | HeldVerdict | ReachedEvidence;

export type OfferPick =
  | { offerId: string; basis: OfferBasis; verdict: OfferPickVerdict | null }
  | { offerId: null; reason: "offer_unknown"; detail: string };

/** The report ledgers a person's occurrences are recorded in. */
export type Ledger = "form" | "phone" | "reply" | "refusal" | "credit";

/** What a trigger knows about one occurrence. Every field is evidence; none is a per-trigger rule. */
export interface Occurrence {
  /** The report itself (excluded from "already reached"). */
  ledger: Ledger;
  reportId: string;
  /** The form id for a form's own stated offer; null = only the brand-wide statement applies. */
  formId: string | null;
  /** An offer this occurrence itself names (the campaign that wrote in the thread); null = none. */
  statedOfferId?: string | null;
  /** What the report already holds (judged once). */
  persisted: { offerId: string | null; offerBasis: string | null; offerVerdict: unknown };
  person: { email: string | null; phone: string | null };
  /** A Jev verdict the occurrence already holds (the conversation's offer tags): used before asking Jev. */
  held?: { offerIds: string[]; verdict: HeldVerdict } | null;
  /**
   * What Jev reads: one sentence saying what happened, and the occurrence's own words. `eventOnly` = nothing the person
   * said or did is in `facts` (an account fact about someone never reached): Jev picks on the event and the offers
   * alone, logged loud and persisted on the verdict.
   */
  evidence: { what: string; facts: Record<string, unknown>; eventOnly?: boolean };
}

const PERSISTED_BASES = new Set<string>(["person_reached", "judged"]);

/** PURE: the earliest offer that reached the person, among the brand's ACTIVE offers. */
export function pickReachedOffer(
  candidates: { offerId: string | null; at: Date; evidence: ReachedEvidence }[],
  activeOfferIds: Set<string>,
): { offerId: string; evidence: ReachedEvidence } | null {
  const live = candidates
    .filter((c): c is typeof c & { offerId: string } => !!c.offerId && activeOfferIds.has(c.offerId))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.offerId < b.offerId ? -1 : 1));
  return live.length > 0 ? { offerId: live[0].offerId, evidence: live[0].evidence } : null;
}

/**
 * PURE: of the offers a held verdict tagged, the ACTIVE one it is most sure of. Several tagged with no score to tell
 * them apart = null (never an id-order pick): Jev decides, reading those tags as evidence.
 */
export function pickHeldOffer(offerIds: string[], scores: Record<string, number> | null, activeOfferIds: Set<string>): string | null {
  const live = offerIds.filter((o) => activeOfferIds.has(o));
  if (live.length === 0) return null;
  if (live.length > 1 && !scores) return null;
  return [...live].sort((a, b) => (scores?.[b] ?? 0) - (scores?.[a] ?? 0) || (a < b ? -1 : 1))[0];
}

interface HumanMembership {
  audienceId: string;
  offerId: string | null;
  provenance: string;
  joinedAt: string;
}

type HumanMember = { memberships: HumanMembership[] };

interface LedgerCols {
  table: PgTable;
  id: PgColumn;
  orgId: PgColumn;
  brandId: PgColumn;
  status: PgColumn;
  offerId: PgColumn;
  reportedAt: PgColumn;
  email: PgColumn;
  /** Null = the ledger records no phone (credit reports: members by address). */
  phone: PgColumn | null;
}

const cols = (
  t: typeof formTriggerReports | typeof phoneGivenReports | typeof replyTriggerReports | typeof paymentRefusalReports,
): LedgerCols => ({
  table: t,
  id: t.id,
  orgId: t.orgId,
  brandId: t.brandId,
  status: t.status,
  offerId: t.offerId,
  reportedAt: t.reportedAt,
  email: t.email,
  phone: t.phone,
});

const LEDGERS: Record<Ledger, { cols: LedgerCols; via: ReachedEvidence["via"] }> = {
  form: { cols: cols(formTriggerReports), via: "form_report" },
  phone: { cols: cols(phoneGivenReports), via: "phone_report" },
  reply: { cols: cols(replyTriggerReports), via: "reply_report" },
  refusal: { cols: cols(paymentRefusalReports), via: "refusal_report" },
  credit: {
    cols: {
      table: creditEventReports,
      id: creditEventReports.id,
      orgId: creditEventReports.orgId,
      brandId: creditEventReports.brandId,
      status: creditEventReports.status,
      offerId: creditEventReports.offerId,
      reportedAt: creditEventReports.reportedAt,
      email: creditEventReports.email,
      phone: null,
    },
    via: "credit_report",
  },
};

/** Every report of this person (any trigger) we already reported on an offer, and the offer audiences that served them. */
async function reachedCandidates(identity: SiblingIdentity, o: Occurrence) {
  const out: { offerId: string | null; at: Date; evidence: ReachedEvidence }[] = [];
  for (const [ledger, { cols: c, via }] of Object.entries(LEDGERS) as [Ledger, (typeof LEDGERS)[Ledger]][]) {
    const who: SQL[] = [];
    if (o.person.email) who.push(eq(c.email, o.person.email));
    if (o.person.phone && c.phone) who.push(eq(c.phone, o.person.phone));
    if (who.length === 0) continue;
    const conds: SQL[] = [
      eq(c.orgId, identity.orgId),
      eq(c.brandId, identity.brandId),
      eq(c.status, "reported"),
      isNotNull(c.offerId),
      or(...who)!,
    ];
    if (ledger === o.ledger) conds.push(ne(c.id, o.reportId));
    const earlier = (await db
      .select({ id: c.id, offerId: c.offerId, reportedAt: c.reportedAt })
      .from(c.table)
      .where(and(...conds))
      .orderBy(asc(c.reportedAt))) as { id: string; offerId: string | null; reportedAt: Date | null }[];
    for (const e of earlier) {
      const at = e.reportedAt ?? new Date(0);
      out.push({ offerId: e.offerId, at, evidence: { via, ref: e.id, at: at.toISOString() } });
    }
  }
  // human-service: the offer audiences that SERVED them, by email when held, else by phone (memberships/by-phone).
  const viaHuman = o.person.email
    ? { path: "by-email", body: { emails: [o.person.email] }, field: "byEmail" as const, key: o.person.email }
    : o.person.phone
      ? { path: "by-phone", body: { phones: [o.person.phone] }, field: "byPhone" as const, key: o.person.phone }
      : null;
  if (viaHuman) {
    const body = await siblingQuery<{ byEmail?: Record<string, HumanMember | null>; byPhone?: Record<string, HumanMember | null> }>(
      "human",
      `/internal/brands/${encodeURIComponent(identity.brandId)}/memberships/${viaHuman.path}`,
      identity,
      { orgId: identity.orgId, ...viaHuman.body },
    );
    for (const m of body[viaHuman.field]?.[viaHuman.key]?.memberships ?? []) {
      if (m.provenance !== "served") continue;
      out.push({ offerId: m.offerId, at: new Date(m.joinedAt), evidence: { via: "audience_served", ref: m.audienceId, at: m.joinedAt } });
    }
  }
  return out;
}

interface OfferAudience {
  id: string;
  role: string | null;
  targetText: string | null;
}

/** The offer's ONE audience (`role: "target"`) and its text, from human-service. Fails loud. */
async function readOfferAudience(identity: SiblingIdentity, offerId: string): Promise<OfferAudience | null> {
  const q = new URLSearchParams({ brandId: identity.brandId, offerId, status: "active", limit: "200" });
  const body = await siblingGetOk<{ audiences: OfferAudience[] }>("human", `/orgs/audiences?${q}`, identity);
  if (!Array.isArray(body?.audiences)) throw new Error(`human-service GET /orgs/audiences answered no audiences list (offer ${offerId})`);
  return body.audiences.find((a) => a.role === "target") ?? null;
}

export interface JudgedOffer {
  offerId: string;
  name: string;
  whatWeOffer: string | null;
  audienceId: string | null;
  audienceText: string | null;
}

/** PURE: the Jev question and its state. Option keys are `o<k>` (offer ids are not option names). */
export function offerChoice(
  brand: { name: string; website: string | null; description: string | null },
  offers: JudgedOffer[],
  evidence: Occurrence["evidence"],
): { state: Record<string, unknown>; question: ChoiceQuestion; keyToOffer: Map<string, string> } {
  const keyToOffer = new Map<string, string>();
  const criteria: Record<string, string> = {};
  offers.forEach((o, k) => {
    const key = `o${k}`;
    keyToOffer.set(key, o.offerId);
    criteria[key] =
      `The offer "${o.name}"` +
      (o.whatWeOffer ? `, which sells: ${o.whatWeOffer}` : "") +
      (o.audienceText ? `. Its audience: ${o.audienceText}` : ". No audience text is stated for it");
  });
  return {
    state: {
      brand,
      offers: offers.map((o, k) => ({ option: `o${k}`, name: o.name, whatWeOffer: o.whatWeOffer, audience: o.audienceText })),
      whatHappened: evidence.what,
      occurrence: evidence.facts,
    },
    question: {
      type: "choice",
      instructions:
        `${evidence.what} The brand sells several offers, each to its own audience. ` +
        "The person must be contacted about ONE of them: the offer whose audience they belong to. Read who the " +
        "person is and what they want from what they stated (their job, business, situation, needs) and pick the " +
        "offer whose audience and what it sells fit them best.",
      criteria,
    },
    keyToOffer,
  };
}

/** Ask Jev which offer the occurrence is about. Fails loud on a malformed answer. */
async function judgeOffer(identity: SiblingIdentity, o: Occurrence, active: BrandOffer[]): Promise<{ offerId: string; verdict: OfferVerdict }> {
  const context = await readBrandContext(identity);
  const audiences = await Promise.all(active.map((a) => readOfferAudience(identity, a.offerId)));
  const offers: JudgedOffer[] = active
    .map((a, k) => ({
      offerId: a.offerId,
      name: a.name,
      whatWeOffer: context.offers.find((c) => c.offerId === a.offerId)?.whatWeOffer ?? null,
      audienceId: audiences[k]?.id ?? null,
      audienceText: audiences[k]?.targetText?.trim() || null,
    }))
    .sort((a, b) => (a.offerId < b.offerId ? -1 : 1));
  const blind = offers.filter((x) => !x.audienceText).map((x) => x.offerId);
  if (o.evidence.eventOnly) {
    console.warn(
      `[crm-service][offer-pick] brand ${identity.brandId}: ${o.ledger} report ${o.reportId} is about a person never reached ` +
        `and nothing they said or did is held: Jev picks the offer on the event and the offers alone`,
    );
  }
  if (blind.length > 0) {
    console.warn(
      `[crm-service][offer-pick] brand ${identity.brandId}: offer(s) ${blind.join(", ")} have no audience text; ` +
        `${o.ledger} report ${o.reportId} is judged on their name and what they sell only`,
    );
  }
  const { state, question, keyToOffer } = offerChoice(context.brand, offers, o.evidence);
  const result = await judgeChoices(state, { offer: question }, {
    orgId: identity.orgId,
    userId: identity.userId,
    runId: identity.runId,
    brandIds: [identity.brandId],
  });
  const answer = result.answers?.offer;
  const offerId = answer ? keyToOffer.get(answer.choice) : undefined;
  if (!answer || !offerId) throw new Error(`Jev answered no known offer option: ${JSON.stringify(answer ?? null).slice(0, 200)}`);
  const probabilities: Record<string, number> = {};
  for (const [key, id] of keyToOffer) probabilities[id] = answer.probabilities?.[key] ?? 0;
  return {
    offerId,
    verdict: {
      model: result.model,
      confidence: answer.confidence,
      probabilities,
      audiences: Object.fromEntries(offers.map((x) => [x.offerId, x.audienceId])),
      judgedAt: new Date().toISOString(),
      ...(o.evidence.eventOnly ? { eventOnly: true as const } : {}),
    },
  };
}

/** The offer an occurrence lands on (see the module doc for the order). Throws when a sibling or Jev is down. */
export async function resolveOccurrenceOffer(identity: SiblingIdentity, o: Occurrence): Promise<OfferPick> {
  if (o.statedOfferId) return { offerId: o.statedOfferId, basis: "campaign", verdict: null };
  const { mappings, offers } = await readStatedAndOffers(identity, o.formId);
  const stated = pickOffer(o.formId, mappings, offers);
  if (stated.offerId !== null) return { offerId: stated.offerId, basis: stated.basis, verdict: null };
  const active = offers.filter((x) => x.status === "active");
  if (active.length === 0) return stated;
  const activeIds = new Set(active.map((x) => x.offerId));

  const p = o.persisted;
  if (p.offerId && p.offerBasis && PERSISTED_BASES.has(p.offerBasis) && activeIds.has(p.offerId)) {
    return { offerId: p.offerId, basis: p.offerBasis as OfferBasis, verdict: (p.offerVerdict as OfferPickVerdict | null) ?? null };
  }

  const reached = pickReachedOffer(await reachedCandidates(identity, o), activeIds);
  if (reached) return { offerId: reached.offerId, basis: "person_reached", verdict: reached.evidence };

  let judgedOn = o;
  if (o.held) {
    const heldOffer = pickHeldOffer(o.held.offerIds, o.held.verdict.scores, activeIds);
    if (heldOffer) return { offerId: heldOffer, basis: "judged", verdict: o.held.verdict };
    const tagged = active.filter((a) => o.held!.offerIds.includes(a.offerId)).map((a) => a.name);
    if (tagged.length > 0) {
      judgedOn = { ...o, evidence: { ...o.evidence, eventOnly: false, facts: { ...o.evidence.facts, offersTheirConversationsAreAbout: tagged } } };
    }
  }

  const judged = await judgeOffer(identity, judgedOn, active);
  return { offerId: judged.offerId, basis: "judged", verdict: judged.verdict };
}

/** The contact a number came with, as Jev reads it (phone trigger evidence). */
export async function contactFacts(orgId: string, contactId: string | null): Promise<Record<string, unknown> | null> {
  if (!contactId) return null;
  const [c] = await db
    .select({
      companyName: contacts.companyName,
      website: contacts.website,
      jobTitle: contacts.jobTitle,
      city: contacts.city,
      note: contacts.note,
    })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)));
  if (!c) return null;
  const facts = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== ""));
  return Object.keys(facts).length > 0 ? facts : null;
}

/** PURE: a burst's messages as Jev reads them (reply trigger evidence): when, and what they wrote. */
export function burstFacts(messages: unknown): { at: string | null; text: string }[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => ({ at: typeof m?.at === "string" ? m.at : null, text: typeof m?.text === "string" ? m.text.slice(0, 2000) : "" }))
    .filter((m) => m.text.trim() !== "")
    .slice(-20);
}
