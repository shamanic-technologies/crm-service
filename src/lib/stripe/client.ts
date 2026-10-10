/**
 * Stripe client — READ ONLY, restricted keys only.
 *
 * Only GETs, by design: a brand's Stripe account is read, never edited. Do not
 * add a write.
 *
 * Stripe offers RESTRICTED keys (`rk_live_…` / `rk_test_…`) whose permissions
 * are chosen per resource, so a read-only key exists and is the only kind this
 * service accepts. A secret key (`sk_…`) can move money; it is refused before
 * any call is made. The publishable key (`pk_…`) cannot read anything.
 */

export const STRIPE_API_BASE_URL = "https://api.stripe.com";
const REQUEST_TIMEOUT_MS = Number(process.env.STRIPE_TIMEOUT_MS) || 30_000;
export const STRIPE_PAGE_SIZE = 100;
/** Hard ceiling on pages drained per resource in one pass — the cron re-runs. */
export const STRIPE_MAX_PAGES = Number(process.env.STRIPE_MAX_PAGES) || 200;

/** The resources the sync reads, and the restricted-key permission each needs. */
export const STRIPE_RESOURCES = {
  customer: { path: "/v1/customers", params: {} as Record<string, string> },
  charge: { path: "/v1/charges", params: {} as Record<string, string> },
  refund: { path: "/v1/refunds", params: {} as Record<string, string> },
  subscription: { path: "/v1/subscriptions", params: { status: "all" } as Record<string, string> },
} as const;
export type StripeKind = keyof typeof STRIPE_RESOURCES;
export const STRIPE_KINDS = Object.keys(STRIPE_RESOURCES) as StripeKind[];

/** A non-2xx answer from Stripe, carrying Stripe's own status and message. */
export class StripeError extends Error {
  readonly status: number;
  readonly vendorMessage: string;
  readonly path: string;
  constructor(status: number, vendorMessage: string, path: string) {
    super(`Stripe GET ${path} returned ${status}: ${vendorMessage}`);
    this.name = "StripeError";
    this.status = status;
    this.vendorMessage = vendorMessage;
    this.path = path;
  }
}

/**
 * `live` | `test` for a restricted key; null for anything that is not one. The
 * prefix is Stripe's own, documented, and is the only thing that says whether a
 * key can be read-only at all.
 */
export function restrictedKeyMode(key: string): "live" | "test" | null {
  if (key.startsWith("rk_live_")) return "live";
  if (key.startsWith("rk_test_")) return "test";
  return null;
}

function readVendorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const raw = parsed.error?.message;
    if (typeof raw === "string" && raw.trim()) return raw;
  } catch {
    // Not JSON — the raw body is still Stripe's own words.
  }
  return body.trim() || "(no message)";
}

export interface StripeObject {
  id: string;
  [key: string]: unknown;
}

async function stripeGet(key: string, path: string, params: Record<string, string>) {
  const url = `${STRIPE_API_BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new StripeError(res.status, readVendorMessage(text), path);
    return JSON.parse(text) as { data: StripeObject[]; has_more: boolean };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][stripe] GET ${path} aborted after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove the key can read every resource the sync reads: one `limit=1` list of
 * each. A key missing a permission is refused by Stripe naming the permission
 * it lacks — that message is what tells the customer what to tick.
 */
export async function verifyStripeAccess(key: string): Promise<Record<StripeKind, string[]>> {
  const seen = {} as Record<StripeKind, string[]>;
  for (const kind of STRIPE_KINDS) {
    const r = STRIPE_RESOURCES[kind];
    const body = await stripeGet(key, r.path, { ...r.params, limit: "1" });
    // The newest object of each kind: what tells two keys of ONE account apart from two accounts.
    seen[kind] = body.data.map((o) => o.id);
  }
  return seen;
}

export interface StripeAccountIdentity {
  id: string;
  name: string | null;
}

/**
 * Which Stripe account the key reads, in Stripe's words (`GET /v1/account`):
 * its id and the name its owner gave it. A restricted key may lack the
 * permission to read the account; Stripe then refuses (401/403) and the
 * identity is unknown (null), which is not a reason to refuse the connection.
 * Any other failure is thrown.
 */
export async function readStripeAccount(key: string): Promise<StripeAccountIdentity | null> {
  let body: Record<string, unknown>;
  try {
    body = (await stripeGet(key, "/v1/account", {})) as unknown as Record<string, unknown>;
  } catch (err) {
    if (err instanceof StripeError && (err.status === 401 || err.status === 403)) return null;
    throw err;
  }
  if (typeof body.id !== "string") return null;
  const settings = body.settings as { dashboard?: { display_name?: unknown } } | undefined;
  const profile = body.business_profile as { name?: unknown } | undefined;
  const name =
    (typeof settings?.dashboard?.display_name === "string" && settings.dashboard.display_name) ||
    (typeof profile?.name === "string" && profile.name) ||
    null;
  return { id: body.id, name };
}

/** Every object of a kind, newest first, optionally only those created since `since`. */
export async function* listStripe(key: string, kind: StripeKind, since: Date | null): AsyncGenerator<StripeObject[]> {
  const r = STRIPE_RESOURCES[kind];
  let startingAfter: string | null = null;
  for (let page = 0; page < STRIPE_MAX_PAGES; page++) {
    const params: Record<string, string> = { ...r.params, limit: String(STRIPE_PAGE_SIZE) };
    if (since) params["created[gte]"] = String(Math.floor(since.getTime() / 1000));
    if (startingAfter) params.starting_after = startingAfter;
    const body = await stripeGet(key, r.path, params);
    if (body.data.length > 0) yield body.data;
    if (!body.has_more || body.data.length === 0) return;
    startingAfter = body.data[body.data.length - 1].id;
  }
}
