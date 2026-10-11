/**
 * Outcomes — per brand, how many distinct PEOPLE reached each outcome step, from
 * ANY source crm-service mirrors (PostHog, Clerk, Stripe, GoHighLevel), and who.
 *
 * lead-service's buckets answer the same steps for the leads OUR campaigns
 * contacted only, by design. This read answers them for everyone the brand's own
 * tools know, and tags who we contacted, so the dashboard keys one vocabulary.
 *
 * The evidence is the people fact feed itself (`people_facts`, live rows): the
 * same facts lead-service reads, so the two can never disagree on what happened.
 * A person is the fact's CURRENT owner (`owner_person_key`, re-owned after every
 * build on merge/split), so a person stated twice (a Clerk signup AND a PostHog
 * signup of the same human) counts once. Withdrawn facts are not live and count
 * for nothing. Anonymous visitors never reach the feed (people only).
 *
 * Step tokens are lead-service's bucket tokens (`lead-buckets.ts`), crm fact types
 * mapped onto them:
 *   website_visit   ← website_visit
 *   signup          ← signup
 *   form_submission ← form_submitted
 *   meeting_booked  ← meeting_booked
 *   meeting_attended← meeting_attended
 *   sale            ← sale (a CRM deal won) | payment that STANDS (succeeded and
 *                     not wholly refunded — lead-service's own `paymentStands`)
 *
 * Pure SQL over our own table: no model, no metered call, no cost.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";

export const OUTCOME_STEPS = [
  "website_visit",
  "signup",
  "form_submission",
  "meeting_booked",
  "meeting_attended",
  "sale",
] as const;
export type OutcomeStep = (typeof OUTCOME_STEPS)[number];

/** Which crm fact types state each step. */
export const STEP_FACT_TYPES: Record<OutcomeStep, readonly string[]> = {
  website_visit: ["website_visit"],
  signup: ["signup"],
  form_submission: ["form_submitted"],
  meeting_booked: ["meeting_booked"],
  meeting_attended: ["meeting_attended"],
  sale: ["sale", "payment"],
};

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/**
 * The live step evidence of one brand: one row per fact, its step and its owner.
 * A payment counts only when it stands: status `succeeded` AND net of refunds > 0
 * (no amount → stands unless flagged refunded). Same rule as lead-service.
 */
function evidence(orgId: string, brandId: string, step: OutcomeStep | null): SQL {
  const steps = step ? [step] : [...OUTCOME_STEPS];
  const types = [...new Set(steps.flatMap((s) => STEP_FACT_TYPES[s]))];
  return sql`
    SELECT f.owner_person_key AS person_key,
           CASE f.type WHEN 'form_submitted' THEN 'form_submission'
                       WHEN 'payment' THEN 'sale'
                       ELSE f.type END AS step,
           f.source, f.occurred_at, f.feed_seq, f.emails, f.full_name
    FROM people_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.live AND f.owner_person_key IS NOT NULL
      AND f.type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
      AND (f.type <> 'payment' OR (
        f.payload->>'status' = 'succeeded'
        AND CASE WHEN jsonb_typeof(f.payload->'amountMinor') = 'number'
                 THEN (f.payload->>'amountMinor')::numeric
                      - COALESCE(CASE WHEN jsonb_typeof(f.payload->'amountRefunded') = 'number'
                                      THEN (f.payload->>'amountRefunded')::numeric END, 0) > 0
                 ELSE COALESCE(f.payload->>'refunded', 'false') <> 'true' END
      ))
  `;
}

/**
 * "We contacted them": our cold email wrote to them (an Instantly presence = at
 * least one real send) or lead-service holds them as one of our leads.
 */
const CONTACTED = sql`(p.sources @> '["instantly"]'::jsonb OR p.state_source = 'lead_service')`;

export interface OutcomeStepCount {
  step: OutcomeStep;
  /** Distinct people who reached the step, any source, one person once. */
  people: number;
  /** Distinct people per source stating the step. Overlaps: the same person on two sources counts in both. */
  sources: { source: string; people: number }[];
  /** Of `people`, those our campaigns contacted. */
  contactedByUs: number;
}

export async function readOutcomeCounts(orgId: string, brandId: string): Promise<OutcomeStepCount[]> {
  const ev = evidence(orgId, brandId, null);
  const [totals, bySource] = await Promise.all([
    rows<{ step: OutcomeStep; people: number; contacted: number }>(sql`
      WITH e AS (${ev}), r AS (SELECT DISTINCT step, person_key FROM e)
      SELECT r.step, count(*)::int AS people,
             count(*) FILTER (WHERE ${CONTACTED})::int AS contacted
      FROM r LEFT JOIN people p ON p.org_id = ${orgId} AND p.brand_id = ${brandId} AND p.person_key = r.person_key
      GROUP BY r.step
    `),
    rows<{ step: OutcomeStep; source: string; people: number }>(sql`
      WITH e AS (${ev})
      SELECT step, source, count(DISTINCT person_key)::int AS people
      FROM e GROUP BY step, source ORDER BY step, people DESC, source
    `),
  ]);
  return OUTCOME_STEPS.map((step) => {
    const t = totals.find((x) => x.step === step);
    return {
      step,
      people: t?.people ?? 0,
      sources: bySource.filter((s) => s.step === step).map((s) => ({ source: s.source, people: s.people })),
      contactedByUs: t?.contacted ?? 0,
    };
  });
}

export interface OutcomePerson {
  /** Null only when the person has left the people index since the fact was owned (identity then comes off the fact). */
  personId: string | null;
  personKey: string;
  displayName: string | null;
  company: string | null;
  emails: string[];
  phones: string[];
  /** The earliest dated statement of the step; null when no source dated it. */
  reachedAt: string | null;
  /** Every source stating the step for this person, with its own earliest date. */
  sources: { source: string; reachedAt: string | null }[];
  contactedByUs: boolean;
  state: string | null;
  stateSource: string | null;
}

/**
 * The people who reached one step, earliest first (undated last), total order on
 * person key. Pages to exactly the `people` count of `readOutcomeCounts`.
 */
export async function readOutcomePeople(
  orgId: string,
  brandId: string,
  step: OutcomeStep,
  limit: number,
  offset: number,
): Promise<{ total: number; people: OutcomePerson[] }> {
  const ev = evidence(orgId, brandId, step);
  const list = await rows<{
    person_key: string;
    person_id: string | null;
    display_name: string | null;
    company: string | null;
    emails: string[] | null;
    phones: string[] | null;
    fact_emails: string[] | null;
    fact_name: string | null;
    reached_at: string | Date | null;
    sources: { source: string; reachedAt: string | null }[];
    contacted: boolean;
    state: string | null;
    state_source: string | null;
    total: number;
  }>(sql`
    WITH e AS (${ev}),
    s AS (
      SELECT person_key, source, min(occurred_at) AS reached_at FROM e GROUP BY person_key, source
    ),
    who AS (
      SELECT person_key, min(reached_at) AS reached_at,
             jsonb_agg(jsonb_build_object('source', source, 'reachedAt', reached_at)
                       ORDER BY reached_at ASC NULLS LAST, source) AS sources
      FROM s GROUP BY person_key
    ),
    latest AS (
      SELECT DISTINCT ON (person_key) person_key, emails AS fact_emails, full_name AS fact_name
      FROM e ORDER BY person_key, feed_seq DESC
    )
    SELECT w.person_key, p.person_id, p.display_name, p.company, p.emails, p.phones,
           l.fact_emails, l.fact_name, w.reached_at, w.sources,
           COALESCE(${CONTACTED}, false) AS contacted, p.state, p.state_source,
           count(*) OVER ()::int AS total
    FROM who w
    JOIN latest l ON l.person_key = w.person_key
    LEFT JOIN people p ON p.org_id = ${orgId} AND p.brand_id = ${brandId} AND p.person_key = w.person_key
    ORDER BY w.reached_at ASC NULLS LAST, w.person_key
    LIMIT ${limit} OFFSET ${offset}
  `);
  // An offset past the end returns no row to carry the window count: count apart.
  const total =
    list.length > 0
      ? list[0].total
      : (await rows<{ n: number }>(sql`WITH e AS (${ev}) SELECT count(DISTINCT person_key)::int AS n FROM e`))[0].n;
  return {
    total,
    people: list.map((r) => ({
      personId: r.person_id,
      personKey: r.person_key,
      displayName: r.display_name ?? r.fact_name,
      company: r.company,
      emails: r.emails ?? r.fact_emails ?? [],
      phones: r.phones ?? [],
      reachedAt: r.reached_at === null ? null : new Date(r.reached_at).toISOString(),
      sources: r.sources.map((s) => ({ source: s.source, reachedAt: s.reachedAt === null ? null : new Date(s.reachedAt).toISOString() })),
      contactedByUs: r.contacted,
      state: r.state,
      stateSource: r.state_source,
    })),
  };
}
