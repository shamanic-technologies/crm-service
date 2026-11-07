/**
 * WHICH OFFER A FORM FILL LANDS ON when the brand stated none for the form
 * (FORM-OFFER-PICK-1108, owner 2026-11-08). A brand sells several offers, each to
 * ONE audience (AUDIENCE-PER-OFFER-1107); Doc Dinners states no offer per form, so
 * "the brand's only offer" no longer answers and every fill was dropped
 * `offer_unknown`. In order, the first that answers:
 *
 *  1. a STATED offer (offer.ts `pickOffer`: this form, then every form), then the
 *     brand's ONLY active offer: unchanged, a statement always wins;
 *  2. the pick already PERSISTED on this report (judged once: a retry never re-asks);
 *  3. the offer that already REACHED this person at this brand (owner rule: a person
 *     is contacted for ONE offer of a brand): a fill of theirs we already reported
 *     on an offer, or an audience of an offer that SERVED them (human-service
 *     memberships by email, provenance `served`); the earliest wins;
 *  4. Jev (`choice` over the brand's active offers) reads the form's answers against
 *     each offer as the client created it (name, what it sells) and its audience's
 *     text (human-service `targetText` of the offer's `role: "target"` audience).
 *     The most probable offer; its confidence and probabilities are persisted.
 *
 * Never a default offer, never a rule on the answers' words. A fill that still
 * cannot be placed (no active offer, a sibling down, Jev down) stays `failed` with
 * its reason, logged and retried by the watch (red on Monitoring when stuck).
 */
import { and, asc, eq, isNotNull, ne, or, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { formTriggerReports, type FormTriggerReport } from "../../db/schema.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import { readBrandContext } from "../people/relevance.js";
import { siblingGetOk, siblingQuery, type SiblingIdentity } from "../people/siblings.js";
import { readStatedAndOffers, pickOffer, type BrandOffer } from "./offer.js";

export type FormOfferBasis = "stated_for_form" | "stated_for_brand" | "only_offer" | "person_reached" | "judged";

/** Persisted on the report (`offer_verdict`) when Jev placed the fill. */
export interface OfferVerdict {
  model: string;
  confidence: number;
  /** Per offer id. */
  probabilities: Record<string, number>;
  /** The offer audience each offer was judged against (null = the offer has no audience text). */
  audiences: Record<string, string | null>;
  judgedAt: string;
}

/** How a person was already reached for an offer (persisted as the verdict of a `person_reached` pick). */
export interface ReachedEvidence {
  via: "form_report" | "audience_served";
  /** The earlier report id, or the audience id. */
  ref: string;
  at: string;
}

export type FormOfferAnswer =
  | { offerId: string; basis: FormOfferBasis; verdict: OfferVerdict | ReachedEvidence | null }
  | { offerId: null; reason: "offer_unknown"; detail: string };

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

interface HumanMembership {
  audienceId: string;
  offerId: string | null;
  provenance: string;
  joinedAt: string;
}

/** The fills of this person we already reported on an offer, and the offer audiences that served them. */
async function reachedCandidates(identity: SiblingIdentity, r: FormTriggerReport) {
  const who: SQL[] = [];
  if (r.email) who.push(eq(formTriggerReports.email, r.email));
  if (r.phone) who.push(eq(formTriggerReports.phone, r.phone));
  const out: { offerId: string | null; at: Date; evidence: ReachedEvidence }[] = [];
  if (who.length > 0) {
    const earlier = await db
      .select({ id: formTriggerReports.id, offerId: formTriggerReports.offerId, reportedAt: formTriggerReports.reportedAt })
      .from(formTriggerReports)
      .where(
        and(
          eq(formTriggerReports.orgId, r.orgId),
          eq(formTriggerReports.brandId, r.brandId),
          ne(formTriggerReports.id, r.id),
          eq(formTriggerReports.status, "reported"),
          isNotNull(formTriggerReports.offerId),
          or(...who),
        ),
      )
      .orderBy(asc(formTriggerReports.reportedAt));
    for (const e of earlier) {
      const at = e.reportedAt ?? new Date(0);
      out.push({ offerId: e.offerId, at, evidence: { via: "form_report", ref: e.id, at: at.toISOString() } });
    }
  }
  // human-service answers by email only; a phone-only fill is read on our own reports alone.
  if (r.email) {
    const body = await siblingQuery<{ byEmail: Record<string, { memberships: HumanMembership[] } | null> }>(
      "human",
      `/internal/brands/${encodeURIComponent(r.brandId)}/memberships/by-email`,
      identity,
      { orgId: r.orgId, emails: [r.email] },
    );
    for (const m of body.byEmail?.[r.email]?.memberships ?? []) {
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
  form: { formName: string | null; answers: { key: string; label: string | null; value: unknown }[] },
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
      formFill: {
        formName: form.formName,
        answers: form.answers.map((a) => ({ question: a.label ?? a.key, answer: a.value })),
      },
    },
    question: {
      type: "choice",
      instructions:
        "A person just filled a form of this brand. The brand sells several offers, each to its own audience. " +
        "The person must be contacted about ONE of them: the offer whose audience they belong to. Read who the " +
        "person is and what they want from their answers (their job, business, situation, needs) and pick the " +
        "offer whose audience and what it sells fit them best.",
      criteria,
    },
    keyToOffer,
  };
}

/** Ask Jev which offer the fill is about. Fails loud on a malformed answer. */
async function judgeOffer(identity: SiblingIdentity, r: FormTriggerReport, active: BrandOffer[]): Promise<{ offerId: string; verdict: OfferVerdict }> {
  const context = await readBrandContext(identity);
  const audiences = await Promise.all(active.map((o) => readOfferAudience(identity, o.offerId)));
  const offers: JudgedOffer[] = active
    .map((o, k) => ({
      offerId: o.offerId,
      name: o.name,
      whatWeOffer: context.offers.find((c) => c.offerId === o.offerId)?.whatWeOffer ?? null,
      audienceId: audiences[k]?.id ?? null,
      audienceText: audiences[k]?.targetText?.trim() || null,
    }))
    .sort((a, b) => (a.offerId < b.offerId ? -1 : 1));
  const blind = offers.filter((o) => !o.audienceText).map((o) => o.offerId);
  if (blind.length > 0) {
    console.warn(
      `[crm-service][form-trigger] brand ${r.brandId}: offer(s) ${blind.join(", ")} have no audience text; ` +
        `submission ${r.submissionId} is judged on their name and what they sell only`,
    );
  }
  const { state, question, keyToOffer } = offerChoice(context.brand, offers, {
    formName: r.formName,
    answers: (r.answers as { key: string; label: string | null; value: unknown }[]) ?? [],
  });
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
      audiences: Object.fromEntries(offers.map((o) => [o.offerId, o.audienceId])),
      judgedAt: new Date().toISOString(),
    },
  };
}

/** The offer a recorded form fill lands on (see the module doc for the order). */
export async function resolveFormOffer(identity: SiblingIdentity, r: FormTriggerReport): Promise<FormOfferAnswer> {
  const { mappings, offers } = await readStatedAndOffers(identity, r.formId);
  const stated = pickOffer(r.formId, mappings, offers);
  if (stated.offerId !== null) return { offerId: stated.offerId, basis: stated.basis, verdict: null };
  const active = offers.filter((o) => o.status === "active");
  if (active.length === 0) return stated;
  const activeIds = new Set(active.map((o) => o.offerId));

  if (r.offerId && r.offerBasis && PERSISTED_BASES.has(r.offerBasis) && activeIds.has(r.offerId)) {
    return { offerId: r.offerId, basis: r.offerBasis as FormOfferBasis, verdict: (r.offerVerdict as OfferVerdict | ReachedEvidence | null) ?? null };
  }

  const reached = pickReachedOffer(await reachedCandidates(identity, r), activeIds);
  if (reached) return { offerId: reached.offerId, basis: "person_reached", verdict: reached.evidence };

  const judged = await judgeOffer(identity, r, active);
  return { offerId: judged.offerId, basis: "judged", verdict: judged.verdict };
}
