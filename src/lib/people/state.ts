/**
 * The ONE state a person is served with — read from the source that states it,
 * never graded here.
 *
 * Precedence, first that applies wins:
 *  1. `lead_service` — lead-service serves a lead state for the person
 *     (LEAD-GENERIC-1106: its ONE lead vocabulary, `leadState`, read off its
 *     Unibox, lead-state.ts). `state` = its verdict `won | hot | lost`, else
 *     `open`; the whole `leadState` (Lifecycle, reachable, conversation, fit,
 *     interest, client status, next follow-up) rides in the detail and is served
 *     as the person's `leadState`. The lead row the person's address is
 *     (`leadCampaignId`, `leadId`, campaign) and lead-service's marks on it
 *     (`disqualification`, `company`, `human`) ride beside it, verbatim. When
 *     lead-service could not be asked about a lead, the state is `unavailable`
 *     with the error, never a guess from the other sources.
 *  2. `stripe` — the brand's own Stripe account holds money from them. Stripe's
 *     FIXED subscription status vocabulary, prefixed: `subscription_active`,
 *     else `subscription_trialing`, else `subscription_past_due`, else
 *     `subscription_unpaid`; else `paid` (a succeeded charge not fully
 *     refunded); else `refunded` (every succeeded charge refunded in full); else
 *     `subscription_canceled` (a subscription that ended, no payment kept). A
 *     customer record with none of these states nothing and falls through.
 *  3. `gohighlevel` — the customer's own CRM holds a deal for them. GoHighLevel's
 *     FIXED opportunity status vocabulary, prefixed: `deal_won`, else
 *     `deal_open`, else `deal_lost`, else `deal_abandoned` (a person with
 *     several deals is at their most advanced). Stage names are the customer's
 *     free text and are carried in the detail verbatim, never mapped.
 *  4. `matrix` — the reading of their WhatsApp / Telegram / Discord thread
 *     (`new | qualifying | negotiating | won | lost | unresponsive`).
 *  5. `instantly` — they engaged with our cold email: `replied`, else `clicked`.
 *  6. `none` — nothing states anything: `in_conversation`.
 * Sources 2-6 are crm-service's own facts about someone lead-service serves no
 * lead state for; none of them is a lead verdict.
 *
 * The browser renders `state` + `stateSource`; it never computes either.
 */
import { leadStateWord, matchLeadState, type BrandLeadStates, type LeadState, type LeadStateMatch } from "./lead-state.js";

export const STATE_SOURCES = ["lead_service", "stripe", "gohighlevel", "matrix", "instantly", "none"] as const;
export type StateSource = (typeof STATE_SOURCES)[number];

/**
 * lead-service's Disqualified MARK on a lead row (`disqualification`), verbatim:
 * null = not disqualified for that conversation. Never derived here.
 */
export interface LeadDisqualification {
  /** lead-service's level, verbatim: `lead` (this person at this company) or `company` ("not our target"). */
  level: string;
  offerId: string | null;
  note: string | null;
  source: string;
  statedByUserId: string | null;
  statedAt: string;
}

/**
 * lead-service's COMPANY block on a lead row (`company`), verbatim: the company
 * the lead is at and what is true of it as a buyer of the brand. null = no
 * company known. Never derived here.
 */
export interface LeadCompanyTags {
  id: string | null;
  key: string;
  isClient: boolean;
  signedUp: boolean;
  disqualification: LeadDisqualification | null;
}

/**
 * lead-service's HUMAN block on a lead row (`human`), verbatim: what human-service
 * holds on the human wherever they work. null = lead-service could not resolve
 * the row's standing (never read as false). Never derived here.
 */
export interface LeadHumanTags {
  optedOut: boolean;
  doNotContact: boolean;
}

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
      /** lead-service's Disqualified mark on that same row, verbatim (null = not disqualified). */
      disqualification: LeadDisqualification | null;
      /** lead-service's company block on that same row, verbatim (null = no company known). */
      company: LeadCompanyTags | null;
      /** lead-service's human block on that same row, verbatim. */
      human: LeadHumanTags | null;
      /** The address's leads_campaigns row (lead-service `sort=activity` first row). */
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
  /** The person's human (lead-service's Unibox rows are keyed on it). */
  humanId: string | null;
  /** lead-service's lead states for the brand (lead-state.ts), or why they could not be read. */
  leadStates: { ok: true; states: Pick<BrandLeadStates, "byLeadId" | "byHuman"> } | { ok: false; error: string };
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
  const leads = input.leadObservations.filter((o): o is Extract<LeadObservation, { found: true }> => o.found === true);
  const failed = input.leadObservations.find((o) => o.found === "error");
  if (failed && failed.found === "error") {
    return { state: "unavailable", stateSource: "lead_service", stateDetail: { error: failed.error } };
  }
  if (!input.leadStates.ok) {
    // Unreadable lead states: anyone lead-service may hold (a lead, or a human its Unibox may hold) is unknown.
    if (leads.length > 0 || input.humanId) {
      return { state: "unavailable", stateSource: "lead_service", stateDetail: { error: input.leadStates.error } };
    }
  } else {
    const leadIds = leads.map((o) => o.leadId).filter((id): id is string => !!id);
    const match = matchLeadState(leadIds, input.humanId, input.leadStates.states);
    if (match) {
      // The lead row relayed is the one the matched Unibox row holds, else the person's first lead.
      const lead = leads.find((o) => o.leadId && match.row.leadIds.includes(o.leadId)) ?? leads[0] ?? null;
      return { state: leadStateWord(match.row.leadState), stateSource: "lead_service", stateDetail: leadDetail(match.row.leadState, match.matchedBy, match.row, lead) };
    }
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

/**
 * A person's addresses, those lead-service serves for one of our leads first
 * (each group in key order). The Unibox shows a lead under the address
 * lead-service knows it by, never a CRM or Gmail address merged into it.
 */
export function leadAddressesFirst(emails: string[], observations: Map<string, LeadObservation>): string[] {
  const isLead = (e: string) => observations.get(e)?.found === true;
  return [...emails.filter(isLead), ...emails.filter((e) => !isLead(e))];
}

function leadDetail(
  leadState: LeadState,
  matchedBy: LeadStateMatch,
  row: { humanId: string; companyKey: string; relationKey: string | null },
  lead: Extract<LeadObservation, { found: true }> | null,
): Record<string, unknown> {
  return {
    leadState,
    matchedBy,
    unibox: { humanId: row.humanId, companyKey: row.companyKey, relationKey: row.relationKey },
    ...(lead
      ? {
          email: lead.email,
          disqualification: lead.disqualification,
          company: lead.company,
          human: lead.human,
          leadCampaignId: lead.leadCampaignId,
          leadId: lead.leadId,
          campaignId: lead.campaignId,
        }
      : {}),
  };
}
