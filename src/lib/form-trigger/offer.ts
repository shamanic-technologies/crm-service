/**
 * Which offer a brand's form submission is about. campaign-service runs a
 * campaign per (brand, offer), so a `form_submitted` occurrence must name one.
 *
 * In order, the first that answers:
 *  1. a STATED mapping for this form (`form_offer_mappings`, form id exact);
 *  2. a stated mapping for every form of the brand (`form_id = '*'`);
 *  3. the brand's ONLY active offer (brand-service).
 * Nothing else: a brand with several active offers and no stated mapping is
 * `offer_unknown`, recorded on the report and logged, never a guess.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { formOfferMappings } from "../../db/schema.js";
import { siblingGetOk, type SiblingIdentity } from "../people/siblings.js";

export const ALL_FORMS = "*";

export interface BrandOffer {
  offerId: string;
  name: string;
  status: string;
}

export type OfferAnswer =
  | { offerId: string; basis: "stated_for_form" | "stated_for_brand" | "only_offer" }
  | { offerId: null; reason: "offer_unknown"; detail: string };

/** The brand's offers, from brand-service. Fails loud. */
export async function readBrandOffers(identity: SiblingIdentity): Promise<BrandOffer[]> {
  const body = await siblingGetOk<{ offers: BrandOffer[] }>(
    "brand",
    `/internal/brands/${encodeURIComponent(identity.brandId)}/offers`,
    identity,
  );
  return body.offers;
}

/** PURE: the answer from the stated mappings and the brand's offers. */
export function pickOffer(
  formId: string | null,
  mappings: { formId: string; offerId: string }[],
  offers: BrandOffer[],
): OfferAnswer {
  const forForm = formId ? mappings.find((m) => m.formId === formId) : undefined;
  if (forForm) return { offerId: forForm.offerId, basis: "stated_for_form" };
  const forBrand = mappings.find((m) => m.formId === ALL_FORMS);
  if (forBrand) return { offerId: forBrand.offerId, basis: "stated_for_brand" };
  const active = offers.filter((o) => o.status === "active");
  if (active.length === 1) return { offerId: active[0].offerId, basis: "only_offer" };
  return {
    offerId: null,
    reason: "offer_unknown",
    detail:
      active.length === 0
        ? "the brand has no active offer"
        : `the brand has ${active.length} active offers and no stated offer for form ${formId ?? "(none)"}: ` +
          "state it with PUT /orgs/gohighlevel/form-offers",
  };
}

export async function resolveOffer(identity: SiblingIdentity, formId: string | null): Promise<OfferAnswer> {
  const keys = formId ? [formId, ALL_FORMS] : [ALL_FORMS];
  const [mappings, offers] = await Promise.all([
    db
      .select({ formId: formOfferMappings.formId, offerId: formOfferMappings.offerId })
      .from(formOfferMappings)
      .where(
        and(
          eq(formOfferMappings.orgId, identity.orgId),
          eq(formOfferMappings.brandId, identity.brandId),
          inArray(formOfferMappings.formId, keys),
        ),
      ),
    readBrandOffers(identity),
  ]);
  return pickOffer(formId, mappings, offers);
}
