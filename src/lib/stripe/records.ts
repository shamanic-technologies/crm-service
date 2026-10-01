/**
 * Deriving Stripe silver from bronze — pure, deterministic, zero LLM.
 *
 * Statuses, currencies and amounts are Stripe's own, verbatim: amounts stay in
 * the currency's MINOR unit exactly as Stripe states them (`amount: 9900` is
 * 99.00 USD, `amount: 500` is 500 JPY). Nothing is converted or re-bucketed.
 */

export const STRIPE_SOURCE = "stripe";

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Stripe timestamps are unix seconds. */
function unix(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A field that is either an id or an expanded object carrying one. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return str(value);
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

export interface DerivedStripeCustomer {
  externalId: string;
  primaryEmail: string | null;
  phone: string | null;
  fullName: string | null;
  sourceCreatedAt: Date | null;
}

export function deriveStripeCustomer(payload: Record<string, unknown>): DerivedStripeCustomer | null {
  const externalId = str(payload.id);
  if (!externalId || payload.deleted === true) return null;
  return {
    externalId,
    primaryEmail: str(payload.email)?.toLowerCase() ?? null,
    phone: str(payload.phone),
    fullName: str(payload.name),
    sourceCreatedAt: unix(payload.created),
  };
}

export interface DerivedTransaction {
  kind: "payment" | "refund" | "subscription";
  externalId: string;
  externalCustomerId: string | null;
  occurredAt: Date;
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
  description: string | null;
  detail: Record<string, unknown>;
}

export function deriveCharge(payload: Record<string, unknown>): DerivedTransaction | null {
  const id = str(payload.id);
  const at = unix(payload.created);
  if (!id || !at) return null;
  return {
    kind: "payment",
    externalId: id,
    externalCustomerId: idOf(payload.customer),
    occurredAt: at,
    amountMinor: num(payload.amount),
    currency: str(payload.currency),
    status: str(payload.status),
    description: str(payload.description),
    detail: {
      paid: payload.paid === true,
      refunded: payload.refunded === true,
      amountRefunded: num(payload.amount_refunded),
      disputed: payload.disputed === true,
      invoice: idOf(payload.invoice),
      paymentIntent: idOf(payload.payment_intent),
      failureMessage: str(payload.failure_message),
      livemode: payload.livemode === true,
    },
  };
}

/** A refund names its charge, not its customer: the charge's customer is passed in. */
export function deriveRefund(
  payload: Record<string, unknown>,
  customerOfCharge: (chargeId: string) => string | null,
): DerivedTransaction | null {
  const id = str(payload.id);
  const at = unix(payload.created);
  if (!id || !at) return null;
  const charge = idOf(payload.charge);
  return {
    kind: "refund",
    externalId: id,
    externalCustomerId: charge ? customerOfCharge(charge) : null,
    occurredAt: at,
    amountMinor: num(payload.amount),
    currency: str(payload.currency),
    status: str(payload.status),
    description: str(payload.reason),
    detail: { charge, reason: str(payload.reason) },
  };
}

interface SubscriptionItem {
  price?: {
    id?: string;
    unit_amount?: number | null;
    currency?: string;
    product?: unknown;
    recurring?: { interval?: string; interval_count?: number } | null;
  };
  quantity?: number;
}

/**
 * A subscription, dated at its start. `amountMinor` is what one period costs at
 * list price (sum of unit amount × quantity over its items) — null when an item
 * has no unit amount (metered / tiered prices), never a guess.
 */
export function deriveSubscription(payload: Record<string, unknown>): DerivedTransaction | null {
  const id = str(payload.id);
  const at = unix(payload.start_date) ?? unix(payload.created);
  if (!id || !at) return null;
  const items = (((payload.items as { data?: unknown[] } | undefined)?.data ?? []) as SubscriptionItem[]).map((i) => ({
    price: i.price?.id ?? null,
    product: idOf(i.price?.product),
    unitAmount: i.price?.unit_amount ?? null,
    quantity: i.quantity ?? 1,
    interval: i.price?.recurring?.interval ?? null,
    intervalCount: i.price?.recurring?.interval_count ?? null,
  }));
  const amountMinor =
    items.length > 0 && items.every((i) => typeof i.unitAmount === "number")
      ? items.reduce((sum, i) => sum + (i.unitAmount as number) * i.quantity, 0)
      : null;
  return {
    kind: "subscription",
    externalId: id,
    externalCustomerId: idOf(payload.customer),
    occurredAt: at,
    amountMinor,
    currency: str(payload.currency),
    status: str(payload.status),
    description: str(payload.description),
    detail: {
      items,
      interval: items[0]?.interval ?? null,
      cancelAtPeriodEnd: payload.cancel_at_period_end === true,
      canceledAt: unix(payload.canceled_at)?.toISOString() ?? null,
      endedAt: unix(payload.ended_at)?.toISOString() ?? null,
      trialEnd: unix(payload.trial_end)?.toISOString() ?? null,
    },
  };
}

/**
 * Stripe's zero-decimal currencies (stripe.com/docs/currencies#zero-decimal):
 * their minor unit IS the major unit. Used only to render a decimal beside the
 * verbatim minor amount.
 */
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

export function majorAmount(amountMinor: number | null, currency: string | null): number | null {
  if (amountMinor === null || !currency) return null;
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? amountMinor : amountMinor / 100;
}
