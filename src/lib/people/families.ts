import { siblingGetOk, type SiblingIdentity } from "./siblings.js";
import { SwrCache } from "./swr.js";

/**
 * The Unibox family filters (owner 2026-10-08): Won clients, Hot leads, Lost
 * leads, Cold leads. A person's FAMILY is features-service's verdict on our
 * lead (`GET /brands/{brandId}/lead-families`), read verbatim and never
 * regraded here:
 *   won  = client won;
 *   hot  = interested, not won yet;
 *   lost = became interested thanks to us then went cold, or ruled out;
 *   cold = contacted by us, never interested.
 * Someone who is not one of our leads has no family (null): listed under All only.
 *
 * Matched on the email address (features serves it trimmed and lower-cased,
 * the same form as a person's `emails`). A person holding several addresses
 * that are each a lead takes the STRONGEST family (won > hot > lost > cold),
 * the very rule features-service applies to one lead across several offers.
 *
 * A failed read is never "nobody has a family": the caller gets the error and
 * states it.
 */

export const LEAD_FAMILIES = ["won", "hot", "lost", "cold"] as const;
export type LeadFamily = (typeof LEAD_FAMILIES)[number];
export type LostReason = "went_cold" | "ruled_out";

const RANK: Record<LeadFamily, number> = { won: 0, hot: 1, lost: 2, cold: 3 };

export interface FamilyVerdict {
  family: LeadFamily;
  lostReason: LostReason | null;
  leadId: string;
}

export interface BrandFamilies {
  /** email (lower-cased) → its lead's family. */
  byEmail: Map<string, FamilyVerdict>;
  /** features-service's own counts over ALL the brand's leads (not only the Unibox people). */
  producerCounts: Record<LeadFamily, number>;
  readAt: string;
}

interface LeadFamiliesBody {
  counts: Record<LeadFamily, number>;
  people: { leadId: string; email: string | null; family: LeadFamily; lostReason: LostReason | null }[];
}

/** PURE: the response body → the email index. An unknown family fails loud. */
export function indexFamilies(body: LeadFamiliesBody): Map<string, FamilyVerdict> {
  if (!body || !Array.isArray(body.people)) {
    throw new Error("features-service lead-families answered without a people list");
  }
  const byEmail = new Map<string, FamilyVerdict>();
  for (const p of body.people) {
    if (!(LEAD_FAMILIES as readonly string[]).includes(p.family)) {
      throw new Error(`features-service lead-families served an unknown family "${p.family}"`);
    }
    if (!p.email) continue;
    const email = p.email.trim().toLowerCase();
    const current = byEmail.get(email);
    if (!current || RANK[p.family] < RANK[current.family]) {
      byEmail.set(email, { family: p.family, lostReason: p.lostReason ?? null, leadId: p.leadId });
    }
  }
  return byEmail;
}

/** PURE: a person's family = the strongest family among their addresses, else null. */
export function familyOf(emails: readonly string[], byEmail: Map<string, FamilyVerdict>): FamilyVerdict | null {
  let best: FamilyVerdict | null = null;
  for (const e of emails) {
    const v = byEmail.get(e.toLowerCase());
    if (v && (!best || RANK[v.family] < RANK[best.family])) best = v;
  }
  return best;
}

/**
 * How long one read serves the brand's lists. The body is ~4 MB for a brand
 * with 18k contacted leads and every keystroke of the search re-lists, so the
 * read is shared; features-service itself refreshes its snapshot every ~30s.
 */
export const FAMILIES_TTL_MS = Number(process.env.PEOPLE_FAMILIES_TTL_MS) || 60_000;

/** Past the TTL and under this age, the cached read is served while ONE re-read runs behind it (DASH-LATENCY-1014). */
export const FAMILIES_MAX_STALE_MS = Number(process.env.PEOPLE_FAMILIES_MAX_STALE_MS) || 2 * FAMILIES_TTL_MS;

const cache = new SwrCache<BrandFamilies>("lead families", () => FAMILIES_TTL_MS, () => FAMILIES_MAX_STALE_MS);

/**
 * One shared, single-flight read per (org, brand); a failed read is not cached. Stale-while-
 * revalidate (swr.ts): a cold features read is ~25 s, so once a brand is warm no Unibox list
 * waits for it again; `readAt` says how old the served verdicts are.
 */
export function readBrandFamilies(identity: SiblingIdentity): Promise<BrandFamilies> {
  const path = `/brands/${encodeURIComponent(identity.brandId)}/lead-families`;
  return cache.get(`${identity.orgId}:${identity.brandId}`, () =>
    siblingGetOk<LeadFamiliesBody>("features", path, identity).then((body) => ({
      byEmail: indexFamilies(body),
      producerCounts: body.counts,
      readAt: new Date().toISOString(),
    })),
  );
}

/** Test seam: forget every cached read. */
export function clearFamiliesCache(): void {
  cache.clear();
}
