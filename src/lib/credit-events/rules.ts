/**
 * CREDIT-RAN-OUT-UNIBOX-EVENT-1024, the PURE half: what billing-service's credit events become on the staff Unibox.
 *
 * Owner 2026-10-24: « A chaque event de l'Unibox pour un client actuel (non perso) une campagne réactive se déclenche »
 * and NO credit-specific trigger (« non »). So a credit event is a NORMAL Unibox event of the client's people:
 *  - a timeline event on each member's thread (source `billing`, channel `account`): "Credit ran out" / "Credit restored";
 *  - a fact on the people fact feed (family `billing_credit`, history: never withdrawn), so lead-service reads it like
 *    any act of theirs;
 *  - ONE occurrence of the GENERIC `account_event` trigger ("Account Event": something happened on the client's account
 *    with us; declared data in features-service, kind `reported`, reportedBy crm-service) per member, which makes it a
 *    `lead_event` ("Lead event") occurrence like any member trigger. The credit kind rides in `item.kind`; no pipe heads
 *    `account_event` itself.
 * Never history: an event dated before the first pass (`watch_since`) or more than 24 h before it is reported is shown and
 * stated, never reported (`before_watch` / `stale`).
 */

import { createHash } from "node:crypto";
import { normalizeEmail } from "../people/identity.js";
import { isStaffEmail } from "../owner-telegram.js";

export const CREDIT_EVENT_TYPES = ["credit_ran_out", "credit_restored"] as const;
export type CreditEventType = (typeof CREDIT_EVENT_TYPES)[number];

/** The generic trigger every account fact is reported as (a member of `lead_event`). */
export const ACCOUNT_EVENT_TRIGGER = "account_event";
/** The timeline channel of an account fact. */
export const ACCOUNT_CHANNEL = "account";
/** An event older than this when it would be reported is history (lead-service's outcome triggers use the same 24 h). */
export const CREDIT_REPORT_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export const CREDIT_REPORT_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;
export const CREDIT_REPORT_REASONS = {
  BEFORE_WATCH: "before_watch",
  STALE: "stale",
  OFFER_UNKNOWN: "offer_unknown",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
} as const;

export interface FeedEvent {
  eventId: string;
  type: CreditEventType;
  orgId: string;
  episodeId: string;
  at: string;
}

export interface FeedPage {
  events: FeedEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PURE: billing's page, checked field by field. A malformed event fails the whole page loud (nothing stored). */
export function parseFeedPage(body: unknown): FeedPage {
  const b = body as { events?: unknown; nextCursor?: unknown; hasMore?: unknown } | null;
  if (!b || !Array.isArray(b.events)) throw new Error("billing-service credit-events answered no events list");
  if (typeof b.hasMore !== "boolean") throw new Error("billing-service credit-events answered no hasMore");
  if (b.nextCursor !== null && b.nextCursor !== undefined && typeof b.nextCursor !== "string") {
    throw new Error("billing-service credit-events answered an unreadable nextCursor");
  }
  const events = b.events.map((raw, i): FeedEvent => {
    const e = raw as Record<string, unknown>;
    const where = `billing-service credit event #${i}`;
    if (typeof e.eventId !== "string" || !e.eventId) throw new Error(`${where}: no eventId`);
    if (!(CREDIT_EVENT_TYPES as readonly unknown[]).includes(e.type)) throw new Error(`${where}: unknown type ${JSON.stringify(e.type)}`);
    if (typeof e.orgId !== "string" || !UUID.test(e.orgId)) throw new Error(`${where}: orgId is not a uuid`);
    if (typeof e.episodeId !== "string" || !UUID.test(e.episodeId)) throw new Error(`${where}: episodeId is not a uuid`);
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) throw new Error(`${where}: at is not a date`);
    return { eventId: e.eventId, type: e.type as CreditEventType, orgId: e.orgId, episodeId: e.episodeId, at: e.at };
  });
  return { events, nextCursor: (b.nextCursor as string | null | undefined) ?? null, hasMore: b.hasMore };
}

/** PURE: the org's people an event is about: every member address, normalized, staff dropped (staff is nobody). */
export function memberEmailsOf(emails: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of emails) {
    const e = normalizeEmail(raw);
    if (e && !isStaffEmail(e)) out.add(e);
  }
  return [...out].sort();
}

/** PURE: the words on the thread. */
export function creditEventText(type: CreditEventType | string, orgLabel: string | null): string {
  const what = type === "credit_restored" ? "Credit restored" : "Credit ran out";
  return orgLabel ? `${what} · ${orgLabel}` : what;
}

/** PURE: the date basis each type states (billing's episode opened / a real recharge landed). */
export function creditDateBasis(type: CreditEventType | string): string {
  return type === "credit_restored" ? "credit_restored_at" : "credit_ran_out_at";
}

/** PURE: may this event still be reported as a Lead event, or is it history? */
export function reportVerdict(
  at: Date,
  watchSince: Date,
  now: number,
): { status: "pending" } | { status: "skipped"; reason: "before_watch" | "stale" } {
  if (at.getTime() < watchSince.getTime()) return { status: "skipped", reason: CREDIT_REPORT_REASONS.BEFORE_WATCH };
  if (now - at.getTime() > CREDIT_REPORT_FRESH_WINDOW_MS) return { status: "skipped", reason: CREDIT_REPORT_REASONS.STALE };
  return { status: "pending" };
}

/**
 * PURE: the offers one report is filed under. The person's own offer tags (the registry's Jev on their conversations)
 * among the brand's ACTIVE offers, else every active offer (the fact is about the account, not an offer: lead-service's
 * "one event each" rule). None active = nothing to file under.
 */
export function reportOffers(personOfferIds: readonly string[], activeOfferIds: readonly string[]): string[] {
  const active = [...new Set(activeOfferIds)].sort();
  const tagged = active.filter((o) => personOfferIds.includes(o));
  return tagged.length > 0 ? tagged : active;
}

/** PURE: one occurrence per (event, address, offer): a retry replays campaign-service's first event. */
export function creditIdempotencyKey(eventId: string, email: string, offerId: string): string {
  const who = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16);
  return `crm:account_event:${eventId}:${who}:${offerId}`;
}

export interface CreditOccurrence {
  brandId: string;
  offerId: string;
  email: string;
  name: string | null;
  eventId: string;
  type: CreditEventType | string;
  creditOrgId: string;
  episodeId: string;
  orgLabel: string | null;
  at: Date;
}

/** PURE: campaign-service's trigger door body. */
export function creditOccurrenceBody(o: CreditOccurrence): Record<string, unknown> {
  const person: Record<string, unknown> = { email: o.email };
  if (o.name) person.name = o.name.slice(0, 300);
  return {
    triggerId: ACCOUNT_EVENT_TRIGGER,
    brandId: o.brandId,
    offerId: o.offerId,
    idempotencyKey: creditIdempotencyKey(o.eventId, o.email, o.offerId),
    occurredAt: o.at.toISOString(),
    person,
    item: {
      kind: o.type,
      text: creditEventText(o.type, o.orgLabel),
      accountOrgId: o.creditOrgId,
      accountName: o.orgLabel,
      episodeId: o.episodeId,
      billingEventId: o.eventId,
      at: o.at.toISOString(),
    },
  };
}
