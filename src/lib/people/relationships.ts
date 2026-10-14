/**
 * Who a person is to the brand (RELATIONSHIP-TAGS-1014): lead-service's
 * relationship tags, read verbatim, never graded here.
 *
 * lead-service owns the tags (`personal` at org x human, the 8 others at
 * org x brand x lead) and serves them per human at
 * `POST /internal/brands/{brandId}/relationships/query {humanIds}` (1..1000).
 * crm-service only relays the block onto each Unibox row and asks it before a
 * `business_only` serve. A human never judged comes back `judgedAt: null`.
 *
 * A failed read is never "nobody is tagged": the caller gets the error and
 * states it (the list says `relationships.status = failed`, a serve under
 * `business_only` refuses with a 502 rather than hand out an unchecked person).
 */
import { mapLimit, siblingQuery, type SiblingIdentity } from "./siblings.js";

export const RELATIONSHIP_TAGS = [
  "personal",
  "customer",
  "prospect",
  "team",
  "investor",
  "advisor",
  "supplier",
  "partner",
  "other_professional",
] as const;
export type RelationshipTag = (typeof RELATIONSHIP_TAGS)[number];

export interface Relationship {
  humanId: string | null;
  company: { id: string | null; name: string | null; domain: string | null; source: string } | null;
  tags: RelationshipTag[];
  unsureTags: RelationshipTag[];
  judgedAt: string | null;
  details: Record<string, unknown>[];
  /** lead-service's own decision per pipe policy (the ONE place the rule lives): `business_only` = may a business pipe write to them. */
  policies?: { business_only?: boolean };
}

/** The ONLY values a serve accepts (owner decision 6): a person a business pipe may write to. */
export const RELATIONSHIP_POLICIES = ["business_only"] as const;
export type RelationshipPolicy = (typeof RELATIONSHIP_POLICIES)[number];

/** Tags a `business_only` pipe never writes to (owner, LOCKED): only used to NAME a refusal. */
const NOT_BUSINESS_TAGS: ReadonlySet<string> = new Set(["personal", "investor", "supplier", "team", "partner", "advisor"]);

/**
 * PURE: may a `business_only` pipe hand this person out? lead-service decides
 * (`policies.business_only`, the ONE place the rule lives: never judged, or any
 * of personal / investor / supplier / team / partner / advisor yes or unsure =
 * false); never re-derived here. No human, or no stated policy = no. The reason
 * only labels the refusal for the serve summary.
 */
export function businessOnlyVerdict(r: Relationship | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!r) return { ok: false, reason: "no_human" };
  if (r.policies?.business_only === true) return { ok: true };
  if (!r.judgedAt) return { ok: false, reason: "never_judged" };
  if (typeof r.policies?.business_only !== "boolean") return { ok: false, reason: "policy_not_stated" };
  const hit = [...r.tags, ...r.unsureTags].find((t) => NOT_BUSINESS_TAGS.has(t));
  return { ok: false, reason: hit ? `tagged_${hit}` : "not_business" };
}

const BATCH = 1000;
const CONCURRENCY = 4;

function parse(body: unknown): Relationship[] {
  const list = (body as { relationships?: unknown } | null)?.relationships;
  if (!Array.isArray(list)) throw new Error("lead-service relationships query answered without a relationships list");
  return list.map((raw) => {
    const r = raw as Relationship;
    if (typeof r?.humanId !== "string" || !Array.isArray(r.tags) || !Array.isArray(r.unsureTags) || !("judgedAt" in r)) {
      throw new Error(`lead-service relationships query served a malformed relationship: ${JSON.stringify(raw).slice(0, 200)}`);
    }
    return r;
  });
}

/** Every given human's relationship to the brand, in batches of 1000. Throws on any failed batch. */
export async function queryRelationships(identity: SiblingIdentity, humanIds: string[]): Promise<Map<string, Relationship>> {
  const ids = [...new Set(humanIds)].sort();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  const path = `/internal/brands/${encodeURIComponent(identity.brandId)}/relationships/query`;
  const answers = await mapLimit(batches, CONCURRENCY, (b) => siblingQuery<unknown>("lead", path, identity, { humanIds: b }).then(parse));
  const out = new Map<string, Relationship>();
  for (const list of answers) for (const r of list) out.set(r.humanId!, r);
  return out;
}

/** How long one answer serves the brand's lists (the tags move when lead-service re-judges a thread). */
export const RELATIONSHIPS_TTL_MS = Number(process.env.PEOPLE_RELATIONSHIPS_TTL_MS) || 60_000;

const cache = new Map<string, { at: number; byHuman: Map<string, Relationship> }>();

/**
 * The relationships of `humanIds`, re-using an answer younger than the TTL per
 * (org, brand, human). Only the missing / stale humans are asked.
 */
export async function readRelationships(identity: SiblingIdentity, humanIds: string[]): Promise<Map<string, Relationship>> {
  const key = `${identity.orgId}:${identity.brandId}`;
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || now - entry.at >= RELATIONSHIPS_TTL_MS) {
    entry = { at: now, byHuman: new Map() };
    cache.set(key, entry);
  }
  const missing = [...new Set(humanIds)].filter((h) => !entry!.byHuman.has(h));
  if (missing.length) {
    const got = await queryRelationships(identity, missing);
    for (const [h, r] of got) entry.byHuman.set(h, r);
  }
  const out = new Map<string, Relationship>();
  for (const h of humanIds) {
    const r = entry.byHuman.get(h);
    if (r) out.set(h, r);
  }
  return out;
}

/** Test seam: forget every cached answer. */
export function clearRelationshipsCache(): void {
  cache.clear();
}
