import { describe, expect, it } from "vitest";
import { deriveCharge } from "../../src/lib/stripe/records.js";
import { formatMoney, stripeAttempt, subscriptionAttempt } from "../../src/lib/stripe/attempts.js";

/**
 * UNIBOX-PAYMENT-REFUSED-1028: every payment attempt reads as what it was. Payloads below are
 * the shape of the two prod charges of 2026-10-28 (a $50 card check and a $100 top-up, both
 * refused for insufficient funds) beside a charge that succeeded.
 */
const charge = (over: Record<string, unknown>) => ({
  id: "ch_1",
  object: "charge",
  created: 1793163639,
  customer: "cus_1",
  amount: 5000,
  currency: "usd",
  status: "succeeded",
  paid: true,
  refunded: false,
  amount_refunded: 0,
  disputed: false,
  description: null,
  failure_code: null,
  failure_message: null,
  outcome: { type: "authorized", reason: null },
  ...over,
});

const attemptOf = (payload: Record<string, unknown>) => {
  const t = deriveCharge(payload)!;
  return stripeAttempt({ kind: t.kind, amountMinor: t.amountMinor, currency: t.currency, status: t.status, description: t.description, detail: t.detail });
};

const REFUSED = {
  status: "failed",
  paid: false,
  failure_code: "card_declined",
  failure_message: "Your card has insufficient funds. Use a different payment method to complete this purchase.",
  outcome: { type: "issuer_declined", reason: "insufficient_funds", seller_message: "The bank returned the decline code `insufficient_funds`." },
};

describe("Stripe payment attempts", () => {
  it("a refused charge and a successful one map to different steps and labels", () => {
    const refused = attemptOf(charge({ ...REFUSED, description: "Distribute card check (nothing is charged)" }));
    const paid = attemptOf(charge({ description: "Distribute top-up" }));
    expect(refused.step).toBe("payment_refused");
    expect(paid.step).toBe("payment");
    expect(refused.text).toBe(
      "Payment refused: $50.00 · Your card has insufficient funds. Use a different payment method to complete this purchase. · Distribute card check (nothing is charged)",
    );
    expect(paid.text).toBe("Payment received: $50.00 · Distribute top-up");
  });

  it("a refused charge with no description still says refused, the amount and the reason", () => {
    expect(attemptOf(charge({ ...REFUSED, amount: 10000 })).text).toBe(
      "Payment refused: $100.00 · Your card has insufficient funds. Use a different payment method to complete this purchase.",
    );
  });

  it("no Stripe sentence: the decline reason in words", () => {
    expect(attemptOf(charge({ ...REFUSED, failure_message: null })).text).toBe("Payment refused: $50.00 · insufficient funds");
    expect(attemptOf(charge({ ...REFUSED, failure_message: null, outcome: null })).text).toBe("Payment refused: $50.00 · card declined");
  });

  it("pending, disputed, refunded and an unknown status never read as plain money received", () => {
    expect(attemptOf(charge({ status: "pending", paid: false })).step).toBe("payment_pending");
    expect(attemptOf(charge({ disputed: true })).step).toBe("payment_disputed");
    expect(attemptOf(charge({ refunded: true, amount_refunded: 5000 })).text).toBe("Payment received: $50.00 · refunded $50.00");
    const odd = attemptOf(charge({ status: "requires_review" }));
    expect(odd.step).toBe("payment_attempt");
    expect(odd.text).toBe("Payment requires_review: $50.00");
  });

  it("refunds and subscriptions", () => {
    const base = { amountMinor: 2500, currency: "eur", description: null };
    expect(stripeAttempt({ ...base, kind: "refund", status: "succeeded", detail: { reason: "requested_by_customer" } })).toEqual({
      step: "refund",
      text: "Refund: €25.00 · requested by customer",
    });
    expect(stripeAttempt({ ...base, kind: "refund", status: "failed", detail: { reason: null } }).step).toBe("refund_failed");
    const sub = { ...base, kind: "subscription", status: "active", detail: { interval: "month" } };
    expect(stripeAttempt(sub)).toEqual({ step: "subscription_started", text: "Subscription started: €25.00 / month" });
    expect(subscriptionAttempt(sub, true).step).toBe("subscription_canceled");
  });

  it("formats each currency in its own unit", () => {
    expect(formatMoney(500, "jpy")).toBe("¥500");
    expect(formatMoney(null, "usd")).toBeNull();
  });
});
