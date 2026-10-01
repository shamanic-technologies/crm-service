/**
 * The ONE state a person is served with — read from the source that states it,
 * never graded here.
 *
 * Precedence, first that applies wins:
 *  1. `lead_service` — the person is one of our leads: lead-service's own
 *     STANDING, verbatim (`unresolved | not_contacted | contacted | engaged |
 *     sales_interest | customer | disqualified | opted_out`). When lead-service
 *     could not be asked, the state is `unavailable` with the error — never a
 *     guess from the other sources.
 *  2. `stripe` — the brand's own Stripe account holds money from them. Stripe's
 *     FIXED subscription status vocabulary, prefixed: `subscription_active`,
 *     else `subscription_trialing`, else `subscription_past_due`, else
 *     `subscription_unpaid`; else `paid` (a succeeded charge not fully
 *     refunded); else `refunded` (every succeeded charge refunded in full); else
 *     `subscription_canceled` (a subscription that ended, no payment kept). A
 *     customer record with none of these states nothing and falls through.
 *     Money received is the strongest fact the brand's own systems hold, so it
 *     outranks a CRM deal stage; lead-service still comes first because it is
 *     verbatim about OUR leads.
 *  3. `gohighlevel` — the customer's own CRM holds a deal for them. GoHighLevel's
 *     FIXED opportunity status vocabulary, prefixed: `deal_won`, else
 *     `deal_open`, else `deal_lost`, else `deal_abandoned` (a person with
 *     several deals is at their most advanced). Stage names are the customer's
 *     free text and are carried in the detail verbatim, never mapped.
 *  4. `matrix` — the reading of their WhatsApp / Telegram / Discord thread
 *     (`new | qualifying | negotiating | won | lost | unresponsive`).
 *  5. `instantly` — they engaged with our cold email but are not one of our
 *     leads (a platform send): `replied`, else `clicked`.
 *  6. `none` — nothing states anything: `in_conversation`.
 *
 * The browser renders `state` + `stateSource`; it never computes either.
 */

export const STATE_SOURCES = ["lead_service", "stripe", "gohighlevel", "matrix", "instantly", "none"] as const;
export type StateSource = (typeof STATE_SOURCES)[number];

export const LEAD_STANDING_STATES = [
  "unresolved",
  "not_contacted",
  "contacted",
  "engaged",
  "sales_interest",
  "customer",
  "disqualified",
  "opted_out",
] as const;

export const DEAL_STATES = ["deal_won", "deal_open", "deal_lost", "deal_abandoned"] as const;
export const STRIPE_STATES = [
  "subscription_active",
  "subscription_trialing",
  "subscription_past_due",
  "subscription_unpaid",
  "paid",
  "refunded",
  "subscription_canceled",
] as const;

/** What one Stripe customer record states (see sources.ts `StripeStanding`). */
export interface StripeStandingInput {
  customerId: string;
  subscriptionStatuses: string[];
  paidCharges: number;
  refundedCharges: number;
  netPaidMinor: Record<string, number>;
}
export const INSTANTLY_STATES = ["replied", "clicked"] as const;

/** What lead-service said about one address. */
export type LeadObservation =
  | { found: false }
  | {
      found: true;
      email: string;
      /** lead-service's `standing` object, verbatim. */
      standing: Record<string, unknown> & { state: string };
      /** The leads_campaigns row whose standing it is (lead-service `sort=activity` first row). */
      leadCampaignId: string;
      leadId: string | null;
      campaignId: string | null;
      /** Every campaign this address is a lead on, for the brand. */
      campaignIds: string[];
    }
  | { found: "error"; error: string };

export interface GhlDeal {
  status: string | null;
  pipelineName: string | null;
  stageName: string | null;
  updatedAt: string | null;
}

export interface StateInputs {
  /** One observation per email of the person, in email order. */
  leadObservations: LeadObservation[];
  ghlDeals: GhlDeal[];
  /** One per Stripe customer record of the person. */
  stripe: StripeStandingInput[];
  /** matrix_leads.status per conversation, most recent conversation first. */
  matrixStatuses: string[];
  instantly: { replied: boolean; clicked: boolean; replyClassification: string | null } | null;
}

export interface PersonState {
  state: string;
  stateSource: StateSource;
  stateDetail: Record<string, unknown> | null;
}

const DEAL_ORDER: Record<string, (typeof DEAL_STATES)[number]> = {
  won: "deal_won",
  open: "deal_open",
  lost: "deal_lost",
  abandoned: "deal_abandoned",
};

export function resolvePersonState(input: StateInputs): PersonState {
  const lead = input.leadObservations.find((o) => o.found === true);
  if (lead && lead.found === true) {
    return {
      state: lead.standing.state,
      stateSource: "lead_service",
      stateDetail: {
        email: lead.email,
        standing: lead.standing,
        leadCampaignId: lead.leadCampaignId,
        leadId: lead.leadId,
        campaignId: lead.campaignId,
      },
    };
  }
  const failed = input.leadObservations.find((o) => o.found === "error");
  if (failed && failed.found === "error") {
    return { state: "unavailable", stateSource: "lead_service", stateDetail: { error: failed.error } };
  }

  const stripeState = resolveStripeState(input.stripe);
  if (stripeState) {
    return { state: stripeState, stateSource: "stripe", stateDetail: { customers: input.stripe } };
  }

  for (const status of ["won", "open", "lost", "abandoned"]) {
    const deals = input.ghlDeals.filter((d) => d.status === status);
    if (deals.length > 0) {
      return {
        state: DEAL_ORDER[status],
        stateSource: "gohighlevel",
        stateDetail: { deals: input.ghlDeals },
      };
    }
  }

  if (input.matrixStatuses.length > 0) {
    return {
      state: input.matrixStatuses[0],
      stateSource: "matrix",
      stateDetail: { statuses: input.matrixStatuses },
    };
  }

  if (input.instantly && (input.instantly.replied || input.instantly.clicked)) {
    return {
      state: input.instantly.replied ? "replied" : "clicked",
      stateSource: "instantly",
      stateDetail: { replyClassification: input.instantly.replyClassification },
    };
  }

  return { state: "in_conversation", stateSource: "none", stateDetail: null };
}

const LIVE_SUBSCRIPTION = ["active", "trialing", "past_due", "unpaid"] as const;

/** The person's Stripe state, or null when their Stripe record states nothing. */
export function resolveStripeState(customers: StripeStandingInput[]): (typeof STRIPE_STATES)[number] | null {
  if (customers.length === 0) return null;
  const statuses = customers.flatMap((c) => c.subscriptionStatuses);
  for (const s of LIVE_SUBSCRIPTION) {
    if (statuses.includes(s)) return `subscription_${s}`;
  }
  if (customers.some((c) => c.paidCharges > 0)) return "paid";
  if (customers.some((c) => c.refundedCharges > 0)) return "refunded";
  if (statuses.includes("canceled")) return "subscription_canceled";
  return null;
}
