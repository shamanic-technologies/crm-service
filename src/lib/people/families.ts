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
 * the same form as a person's `emails`), AND on the fleet-wide `humanId` when
 * features serves one (HOT-INBOUND-UNANSWERED-1016: Hot also holds everyone
 * lead-service tags lead + wants business, any channel, and a WhatsApp writer
 * often has no email: matched on the email alone they never showed under Hot).
 * A person holding several addresses
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
  /** Null for a person Hot by lead-service's tags who is no campaign lead. */
  leadId: string | null;
}

export interface FamilyIndex {
  /** email (lower-cased) → its lead's family. */
  byEmail: Map<string, FamilyVerdict>;
  /** humanId → the strongest family features served for that human. */
  byHuman: Map<string, FamilyVerdict>;
}

export interface BrandFamilies extends FamilyIndex {
  /** features-service's own counts over ALL the brand's leads (not only the Unibox people). */
  producerCounts: Record<LeadFamily, number>;
  readAt: string;
}

interface LeadFamiliesBody {
  counts: Record<LeadFamily, number>;
  people: { leadId: string | null; email: string | null; humanId?: string | null; family: LeadFamily; lostReason: LostReason | null }[];
}

function keepStrongest(map: Map<string, FamilyVerdict>, key: string, v: FamilyVerdict): void {
  const current = map.get(key);
  if (!current || RANK[v.family] < RANK[current.family]) map.set(key, v);
}

/** PURE: the response body → the email + human indexes. An unknown family fails loud. */
export function indexFamilies(body: LeadFamiliesBody): FamilyIndex {
  if (!body || !Array.isArray(body.people)) {
    throw new Error("features-service lead-families answered without a people list");
  }
  const byEmail = new Map<string, FamilyVerdict>();
  const byHuman = new Map<string, FamilyVerdict>();
  for (const p of body.people) {
    if (!(LEAD_FAMILIES as readonly string[]).includes(p.family)) {
      throw new Error(`features-service lead-families served an unknown family "${p.family}"`);
    }
    const verdict: FamilyVerdict = { family: p.family, lostReason: p.lostReason ?? null, leadId: p.leadId ?? null };
    if (p.email) keepStrongest(byEmail, p.email.trim().toLowerCase(), verdict);
    if (p.humanId) keepStrongest(byHuman, p.humanId, verdict);
  }
  return { byEmail, byHuman };
}

/** PURE: a person's family = the strongest family among their addresses and their human, else null. */
export function familyOf(emails: readonly string[], humanId: string | null, index: FamilyIndex): FamilyVerdict | null {
  const candidates = [...emails.map((e) => index.byEmail.get(e.toLowerCase())), humanId ? index.byHuman.get(humanId) : undefined];
  let best: FamilyVerdict | null = null;
  for (const v of candidates) {
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
      ...indexFamilies(body),
      producerCounts: body.counts,
      readAt: new Date().toISOString(),
    })),
  );
}

/** Test seam: forget every cached read. */
export function clearFamiliesCache(): void {
  cache.clear();
}
