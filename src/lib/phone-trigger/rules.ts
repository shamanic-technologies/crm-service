/**
 * "WhatsApp number given" (WA-GIVEN-TRIGGER-1015, owner 2026-10-15: « dès qu'un lead
 * nous donne son WA, une campagne WA lui écrit instantanément »). PURE rules: who
 * counts, what is skipped and why, and the body campaign-service's trigger door gets.
 *
 * A number is GIVEN the first time any connector of the brand states it on a person
 * (a PostHog person property, a Clerk profile, a CRM contact, a Stripe customer...).
 * The occurrence's identity is (brand, number): reported once, whichever connector
 * states it first or again (a PostHog visitor who later signs up on Clerk with the
 * same number is ONE occurrence).
 *
 * The trigger states the FACT only (WA-GIVEN-PURE-FACT-1017, owner 2026-10-17): who a
 * pipe then writes to or skips (staff, the brand's own team, someone who already wrote)
 * is the answering pipe's strategy, which reads the person's timeline. Nothing here
 * filters on WHO the person is. A number learned because the person wrote to the brand
 * on a chat (WhatsApp, LinkedIn) is given too. The only skips: history (`before_watch`)
 * and a number nobody can be reached on (`invalid_number`).
 */
/** The trigger id declared in features-service's catalogue (kind `reported`, reportedBy crm-service). */
export const PHONE_GIVEN_TRIGGER = "whatsapp_number_given";

export const PHONE_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;

export const PHONE_REASONS = {
  /** The number was already on a source when the watch first looked at it: history, never reported. */
  BEFORE_WATCH: "before_watch",
  /**
   * RETIRED reasons (WA-GIVEN-PURE-FACT-1017): rows recorded before it keep them; no new
   * row gets them. Who to skip is the answering pipe's strategy.
   */
  CONVERSATION_CHANNEL: "conversation_channel",
  STAFF: "staff",
  OWN_TEAM: "own_team",
  /** A number nobody can be reached on (impossible under its country's plan): never offered. */
  INVALID_NUMBER: "invalid_number",
  OFFER_UNKNOWN: "offer_unknown",
  /** The owner said never send this one (an owner door, WA-GREETING-OFFER-1027): final. */
  WITHHELD: "withheld",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
} as const;

export function phoneIdempotencyKey(brandId: string, phone: string): string {
  return `crm:phone_given:${brandId}:${phone}`;
}

export interface PhoneOccurrence {
  brandId: string;
  offerId: string;
  phone: string;
  source: string;
  email: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  contactId: string | null;
  sourceContactId: string | null;
  detectedAt: Date;
  /**
   * An owner REPLAY (WA-GREETING-OFFER-1027): campaign-service's event this report first landed on, answered
   * `skipped / campaign_off` (its campaign was Off; that verdict is final there). The replay is a NEW
   * occurrence keyed on that event, so a retry of the replay is still idempotent.
   */
  replayOf?: string | null;
}

/**
 * PURE: the request body (campaign-service's `RecordTriggerEventBody`, strict): absent
 * values are OMITTED, never null. The person is named by email when one is held, and
 * always carries the number (what a WhatsApp campaign writes to).
 */
export function phoneOccurrenceBody(o: PhoneOccurrence): Record<string, unknown> {
  const person: Record<string, unknown> = { phone: o.phone };
  if (o.email) person.email = o.email;
  const name = o.fullName ?? ([o.firstName, o.lastName].filter(Boolean).join(" ") || null);
  if (name) person.name = name.slice(0, 300);
  return {
    triggerId: PHONE_GIVEN_TRIGGER,
    brandId: o.brandId,
    offerId: o.offerId,
    idempotencyKey: o.replayOf
      ? `${phoneIdempotencyKey(o.brandId, o.phone)}:replay:${o.replayOf}`
      : phoneIdempotencyKey(o.brandId, o.phone),
    occurredAt: o.detectedAt.toISOString(),
    person,
    item: {
      kind: "phone_given",
      phone: o.phone,
      // What a greeting reads ("Hi Marie"): the source's own first / last name, null when it states none.
      firstName: o.firstName,
      lastName: o.lastName,
      source: o.source,
      sourceContactId: o.sourceContactId,
      crmContactId: o.contactId,
      givenAt: o.detectedAt.toISOString(),
    },
  };
}
