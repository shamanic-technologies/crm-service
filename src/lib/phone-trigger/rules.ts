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
 */
import { isStaffEmail } from "../owner-telegram.js";
import { ownTeamMatch, type OwnTeam } from "../reply-trigger/own-team.js";

/** The trigger id declared in features-service's catalogue (kind `reported`, reportedBy crm-service). */
export const PHONE_GIVEN_TRIGGER = "whatsapp_number_given";

export const PHONE_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;

export const PHONE_REASONS = {
  /** The number was already on a source when the watch first looked at it: history, never reported. */
  BEFORE_WATCH: "before_watch",
  /**
   * Learned from a chat the person opened (a bridged WhatsApp / LinkedIn conversation):
   * they WROTE to the brand, which the reply trigger reports; they gave no number.
   */
  CONVERSATION_CHANNEL: "conversation_channel",
  /** One of our staff (`isStaffEmail`), never a prospect. */
  STAFF: "staff",
  /** One of the brand's own numbers (a linked WhatsApp account, the sales rep phone). */
  OWN_TEAM: "own_team",
  OFFER_UNKNOWN: "offer_unknown",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
} as const;

export interface PhoneCandidate {
  contactId: string;
  orgId: string;
  brandId: string;
  source: string;
  /** Set only on a contact learned from a messaging channel (Matrix). */
  channel: string | null;
  phone: string;
  email: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  sourceContactId: string | null;
  artifactId: string | null;
}

/**
 * PURE: why a new number is NOT reported, or null when it is. Structural only: who
 * a campaign may write to beyond this is the answering pipe's strategy, never ours.
 */
export function phoneSkipReason(c: PhoneCandidate, ownTeam: OwnTeam | null): string | null {
  if (c.channel) return PHONE_REASONS.CONVERSATION_CHANNEL;
  if (isStaffEmail(c.email)) return PHONE_REASONS.STAFF;
  if (ownTeam && ownTeamMatch([c.phone], ownTeam)) return PHONE_REASONS.OWN_TEAM;
  return null;
}

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
    idempotencyKey: phoneIdempotencyKey(o.brandId, o.phone),
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
