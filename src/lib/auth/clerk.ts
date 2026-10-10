/**
 * Clerk adapter — READ ONLY (Backend API, `https://api.clerk.com/v1`).
 *
 * Only GETs, by design: the brand's users are read, never edited. Do not add a
 * write. The key is the instance's SECRET key (`sk_live_…` / `sk_test_…`); Clerk
 * offers no read-only key, which is why it lives in key-service and nowhere
 * else, and why nothing here logs it.
 *
 * Users are listed oldest first (`order_by=+created_at`) in pages of 500 with
 * `offset`: a user signing up during a pass lands at the END of the order, so it
 * never shifts a page not yet read. Clerk API reads are free: no cost declared.
 */

import { AuthProviderError, type AuthProviderAdapter, type DerivedAuthUser } from "./provider.js";

export const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.CLERK_TIMEOUT_MS) || 30_000;
export const CLERK_PAGE_SIZE = 500;
/** Hard ceiling on pages per pass (100k users) — the cron re-runs. */
export const CLERK_MAX_PAGES = Number(process.env.CLERK_MAX_PAGES) || 200;

/** Server-only fields never mirrored: the brand stores its own secrets there. */
const NEVER_STORED = ["private_metadata"] as const;

function readVendorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: { long_message?: unknown; message?: unknown }[] };
    const first = parsed.errors?.[0];
    const raw = first?.long_message ?? first?.message;
    if (typeof raw === "string" && raw.trim()) return raw;
  } catch {
    // Not JSON — the raw body is still Clerk's own words.
  }
  return body.trim() || "(no message)";
}

async function clerkGet(key: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const url = `${CLERK_API_BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new AuthProviderError(`Clerk GET ${path}`, res.status, readVendorMessage(text));
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][clerk] GET ${path} aborted after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Clerk dates are unix milliseconds. */
function msDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value);
}

interface ClerkIdentifier {
  id?: unknown;
  verification?: { status?: unknown } | null;
}

/**
 * An identifier is the user's own when Clerk verified it, or when Clerk states no
 * verification at all (users imported into Clerk carry none). An `unverified`
 * address may be someone else's typo: it never becomes a merge key.
 */
const owned = (i: ClerkIdentifier) => !i.verification || i.verification.status === "verified";

function ownedValues(list: unknown, field: string, primaryId: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const items = (list as (ClerkIdentifier & Record<string, unknown>)[]).filter(owned);
  items.sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId));
  return [...new Set(items.map((i) => str(i[field])).filter((v): v is string => !!v))];
}

export function deriveClerkUser(record: Record<string, unknown>): DerivedAuthUser | null {
  const externalId = str(record.id);
  if (!externalId) return null;
  const firstName = str(record.first_name);
  const lastName = str(record.last_name);
  const lastActive = [msDate(record.last_active_at), msDate(record.last_sign_in_at)].filter((d): d is Date => !!d);
  return {
    externalId,
    emails: ownedValues(record.email_addresses, "email_address", record.primary_email_address_id).map((e) =>
      e.toLowerCase(),
    ),
    phones: ownedValues(record.phone_numbers, "phone_number", record.primary_phone_number_id),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ") || null,
    createdAt: msDate(record.created_at),
    updatedAt: msDate(record.updated_at),
    lastActiveAt: lastActive.length ? new Date(Math.max(...lastActive.map((d) => d.getTime()))) : null,
  };
}

export const clerk: AuthProviderAdapter = {
  name: "clerk",
  label: "Clerk",
  rejectKey(key) {
    if (key.startsWith("pk_")) return "this is Clerk's PUBLISHABLE key; paste the SECRET key (sk_live_… / sk_test_…)";
    if (!key.startsWith("sk_")) return "a Clerk secret key starts with sk_live_ or sk_test_";
    return null;
  },
  async countUsers(key) {
    const body = (await clerkGet(key, "/users/count")) as { total_count?: unknown };
    if (typeof body.total_count !== "number") {
      throw new Error(`[crm-service][clerk] /users/count answered without total_count`);
    }
    return body.total_count;
  },
  async *listUsers(key) {
    for (let page = 0; page < CLERK_MAX_PAGES; page++) {
      const body = await clerkGet(key, "/users", {
        limit: String(CLERK_PAGE_SIZE),
        offset: String(page * CLERK_PAGE_SIZE),
        order_by: "+created_at",
      });
      if (!Array.isArray(body)) throw new Error(`[crm-service][clerk] /users answered a non-array`);
      const users = (body as Record<string, unknown>[]).map((u) => {
        const copy = { ...u };
        for (const f of NEVER_STORED) delete copy[f];
        return copy;
      });
      if (users.length > 0) yield users;
      if (users.length < CLERK_PAGE_SIZE) return;
    }
  },
  idOf: (record) => String(record.id),
  derive: deriveClerkUser,
};
