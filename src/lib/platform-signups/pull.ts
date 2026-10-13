/**
 * THE PLATFORM SIGNUP FEED (owner 2026-10-13, LEAD-REFONTE-1013): every real
 * signup to distribute.you is a fact client-service states, and our own sales
 * funnel copies it from there, not from a scrape of Clerk.
 *
 * client-service owns the account (org, users, signup) and serves an
 * append-only, `seq`-ordered feed (`GET /internal/signup-facts?since=&limit=`):
 * `signup` facts (the person who created / claimed the org) and `withdrawn`
 * corrections (`withdrawnOf`), each naming the brand it is about. It never
 * calls us: this module PULLS it, every `PLATFORM_SIGNUP_PULL_INTERVAL_MS`
 * (60s, first pass 60s after boot), into bronze `platform_signup_facts`.
 *
 *  - The cursor is the largest `seq` stored: nothing else to keep in sync, and
 *    a page pulled twice stores nothing twice (keyed on client-service's id).
 *  - Each row is filed under the staff org (`COPILOT_UNIBOX_ORG_ID`, where our
 *    own brand's people live) and the brand the fact names. The brand id alone
 *    is shared with test orgs, so the org is never read off the fact.
 *  - New rows kick the people build of that (org, brand): the build's fact
 *    emission turns each `signup` into a people fact (`people/facts.ts`
 *    `platformSignupCandidates`) and each `withdrawn` into our own correction.
 *
 * The reads are attributed to the staff scope's latest build run (as the
 * freshness watch does): no run is opened per pass, nothing is billed.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { peopleScopes, platformSignupFacts } from "../../db/schema.js";
import { copilotDestination } from "../copilot/messages.js";
import { runScopeBuild } from "../people/build.js";
import { siblingGetOk } from "../people/siblings.js";

export const PLATFORM_SIGNUP_PULL_INTERVAL_MS = Number(process.env.PLATFORM_SIGNUP_PULL_INTERVAL_MS) || 60_000;
const PAGE_LIMIT = 500;
/** One pass stops after this many pages; the next pass resumes from the cursor. */
const MAX_PAGES = 50;

/** client-service's fact, as served. Unknown keys are kept verbatim in the payload. */
export const signupFactSchema = z
  .object({
    factId: z.string().min(1),
    seq: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(Number),
    type: z.enum(["signup", "withdrawn"]),
    brandId: z.string().uuid(),
    customerOrgId: z.string().nullable(),
    clerkOrgId: z.string().nullable(),
    userId: z.string().nullable(),
    clerkUserId: z.string().nullable(),
    email: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    fullName: z.string().nullable(),
    phone: z.string().nullable(),
    occurredAt: z.string().nullable(),
    dateBasis: z.string().nullable(),
    withdrawnOf: z.string().nullable(),
    withdrawnReason: z.string().nullable(),
    recordedAt: z.string().nullable(),
  })
  .passthrough();
export type PlatformSignupFactBody = z.infer<typeof signupFactSchema>;

const pageSchema = z.object({
  facts: z.array(z.unknown()),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});

export interface PlatformSignupPullResult {
  status: "ok" | "not_configured";
  reason?: string;
  pages: number;
  pulled: number;
  stored: number;
  cursor: number;
  brands: string[];
}

/** The largest `seq` already copied (0 = nothing yet: the first pass is the backfill). */
export async function platformSignupCursor(): Promise<number> {
  const [r] = (await db.execute(sql`SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM platform_signup_facts`)) as unknown as {
    seq: string | number;
  }[];
  return Number(r.seq);
}

let running = false;

/**
 * One pull: every page after the cursor, stored verbatim. A malformed fact or a
 * failed read throws (nothing after it is stored, the cursor does not move):
 * the next pass asks again from the same place.
 */
export async function pullPlatformSignupFacts(): Promise<PlatformSignupPullResult> {
  const dest = copilotDestination();
  const empty = { pages: 0, pulled: 0, stored: 0, cursor: 0, brands: [] as string[] };
  if (!dest) return { status: "not_configured", reason: "COPILOT_UNIBOX_ORG_ID / COPILOT_UNIBOX_BRAND_ID unset", ...empty };
  if (!process.env.CLIENT_SERVICE_URL || !process.env.CLIENT_SERVICE_API_KEY) {
    return { status: "not_configured", reason: "CLIENT_SERVICE_URL / CLIENT_SERVICE_API_KEY unset", ...empty };
  }
  // The read is attributed to the staff org's latest people build.
  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, dest.orgId), isNotNull(peopleScopes.lastRunId)))
    .orderBy(desc(peopleScopes.lastBuiltAt))
    .limit(1);
  if (!scope) return { status: "not_configured", reason: "the staff org has no people scope built yet", ...empty };
  const identity = { orgId: dest.orgId, userId: scope.createdByUserId, runId: scope.lastRunId!, brandId: scope.brandId };

  let cursor = await platformSignupCursor();
  const result: PlatformSignupPullResult = { status: "ok", ...empty, cursor };
  const brands = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = pageSchema.parse(
      await siblingGetOk("client", `/internal/signup-facts?since=${cursor}&limit=${PAGE_LIMIT}`, identity),
    );
    result.pages++;
    const facts = body.facts.map((f) => signupFactSchema.parse(f));
    result.pulled += facts.length;
    if (facts.length > 0) {
      const inserted = await db
        .insert(platformSignupFacts)
        .values(
          facts.map((f) => ({
            factId: f.factId,
            seq: f.seq,
            orgId: dest.orgId,
            brandId: f.brandId,
            type: f.type,
            withdrawnOf: f.withdrawnOf,
            payload: f as Record<string, unknown>,
          })),
        )
        .onConflictDoNothing({ target: platformSignupFacts.factId })
        .returning({ brandId: platformSignupFacts.brandId });
      result.stored += inserted.length;
      for (const r of inserted) brands.add(r.brandId);
    }
    const next = Number(body.nextCursor);
    if (!Number.isFinite(next)) throw new Error(`client-service signup-facts answered a non-numeric nextCursor: ${body.nextCursor}`);
    cursor = Math.max(cursor, next);
    if (!body.hasMore) break;
  }
  result.cursor = cursor;
  result.brands = [...brands].sort();
  return result;
}

/** Rebuild the people of every (staff org, brand) a pull brought new facts for, unawaited. */
async function kickBuilds(orgId: string, brandIds: string[]): Promise<void> {
  if (brandIds.length === 0) return;
  const scopes = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), inArray(peopleScopes.brandId, brandIds)));
  for (const scope of scopes) {
    runScopeBuild(scope).catch((e) => console.error(`[crm-service] platform signups: build kick failed scope=${scope.id}:`, e));
  }
}

/** One pass, never overlapping the last; new facts kick the brand's people build. */
export async function runPlatformSignupPass(): Promise<PlatformSignupPullResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await pullPlatformSignupFacts();
    if (result.stored > 0) {
      console.log(`[crm-service] platform signups: stored ${result.stored} fact(s), cursor=${result.cursor}, brands=${result.brands.join(",")}`);
      await kickBuilds(copilotDestination()!.orgId, result.brands);
    }
    return result;
  } finally {
    running = false;
  }
}

let warned = false;

/** Started after migrations: first pass a minute after boot, then every minute. */
export function startPlatformSignupPull(): void {
  const tick = () => {
    runPlatformSignupPass()
      .then((r) => {
        if (r?.status === "not_configured" && !warned) {
          warned = true;
          console.warn(`[crm-service] platform signups: not pulled (${r.reason})`);
        }
      })
      .catch((e) => console.error("[crm-service] platform signups: pull failed:", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, PLATFORM_SIGNUP_PULL_INTERVAL_MS).unref();
  }, 60_000).unref();
}
