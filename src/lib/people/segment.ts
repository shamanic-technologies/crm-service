/**
 * SEGMENT — scope a people-pool serve (and its count) to a part of the brand's
 * own CRM, in the brand's own words (owner 2026-10-12, CRM-SEGMENT-SOURCING-1012:
 * « the warm people of their CRM who never became clients »).
 *
 * A segment narrows the people pool (lib/serve.ts) with what the brand's tools
 * already state about a person. Same words for every brand and every source:
 *
 *  - `dealStages`   the person has a CRM deal CURRENTLY at one of these stages
 *                   (stage name, optionally its pipeline name). Today the deal
 *                   source is GoHighLevel's opportunities; the names are the
 *                   customer's own, matched trimmed and case-insensitive, never
 *                   mapped onto a vocabulary of ours.
 *  - `dealStatuses` the deal's CRM status, verbatim (`open`, `won`, `lost`,
 *                   `abandoned` on GoHighLevel). With `dealStages`, the SAME deal
 *                   must match both; alone, any deal with that status.
 *  - `tags`         the person's CRM contact carries one of these tags.
 *  - `reached`      the person reached one of these funnel steps, any source
 *                   (form submitted, meeting booked / attended / not held,
 *                   signup, website visit, sale): the live fact feed, the same
 *                   evidence as Outcomes and lead-service.
 *  - `notReached`   the person reached none of these steps.
 *
 * Inside a list: any one matches. Across keys: all must match.
 *
 * Always out unless the segment states otherwise:
 *  - clients (`includeClients`): a person who reached `sale` (a CRM deal won, or
 *    a payment that stands), whatever the deal the segment matched;
 *  - opted-out people: handled by the pool itself for every people serve
 *    (lib/serve.ts `PERSON_OPTED_OUT`), `includeOptedOut` lifts it.
 *
 * Pure SQL over our own gold / silver: no model, no vendor call, no cost.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { NOT_CALENDAR_BOOKING_FORM, PAYMENT_STANDS } from "./outcomes.js";

/** Funnel steps a segment can name; tokens = Outcomes' / lead-service's buckets, plus `meeting_not_held`. */
export const SEGMENT_STEPS = [
  "website_visit",
  "signup",
  "form_submission",
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "sale",
  "disqualified",
] as const;
export type SegmentStep = (typeof SEGMENT_STEPS)[number];

/**
 * Which fact types state each step (`form_submission` = fact `form_submitted`, `sale` = sale | standing
 * payment | a CRM stage / tag Jev judged `client`; `disqualified` = a CRM stage / tag Jev judged
 * `disqualified`: lib/gohighlevel/label-verdicts.ts, CRM-WARM-NURTURE-1015).
 */
const STEP_FACTS: Record<SegmentStep, readonly string[]> = {
  website_visit: ["website_visit"],
  signup: ["signup"],
  form_submission: ["form_submitted"],
  meeting_booked: ["meeting_booked"],
  meeting_attended: ["meeting_attended"],
  meeting_not_held: ["meeting_not_held"],
  sale: ["sale", "payment", "client"],
  disqualified: ["disqualified"],
};

const name = z.string().trim().min(1).max(200);

export const segmentSchema = z
  .object({
    dealStages: z
      .array(z.object({ stage: name, pipeline: name.optional() }).strict())
      .min(1)
      .max(50)
      .optional(),
    dealStatuses: z.array(name).min(1).max(10).optional(),
    tags: z.array(name).min(1).max(50).optional(),
    reached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional(),
    notReached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional(),
    includeClients: z.boolean().optional(),
    includeOptedOut: z.boolean().optional(),
  })
  .strict();
export type Segment = z.infer<typeof segmentSchema>;

const lowerTrim = (s: string) => s.trim().toLowerCase();
const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** The person's own CRM contact rows: every presence's record id (`p` = a `people` row). */
const PRESENCE_REFS = sql`(SELECT pr->>'sourceRef' FROM jsonb_array_elements(p.presences) pr)`;

/** People (by person key) who reached any of `steps`, live facts only. */
export function reachedSql(orgId: string, brandId: string, steps: readonly SegmentStep[]): SQL {
  const types = [...new Set(steps.flatMap((s) => STEP_FACTS[s]))];
  return sql`p.person_key IN (
    SELECT f.owner_person_key FROM people_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.live AND f.owner_person_key IS NOT NULL
      AND f.type IN (${list(types)})
      AND ${PAYMENT_STANDS}
      AND ${NOT_CALENDAR_BOOKING_FORM}
  )`;
}

function dealSql(orgId: string, brandId: string, segment: Segment): SQL | null {
  const stages = segment.dealStages ?? [];
  const statuses = (segment.dealStatuses ?? []).map(lowerTrim);
  if (stages.length === 0 && statuses.length === 0) return null;
  const parts: SQL[] = [sql`o.org_id = ${orgId}`, sql`o.brand_id = ${brandId}`, sql`o.contact_id IS NOT NULL`];
  if (stages.length > 0) {
    const one = stages.map((s) =>
      s.pipeline
        ? sql`(lower(btrim(o.stage_name)) = ${lowerTrim(s.stage)} AND lower(btrim(o.pipeline_name)) = ${lowerTrim(s.pipeline)})`
        : sql`lower(btrim(o.stage_name)) = ${lowerTrim(s.stage)}`,
    );
    parts.push(sql`(${sql.join(one, sql` OR `)})`);
  }
  if (statuses.length > 0) parts.push(sql`lower(btrim(o.status)) IN (${list(statuses)})`);
  return sql`EXISTS (SELECT 1 FROM ${PRESENCE_REFS} AS ref(id) WHERE ref.id IN (
    SELECT o.contact_id::text FROM ghl_opportunities o WHERE ${sql.join(parts, sql` AND `)}
  ))`;
}

function tagSql(orgId: string, brandId: string, tags: string[]): SQL {
  return sql`EXISTS (SELECT 1 FROM ${PRESENCE_REFS} AS ref(id) WHERE ref.id IN (
    SELECT c.id::text FROM contacts c, jsonb_array_elements_text(c.tags) AS t(tag)
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND jsonb_typeof(c.tags) = 'array'
      AND lower(btrim(t.tag)) IN (${list(tags.map(lowerTrim))})
  ))`;
}

/** One named predicate of a pool: what a person must satisfy, and the plain words when they do not. */
export interface PoolClause {
  code: string;
  /** Plain English for a staff dashboard: why a person FAILING this clause is out. */
  reason: string;
  sql: SQL;
}

/** The segment's predicates on a `people p` row, each named (empty = no narrowing). */
export function segmentClauses(orgId: string, brandId: string, segment: Segment | undefined): PoolClause[] {
  if (!segment) return [];
  const parts: PoolClause[] = [];
  const deal = dealSql(orgId, brandId, segment);
  if (deal) parts.push({ code: "segment_deal", reason: "No longer has a deal at the CRM stage the audience targets", sql: deal });
  if (segment.tags) parts.push({ code: "segment_tag", reason: "No longer carries the CRM tag the audience targets", sql: tagSql(orgId, brandId, segment.tags) });
  if (segment.reached) parts.push({ code: "segment_reached", reason: "Has not reached the funnel step the audience targets", sql: reachedSql(orgId, brandId, segment.reached) });
  if (segment.notReached) {
    parts.push({ code: "segment_not_reached", reason: "Reached a funnel step the audience leaves out", sql: sql`NOT ${reachedSql(orgId, brandId, segment.notReached)}` });
  }
  if (!segment.includeClients) parts.push({ code: "client", reason: "Became a client", sql: sql`NOT ${reachedSql(orgId, brandId, ["sale"])}` });
  return parts;
}

/** The segment's predicates on a `people p` row (empty = no narrowing). */
export function segmentWhere(orgId: string, brandId: string, segment: Segment | undefined): SQL[] {
  return segmentClauses(orgId, brandId, segment).map((c) => c.sql);
}

/** A person any of whose CRM contacts is marked do-not-contact (CSV opt-out, GoHighLevel DND). */
export function personOptedOut(orgId: string, brandId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${PRESENCE_REFS} AS ref(id) WHERE ref.id IN (
    SELECT c.id::text FROM contacts c
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.unsubscribed
  ))`;
}

/**
 * The segment as one dealStage per entry, so a count can say how many people
 * each stage holds (`byStage`). A person with deals at two stated stages counts
 * in both: the entries overlap, the segment total counts them once.
 */
export function perStageSegments(segment: Segment): { pipeline: string | null; stage: string; segment: Segment }[] {
  return (segment.dealStages ?? []).map((s) => ({
    pipeline: s.pipeline ?? null,
    stage: s.stage,
    segment: { ...segment, dealStages: [s] },
  }));
}

// ─── What segments a brand's CRM holds (discovery) ──────────────────────────

export interface SegmentCatalogue {
  /** Every (pipeline, stage, status) a CRM deal of the brand sits at now, verbatim. */
  dealStages: { pipeline: string | null; stage: string | null; status: string | null; people: number; inPool: number }[];
  /** Every CRM contact tag of the brand, verbatim (first spelling seen per case-folded tag). */
  tags: { tag: string; people: number; inPool: number }[];
  /** Funnel steps the brand's tools stated, distinct people per step. */
  steps: { step: SegmentStep; people: number; inPool: number }[];
}

/**
 * The parts of the brand's CRM a segment can name, each with `people` (merged
 * people holding it) and `inPool` (of them, those a segment serve could hand out
 * today: email held, not automated, not off-topic, not opted out, not a client,
 * never served). Read-only, no cost. `poolWhere` = lib/serve.ts's base pool.
 */
export async function readSegmentCatalogue(
  run: <T>(q: SQL) => Promise<T[]>,
  orgId: string,
  brandId: string,
  poolWhere: SQL,
): Promise<SegmentCatalogue> {
  const scoped = sql`p.org_id = ${orgId} AND p.brand_id = ${brandId}`;
  const inPool = sql`(${poolWhere} AND NOT ${reachedSql(orgId, brandId, ["sale"])} AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p.emails) AS pe(email)
    JOIN contact_serves s ON s.brand_id = p.brand_id AND s.email = pe.email
  ))`;
  const [dealStages, tags, steps] = await Promise.all([
    run<{ pipeline: string | null; stage: string | null; status: string | null; people: number; in_pool: number }>(sql`
      WITH d AS (
        SELECT DISTINCT p.id AS person, o.pipeline_name AS pipeline, o.stage_name AS stage, o.status, ${inPool} AS in_pool
        FROM people p
        JOIN LATERAL jsonb_array_elements(p.presences) pr ON true
        JOIN ghl_opportunities o ON o.org_id = p.org_id AND o.brand_id = p.brand_id AND o.contact_id::text = pr->>'sourceRef'
        WHERE ${scoped} AND pr->>'source' = 'gohighlevel'
      )
      SELECT pipeline, stage, status, count(*)::int AS people, (count(*) FILTER (WHERE in_pool))::int AS in_pool
      FROM d GROUP BY pipeline, stage, status ORDER BY pipeline NULLS LAST, stage NULLS LAST, status NULLS LAST
    `),
    run<{ tag: string; people: number; in_pool: number }>(sql`
      WITH t AS (
        SELECT DISTINCT p.id AS person, lower(btrim(tag.t)) AS key, btrim(tag.t) AS tag, ${inPool} AS in_pool
        FROM people p
        JOIN LATERAL jsonb_array_elements(p.presences) pr ON true
        JOIN contacts c ON c.org_id = p.org_id AND c.brand_id = p.brand_id AND c.id::text = pr->>'sourceRef'
        JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.tags) = 'array' THEN c.tags ELSE '[]'::jsonb END) AS tag(t) ON true
        WHERE ${scoped} AND btrim(tag.t) <> ''
      )
      SELECT min(tag) AS tag, count(DISTINCT person)::int AS people,
             (count(DISTINCT person) FILTER (WHERE in_pool))::int AS in_pool
      FROM t GROUP BY key ORDER BY people DESC, key LIMIT 500
    `),
    Promise.all(
      SEGMENT_STEPS.map(async (step) => {
        const [row] = await run<{ people: number; in_pool: number }>(sql`
          SELECT count(*)::int AS people, (count(*) FILTER (WHERE ${inPool}))::int AS in_pool
          FROM people p WHERE ${scoped} AND ${reachedSql(orgId, brandId, [step])}
        `);
        return { step, people: row?.people ?? 0, inPool: row?.in_pool ?? 0 };
      }),
    ),
  ]);
  return {
    dealStages: dealStages.map((d) => ({ pipeline: d.pipeline, stage: d.stage, status: d.status, people: d.people, inPool: d.in_pool })),
    tags: tags.map((t) => ({ tag: t.tag, people: t.people, inPool: t.in_pool })),
    steps,
  };
}

// ─── The serving PIPE's step filter (CRM-WARM-NURTURE-1015) ──────────────────

/**
 * `stepFilter` — stated by the serving pipe's play (the workflow, through
 * lead-service and human-service), top-level on serve-next / serve-stats /
 * still-fits, ANDed with whatever the pool and the audience filter. Cross-org
 * words only (funnel steps, never a client's stage or tag name): "reached a form
 * or a meeting, never a sale, never disqualified". Clients are always out of a
 * serve stating it.
 */
export const stepFilterSchema = z
  .object({
    reached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional(),
    notReached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional(),
  })
  .strict()
  .refine((f) => f.reached || f.notReached, { message: "stepFilter needs reached and/or notReached" });
export type StepFilter = z.infer<typeof stepFilterSchema>;

/** The pipe's step filter as named clauses on a `people p` row. */
export function stepFilterClauses(orgId: string, brandId: string, filter: StepFilter | undefined): PoolClause[] {
  if (!filter) return [];
  const parts: PoolClause[] = [];
  if (filter.reached) {
    parts.push({ code: "step_reached", reason: "Has not reached the funnel step the pipe serves", sql: reachedSql(orgId, brandId, filter.reached) });
  }
  if (filter.notReached) {
    parts.push({ code: "step_not_reached", reason: "Reached a funnel step the pipe leaves out", sql: sql`NOT ${reachedSql(orgId, brandId, filter.notReached)}` });
  }
  parts.push({ code: "step_client", reason: "Became a client", sql: sql`NOT ${reachedSql(orgId, brandId, ["sale"])}` });
  return parts;
}

/**
 * The same filter on a CSV row (alias `c` on `sendable_contacts`): judged on the
 * PERSON holding its address (a CSV row nobody else knows reached nothing).
 */
export function csvStepFilterSql(orgId: string, brandId: string, filter: StepFilter | undefined): SQL {
  if (!filter) return sql.empty();
  const person = (cond: SQL) => sql`EXISTS (
    SELECT 1 FROM people p
    WHERE p.org_id = ${orgId} AND p.brand_id = ${brandId}
      AND p.identity_keys @> jsonb_build_array('email:' || lower(c.primary_email))
      AND ${cond}
  )`;
  const parts: SQL[] = [];
  if (filter.reached) parts.push(person(reachedSql(orgId, brandId, filter.reached)));
  if (filter.notReached) parts.push(sql`NOT ${person(reachedSql(orgId, brandId, filter.notReached))}`);
  parts.push(sql`NOT ${person(reachedSql(orgId, brandId, ["sale"]))}`);
  return sql` AND ${sql.join(parts, sql` AND `)}`;
}
