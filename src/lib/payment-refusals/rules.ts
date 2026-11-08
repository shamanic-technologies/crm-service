/**
 * REFUSED-CARD-LEAD-EVENT-1103, the PURE half: a refused charge on a brand's Stripe is a Lead event.
 *
 * Owner 2026-11-03: « chacun de ces events doit être ajouté à l'unibox, et doit déclencher sur la brand distribute.you
 * Sophie sur la campagne actuelle lead event qui se demande si elle écrit ou postpone la date followup ». The Unibox half
 * already exists (UNIBOX-PAYMENT-REFUSED-1028: `payment_refused` on the payer's thread). This is the trigger half: ONE
 * occurrence of the GENERIC `account_event` trigger (a member of `lead_event`, like a credit running out) per refused
 * charge, for the person who paid, on the brand whose Stripe it is. Any brand with a Stripe connected, no brand named in
 * code. The Lead event workflow decides (write now, follow up later, nothing); nothing here writes a message.
 *
 * Never history: only a charge dated after its connection was made AND less than 24 h old is ever recorded. Several
 * refusals of ONE person waiting together (Stripe retries a card every hour; the first pass after deploy) are reported
 * as the LATEST one; the older ones are `superseded` (the writer reads every refusal on the thread anyway).
 */

import { createHash } from "node:crypto";
import { isStaffEmail } from "../owner-telegram.js";
import { normalizeEmail } from "../people/identity.js";
import { doorPersonKey, NO_EMAIL_OR_PHONE } from "../trigger-door.js";
import { stripeAttempt, formatMoney, refusalReason } from "../stripe/attempts.js";
import { ACCOUNT_EVENT_TRIGGER } from "../credit-events/rules.js";

/** The `item.kind` campaign-service hands the workflow (the timeline's own step name). */
export const PAYMENT_REFUSED_KIND = "payment_refused";
/** A refused charge older than this is history: never reported. */
export const REFUSAL_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REFUSAL_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;
export const REFUSAL_REASONS = {
  STAFF: "staff",
  NO_EMAIL_OR_PHONE,
  SUPERSEDED: "superseded",
  OFFER_UNKNOWN: "offer_unknown",
  /** Placing the refusal on ONE offer failed (lib/offer-pick.ts: a sibling or Jev down): retried. */
  OFFER_PICK_FAILED: "offer_pick_failed",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
} as const;

/** PURE: a Stripe money record that is a refused card payment (the timeline's `payment_refused`). */
export function isRefusedCharge(t: { kind: string; status: string | null }): boolean {
  return t.kind === "payment" && t.status === "failed";
}

/** PURE: may a refused charge be recorded at all (dated after its connection was made, less than 24 h old)? */
export function refusalIsFresh(chargedAt: Date, connectionCreatedAt: Date, now: number): boolean {
  return chargedAt.getTime() >= connectionCreatedAt.getTime() && now - chargedAt.getTime() <= REFUSAL_FRESH_WINDOW_MS;
}

/** PURE: the first decision on a fresh refusal: report it, or skip it because nobody campaign-service can file is named. */
export function refusalVerdict(email: string | null, phone: string | null):
  | { status: "pending"; email: string | null; phone: string | null }
  | { status: "skipped"; reason: "staff" | typeof NO_EMAIL_OR_PHONE; email: string | null; phone: string | null } {
  const e = normalizeEmail(email);
  if (e && isStaffEmail(e)) return { status: "skipped", reason: REFUSAL_REASONS.STAFF, email: e, phone };
  const key = doorPersonKey(e, phone);
  if (!key) return { status: "skipped", reason: NO_EMAIL_OR_PHONE, email: e, phone };
  return { status: "pending", email: key.email, phone: key.phone };
}

export interface DueRefusal {
  id: string;
  brandId: string;
  email: string | null;
  phone: string | null;
  chargedAt: Date;
  chargeId: string;
}

/** PURE: of the due refusals, the ones to report (latest per brand x person) and the ones a newer one supersedes. */
export function latestPerPerson<T extends DueRefusal>(due: readonly T[]): { report: T[]; superseded: T[] } {
  const latest = new Map<string, T>();
  const key = (r: T) => `${r.brandId}|${r.email ?? r.phone ?? r.id}`;
  for (const r of due) {
    const k = key(r);
    const cur = latest.get(k);
    if (!cur || r.chargedAt.getTime() > cur.chargedAt.getTime() || (r.chargedAt.getTime() === cur.chargedAt.getTime() && r.chargeId > cur.chargeId)) {
      latest.set(k, r);
    }
  }
  const keep = new Set([...latest.values()].map((r) => r.id));
  return { report: due.filter((r) => keep.has(r.id)), superseded: due.filter((r) => !keep.has(r.id)) };
}

/** PURE: one occurrence per (charge, person, offer): a retry replays campaign-service's first event. */
export function refusalIdempotencyKey(chargeId: string, who: string, offerId: string): string {
  const h = createHash("sha256").update(who.toLowerCase()).digest("hex").slice(0, 16);
  return `crm:account_event:stripe_charge:${chargeId}:${h}:${offerId}`;
}

export interface RefusalOccurrence {
  brandId: string;
  offerId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  chargeId: string;
  chargedAt: Date;
  amountMinor: number | null;
  currency: string | null;
  description: string | null;
  detail: Record<string, unknown>;
  stripeAccountId: string | null;
}

/** PURE: campaign-service's trigger door body (absent person values omitted, never null). */
export function refusalOccurrenceBody(o: RefusalOccurrence): Record<string, unknown> {
  const person: Record<string, unknown> = {};
  if (o.email) person.email = o.email;
  if (o.phone) person.phone = o.phone;
  if (o.name) person.name = o.name.slice(0, 300);
  const who = o.email ?? o.phone ?? "";
  return {
    triggerId: ACCOUNT_EVENT_TRIGGER,
    brandId: o.brandId,
    offerId: o.offerId,
    idempotencyKey: refusalIdempotencyKey(o.chargeId, who, o.offerId),
    occurredAt: o.chargedAt.toISOString(),
    person,
    item: {
      kind: PAYMENT_REFUSED_KIND,
      text: stripeAttempt({ kind: "payment", amountMinor: o.amountMinor, currency: o.currency, status: "failed", description: o.description, detail: o.detail }).text,
      source: "stripe",
      chargeId: o.chargeId,
      amount: formatMoney(o.amountMinor, o.currency),
      amountMinor: o.amountMinor,
      currency: o.currency,
      reason: refusalReason(o.detail),
      description: o.description,
      stripeAccountId: o.stripeAccountId,
      at: o.chargedAt.toISOString(),
    },
  };
}
