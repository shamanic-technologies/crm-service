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
 *
 * Organization memberships (`/organization_memberships`, every org of the
 * instance, each carrying its organization's `created_by`) are listed the same
 * way: they tell a teammate invited into someone else's organization from a
 * signup (`isSignup`). Measured on distribute.you 2026-10-13: 176 memberships,
 * 118 organizations, in one page.
 */

import {
  AuthProviderError,
  type AuthProviderAdapter,
  type DerivedAuthMembership,
  type DerivedAuthUser,
} from "./provider.js";

export const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.CLERK_TIMEOUT_MS) || 30_000;
export const CLERK_PAGE_SIZE = 500;
/** Hard ceiling on pages per pass (100k users) — the cron re-runs. */
export const CLERK_MAX_PAGES = Number(process.env.CLERK_MAX_PAGES) || 200;

/** The phone watch's recent-changes read: pages of 100, at most 5 (500 changed users a minute). */
const CLERK_UPDATED_PAGE_SIZE = 100;
const CLERK_UPDATED_MAX_PAGES = 5;

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

/**
 * A phone the brand's product stored on the user's profile itself: a product
 * asking for a phone at onboarding often keeps it in Clerk metadata rather than
 * as a Clerk phone number (distribute.you does: `public_metadata.phone`, 12 of
 * 96 users vs 0 Clerk phone numbers, 2026-10-12). Read under the keys a product
 * names a phone (`phone`, `phoneNumber`, `phone_number`), in `public_metadata`
 * then `unsafe_metadata`; `private_metadata` is never stored, so never read.
 * The user typed it: it is their own statement, tagged with where it was read.
 */
const METADATA_FIELDS = ["public_metadata", "unsafe_metadata"] as const;
const METADATA_PHONE_KEYS = ["phone", "phoneNumber", "phone_number"] as const;

function metadataPhones(record: Record<string, unknown>): { phone: string; via: string }[] {
  const out: { phone: string; via: string }[] = [];
  for (const field of METADATA_FIELDS) {
    const meta = record[field];
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    for (const key of METADATA_PHONE_KEYS) {
      const value = str((meta as Record<string, unknown>)[key]);
      if (value) out.push({ phone: value, via: `clerk_${field}.${key}` });
    }
  }
  return out;
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
    ...phonesOf(record),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ") || null,
    createdAt: msDate(record.created_at),
    updatedAt: msDate(record.updated_at),
    lastActiveAt: lastActive.length ? new Date(Math.max(...lastActive.map((d) => d.getTime()))) : null,
  };
}

/** Clerk's own (verified) phone numbers first, then the profile's metadata phones; each tagged. */
function phonesOf(record: Record<string, unknown>): Pick<DerivedAuthUser, "phones" | "phoneSources"> {
  const sources = [
    ...ownedValues(record.phone_numbers, "phone_number", record.primary_phone_number_id).map((phone) => ({
      phone,
      via: "clerk_phone_number",
    })),
    ...metadataPhones(record),
  ];
  const seen = new Set<string>();
  const phoneSources = sources.filter((s) => {
    const k = s.phone.replace(/\D/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { phones: phoneSources.map((s) => s.phone), phoneSources };
}

/** Drop the server-only fields, on the membership AND on the organization it carries. */
function stripMembership(m: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...m };
  for (const f of NEVER_STORED) delete copy[f];
  if (copy.organization && typeof copy.organization === "object") {
    const org = { ...(copy.organization as Record<string, unknown>) };
    for (const f of NEVER_STORED) delete org[f];
    copy.organization = org;
  }
  return copy;
}

export function deriveClerkMembership(record: Record<string, unknown>): DerivedAuthMembership | null {
  const externalId = str(record.id);
  const org = record.organization as Record<string, unknown> | undefined;
  const user = record.public_user_data as Record<string, unknown> | undefined;
  const userId = str(user?.user_id);
  const orgId = str(org?.id);
  if (!externalId || !userId || !orgId) return null;
  return { externalId, userId, orgId, orgCreatedBy: str(org?.created_by), joinedAt: msDate(record.created_at)?.getTime() ?? null };
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
  async listUpdatedSince(key, since) {
    const out: Record<string, unknown>[] = [];
    // Newest change first: stop at the first page reaching past `since` (a few users a minute).
    for (let page = 0; page < CLERK_UPDATED_MAX_PAGES; page++) {
      const body = await clerkGet(key, "/users", {
        limit: String(CLERK_UPDATED_PAGE_SIZE),
        offset: String(page * CLERK_UPDATED_PAGE_SIZE),
        order_by: "-updated_at",
      });
      if (!Array.isArray(body)) throw new Error(`[crm-service][clerk] /users answered a non-array`);
      const users = body as Record<string, unknown>[];
      for (const u of users) {
        if (typeof u.updated_at !== "number" || u.updated_at < since) return out;
        const copy = { ...u };
        for (const f of NEVER_STORED) delete copy[f];
        out.push(copy);
      }
      if (users.length < CLERK_UPDATED_PAGE_SIZE) return out;
    }
    return out;
  },
  idOf: (record) => String(record.id),
  derive: deriveClerkUser,
  memberships: {
    async count(key) {
      const body = (await clerkGet(key, "/organization_memberships", { limit: "1" })) as { total_count?: unknown };
      if (typeof body.total_count !== "number") {
        throw new Error(`[crm-service][clerk] /organization_memberships answered without total_count`);
      }
      return body.total_count;
    },
    async *list(key) {
      for (let page = 0; page < CLERK_MAX_PAGES; page++) {
        const body = (await clerkGet(key, "/organization_memberships", {
          limit: String(CLERK_PAGE_SIZE),
          offset: String(page * CLERK_PAGE_SIZE),
          order_by: "+created_at",
        })) as { data?: unknown };
        if (!Array.isArray(body.data)) throw new Error(`[crm-service][clerk] /organization_memberships answered without data`);
        const rows = (body.data as Record<string, unknown>[]).map(stripMembership);
        if (rows.length > 0) yield rows;
        if (rows.length < CLERK_PAGE_SIZE) return;
      }
    },
    derive: deriveClerkMembership,
  },
};
