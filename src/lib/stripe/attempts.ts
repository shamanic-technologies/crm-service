/**
 * What each Stripe money record WAS, in words a reader of the Unibox gets at a glance
 * (UNIBOX-PAYMENT-REFUSED-1028, owner 2026-10-28: « Les paiements refusés doivent être dans
 * l'unibox tout simplement, comme toutes les tentatives de paiement »). Pure, no I/O.
 *
 * Every payment ATTEMPT is a charge; only a `succeeded` one is money received. Before, every
 * charge was served as step `payment` (painted green with a money icon) whatever its status,
 * so a refused card read as a payment (2026-10-28: a $50 card check and a $100 top-up, both
 * refused for insufficient funds, and a writer told the person "your top-up is going through").
 *
 * Steps (the producer's words; the dashboard only names them):
 *  - `payment`          a charge that succeeded: money received.
 *  - `payment_refused`  a charge that failed (declined card, insufficient funds...), with Stripe's reason.
 *  - `payment_pending`  a charge not settled yet (bank debits).
 *  - `payment_disputed` a charge the payer contested with their bank.
 *  - `refund` / `refund_failed`, `subscription_started` / `subscription_canceled`.
 * The vendor's status and reason stay verbatim in `event.detail`.
 */

import { majorAmount } from "./records.js";

export interface StripeMoneyRecord {
  kind: string;
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
  description: string | null;
  detail: Record<string, unknown>;
}

export interface StripeAttempt {
  step: string;
  text: string;
}

/** `$50.00`, `€12.50`, `¥500`: the amount in its own currency, or null when Stripe stated none. */
export function formatMoney(amountMinor: number | null, currency: string | null): string | null {
  const major = majorAmount(amountMinor, currency);
  if (major === null || !currency) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(major);
  } catch {
    // A currency code Intl does not know: Stripe's own code beside the number, never dropped.
    return `${major} ${currency.toUpperCase()}`;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Stripe's code in plain words: `insufficient_funds` -> `insufficient funds`. */
const codeWords = (code: string): string => code.replace(/_/g, " ");

/** Why a charge failed: Stripe's own sentence, else its decline reason / failure code in words. */
export function refusalReason(detail: Record<string, unknown>): string | null {
  const message = str(detail.failureMessage);
  if (message) return message;
  const code = str(detail.declineReason) ?? str(detail.failureCode);
  return code ? codeWords(code) : null;
}

const joined = (...parts: (string | null)[]): string => parts.filter((p): p is string => !!p).join(" · ");

function headline(label: string, money: string | null): string {
  return money ? `${label}: ${money}` : label;
}

/** A charge or refund: its step and its label. Subscriptions keep their own two steps (`subscriptionAttempt`). */
export function stripeAttempt(t: StripeMoneyRecord): StripeAttempt {
  const money = formatMoney(t.amountMinor, t.currency);
  if (t.kind === "refund") {
    const failed = t.status === "failed" || t.status === "canceled";
    const reason = str(t.detail.reason);
    return {
      step: failed ? "refund_failed" : "refund",
      text: joined(headline(failed ? "Refund failed" : "Refund", money), reason ? codeWords(reason) : null),
    };
  }
  if (t.kind === "subscription") return subscriptionAttempt(t, false);
  if (t.status === "failed") {
    return {
      step: "payment_refused",
      text: joined(headline("Payment refused", money), refusalReason(t.detail), t.description),
    };
  }
  if (t.status === "pending") {
    return { step: "payment_pending", text: joined(headline("Payment pending", money), t.description) };
  }
  if (t.status === "succeeded" && t.detail.disputed === true) {
    return { step: "payment_disputed", text: joined(headline("Payment disputed", money), t.description) };
  }
  if (t.status === "succeeded") {
    const refundedMinor = typeof t.detail.amountRefunded === "number" ? t.detail.amountRefunded : 0;
    const refunded = refundedMinor > 0 ? `refunded ${formatMoney(refundedMinor, t.currency) ?? ""}`.trim() : null;
    return { step: "payment", text: joined(headline("Payment received", money), refunded, t.description) };
  }
  // A status Stripe adds later: never read as money received.
  return {
    step: "payment_attempt",
    text: joined(headline(`Payment ${t.status ?? "attempt"}`, money), t.description),
  };
}

/** A subscription's start, or (`canceled`) its end. */
export function subscriptionAttempt(t: StripeMoneyRecord, canceled: boolean): StripeAttempt {
  const money = formatMoney(t.amountMinor, t.currency);
  const interval = str(t.detail.interval);
  const price = money ? (interval ? `${money} / ${interval}` : money) : null;
  return canceled
    ? { step: "subscription_canceled", text: joined(headline("Subscription canceled", price), t.description) }
    : { step: "subscription_started", text: joined(headline("Subscription started", price), t.description) };
}
