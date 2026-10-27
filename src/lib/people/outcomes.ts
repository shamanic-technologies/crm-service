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
 *   form_submission ← form_submitted, minus a calendar's own booking form
 *   meeting_booked  ← meeting_booked
 *   meeting_attended← meeting_attended
 *   sale            ← sale (a CRM deal won) | payment that STANDS (succeeded and
 *                     not wholly refunded — lead-service's own `paymentStands`)
 *
 * PLUS the people OUR campaigns brought to each step (source `campaigns`):
 * lead-service's own bucket of that token (`GET /orgs/leads?bucket=`, the rows
 * its bucket-counts count), matched onto our people by email. All sources is
 * therefore a superset of "from our campaigns" for every step, one person once:
 * a lead who clicked our email but never identified on PostHog is a visit too
 * (owner 2026-10-11: « tous mes outcomes »). lead-service states no date for a
 * bucket, so a campaigns-only reach is undated.
 *
 * "Contacted by us" (OUTCOMES-CONTACTED-1027) is NOT that bucket: lead-service's brand-wide
 * outcome buckets hold every lead its ledger matched, contacted or not (distribute.you: all 101
 * Clerk signups, none caused by outreach). It is the same bucket scoped to each OFFER of the brand
 * (a campaign of ours served them and is credited the step), what the dashboard's tab counts: see
 * `CONTACTED_FOR_STEP`.
 *
 * lead-service unreachable fails the read (502): a count without our campaigns'
 * people would be a lower figure posing as all sources.
 *
 * No model, no metered call, no cost.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { normalizeEmail } from "./identity.js";
import { mapLimit, siblingGetOk, type SiblingIdentity } from "./siblings.js";
import { readBrandOffers } from "../form-trigger/offer.js";
import { SwrCache } from "./swr.js";
import { createHash } from "node:crypto";

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

/** The source name for people our campaigns brought to a step (lead-service's buckets). */
export const CAMPAIGNS_SOURCE = "campaigns";

/** One person lead-service holds in a step's bucket: their address and the name it serves. */
export interface CampaignReach {
  step: OutcomeStep;
  email: string;
  name: string | null;
}

const LEAD_PAGE = 2000;

interface CompactLeadRow {
  email: string;
  lead: { firstName: string | null; lastName: string | null } | null;
}

/**
 * One address lead-service holds in a step's bucket SCOPED TO ONE OF THE BRAND'S OFFERS: a lead
 * served by a campaign selling that offer, whose reaching the step lead-service credits to that
 * campaign. This is what the dashboard's "Contacted by us" tab counts (it reads the offer scope).
 */
export interface ContactedReach {
  step: OutcomeStep;
  email: string;
}

/** What the Outcomes read needs from lead-service, per brand. */
export interface OutcomeInputs {
  /** Brand-wide buckets: who reached each step through lead-service (adds to Everyone). */
  reach: CampaignReach[];
  /** Offer-scoped buckets, every offer of the brand: who our campaigns brought there (the contacted flag). */
  contacted: ContactedReach[];
}

/**
 * Every row of one lead-service bucket. Pages by lead-service's own `nextCursor` until it is null:
 * a bucket is filtered after the rows are read, so a page can come back SHORT with more behind it,
 * and the old "stop on a short page" walk dropped 7,211 of Doc Dinners' 19,209 contacted leads
 * (2026-10-27).
 */
async function walkBucket(identity: SiblingIdentity, bucket: string, offerId: string | null, onRow: (row: CompactLeadRow) => void): Promise<void> {
  const base =
    `/orgs/leads?brandId=${encodeURIComponent(identity.brandId)}` +
    (offerId ? `&offerId=${encodeURIComponent(offerId)}` : "") +
    `&bucket=${bucket}&view=compact&limit=${LEAD_PAGE}`;
  for (let cursor: string | null = null; ; ) {
    const page: { leads: CompactLeadRow[]; nextCursor?: string | null } = await siblingGetOk<{ leads: CompactLeadRow[]; nextCursor?: string | null }>(
      "lead",
      cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base,
      identity,
    );
    for (const row of page.leads ?? []) onRow(row);
    cursor = page.nextCursor ?? null;
    if (!cursor) break;
  }
}

/**
 * lead-service's step buckets under EACH offer of the brand (brand-service, every status: an
 * archived offer's campaigns contacted people too), one row per (step, address).
 * OUTCOMES-CONTACTED-1027: the brand-wide bucket is NOT "contacted": lead-service's ledger matches
 * leads our campaigns never brought there (distribute.you: all 101 Clerk signups sit in its
 * brand-wide signup bucket, none caused by outreach, while every offer's signup bucket is 0).
 */
export async function readContactedReach(identity: SiblingIdentity, steps: readonly OutcomeStep[]): Promise<ContactedReach[]> {
  const offers = await readBrandOffers(identity);
  const pairs = offers.flatMap((o) => steps.map((step) => ({ offerId: o.offerId, step })));
  const seen = new Set<string>();
  const out: ContactedReach[] = [];
  await mapLimit(pairs, 3, async ({ offerId, step }) => {
    await walkBucket(identity, step, offerId, (row) => {
      const email = normalizeEmail(row.email);
      if (!email || seen.has(`${step}|${email}`)) return;
      seen.add(`${step}|${email}`);
      out.push({ step, email });
    });
  });
  // A stable order: the cache digests the inputs.
  return out.sort((a, b) => (a.step + a.email < b.step + b.email ? -1 : a.step + a.email > b.step + b.email ? 1 : 0));
}

/**
 * lead-service's bucket of each step for the brand, every page, one row per
 * address (a lead in two campaigns is one address). Same population as its
 * `/orgs/leads/bucket-counts` (default statuses).
 */
export async function readCampaignReach(identity: SiblingIdentity, steps: readonly OutcomeStep[]): Promise<CampaignReach[]> {
  const perStep = await mapLimit([...steps], 3, async (step) => {
    const byEmail = new Map<string, CampaignReach>();
    await walkBucket(identity, step, null, (row) => {
      const email = normalizeEmail(row.email);
      if (!email || byEmail.has(email)) return;
      const name = [row.lead?.firstName, row.lead?.lastName].filter((x) => x && x.trim()).join(" ") || null;
      byEmail.set(email, { step, email, name });
    });
    return [...byEmail.values()];
  });
  return perStep.flat();
}

/**
 * A `people_facts f` row counts unless it is a payment that does not STAND:
 * status `succeeded` AND net of refunds > 0 (no amount → stands unless flagged
 * refunded). Same rule as lead-service's `paymentStands`.
 */
export const PAYMENT_STANDS = sql`(f.type <> 'payment' OR (
        f.payload->>'status' = 'succeeded'
        AND CASE WHEN jsonb_typeof(f.payload->'amountMinor') = 'number'
                 THEN (f.payload->>'amountMinor')::numeric
                      - COALESCE(CASE WHEN jsonb_typeof(f.payload->'amountRefunded') = 'number'
                                      THEN (f.payload->>'amountRefunded')::numeric END, 0) > 0
                 ELSE COALESCE(f.payload->>'refunded', 'false') <> 'true' END
      ))`;

/**
 * A `people_facts f` row counts unless it is a submission of a CALENDAR'S OWN
 * booking form: the form a GoHighLevel calendar collects its bookers' details
 * with (the mirrored calendar record states it as `formId`). Filling that form IS
 * booking the meeting (the appointment is its `meeting_booked`), so counting it
 * as `form_submission` too would put every booker on both steps the same minute.
 * Structural: read off the brand's mirrored calendars, never a form name.
 * A `form_origin` fact names no form and is unaffected: GoHighLevel attributes a
 * contact a calendar created to medium `calendar`, never `form` / `survey`.
 */
export const NOT_CALENDAR_BOOKING_FORM = sql`(f.type <> 'form_submitted' OR f.payload->>'formId' IS NULL OR NOT EXISTS (
        SELECT 1 FROM ghl_raw_records cal
        WHERE cal.org_id = f.org_id AND cal.brand_id = f.brand_id AND cal.kind = 'calendar'
          AND cal.payload->>'formId' = f.payload->>'formId'
      ))`;

/**
 * The live step evidence of one brand: one row per fact, its step and its owner.
 * A payment counts only when it stands: status `succeeded` AND net of refunds > 0
 * (no amount → stands unless flagged refunded). Same rule as lead-service.
 */
function evidence(orgId: string, brandId: string, step: OutcomeStep | null, campaigns: CampaignReach[]): SQL {
  const steps = step ? [step] : [...OUTCOME_STEPS];
  const types = [...new Set(steps.flatMap((s) => STEP_FACT_TYPES[s]))];
  const reach = JSON.stringify(campaigns.filter((c) => steps.includes(c.step)));
  // A campaigns reach is the person whose identity holds that address, else a
  // person of its own (`email:<addr>`, the key the people index would give them).
  //
  // The people holding one of those addresses are found FIRST, through the identity-key GIN
  // index (`?|`), then each address is matched among them only: the plain join tested every
  // address against every person of the brand (296 x 28,691 jsonb containment checks, 17-35 s
  // on the distribute.you brand, DASH-LATENCY-1014). Same rows: `?|` is a superset prefilter
  // of the very `@>` the join still applies.
  return sql`
    SELECT COALESCE(p.person_key, 'email:' || l.email) AS person_key, l.step, ${CAMPAIGNS_SOURCE}::text AS source,
           NULL::timestamptz AS occurred_at, 0::bigint AS feed_seq,
           jsonb_build_array(l.email) AS emails, l.name AS full_name
    FROM jsonb_to_recordset(${reach}::jsonb) AS l(step text, email text, name text)
    LEFT JOIN (
      SELECT pp.person_key, pp.identity_keys FROM people pp
      WHERE pp.org_id = ${orgId} AND pp.brand_id = ${brandId}
        AND pp.identity_keys ?| ARRAY(SELECT 'email:' || x.email FROM jsonb_to_recordset(${reach}::jsonb) AS x(email text))
    ) p ON p.identity_keys @> jsonb_build_array('email:' || l.email)
    UNION ALL
    SELECT f.owner_person_key AS person_key,
           CASE f.type WHEN 'form_submitted' THEN 'form_submission'
                       WHEN 'payment' THEN 'sale'
                       ELSE f.type END AS step,
           f.source, f.occurred_at, f.feed_seq, f.emails, f.full_name
    FROM people_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.live AND f.owner_person_key IS NOT NULL
      AND f.type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
      AND ${PAYMENT_STANDS}
      AND ${NOT_CALENDAR_BOOKING_FORM}
  `;
}

/**
 * Every address our campaigns SERVED for the brand: lead-service's `contacted` bucket (put in a
 * sequence) under each offer of the brand, one address once. Leg reach's "contacted by us"
 * exclusion (OUTCOMES-CONTACTED-1027 follow-up): the same rule as Outcomes' tag, step-free.
 */
export async function readServedEmails(identity: SiblingIdentity): Promise<string[]> {
  const offers = await readBrandOffers(identity);
  const seen = new Set<string>();
  await mapLimit(offers, 3, async (o) => {
    await walkBucket(identity, "contacted", o.offerId, (row) => {
      const email = normalizeEmail(row.email);
      if (email) seen.add(email);
    });
  });
  return [...seen].sort();
}

/**
 * The people of the brand holding one of these addresses (a hash join over the brand's unnested
 * email keys), else a person of its own (`email:<addr>`, the facts' own fallback key). One column
 * `person_key`.
 */
export function servedPeople(orgId: string, brandId: string, emails: string[]): SQL {
  return sql`
    SELECT DISTINCT COALESCE(k.person_key, 'email:' || x.email) AS person_key
    FROM jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb) AS x(email)
    LEFT JOIN (
      SELECT pp.person_key, key FROM people pp, jsonb_array_elements_text(pp.identity_keys) AS key
      WHERE pp.org_id = ${orgId} AND pp.brand_id = ${brandId} AND key LIKE 'email:%'
    ) k ON k.key = 'email:' || x.email
  `;
}

/**
 * Per (step, person), the people our campaigns brought to the step (`ContactedReach`): each address
 * matched onto the person holding it by identity key (a hash join over the brand's unnested email
 * keys: a containment test per address against every person is quadratic), else a person of its own
 * (`email:<addr>`, the evidence's own fallback key).
 */
function contactedPeople(orgId: string, brandId: string, contacted: ContactedReach[]): SQL {
  return sql`
    SELECT DISTINCT x.step, COALESCE(k.person_key, 'email:' || x.email) AS person_key
    FROM jsonb_to_recordset(${JSON.stringify(contacted)}::jsonb) AS x(step text, email text)
    LEFT JOIN (
      SELECT pp.person_key, key FROM people pp, jsonb_array_elements_text(pp.identity_keys) AS key
      WHERE pp.org_id = ${orgId} AND pp.brand_id = ${brandId} AND key LIKE 'email:%'
    ) k ON k.key = 'email:' || x.email
  `;
}

/**
 * Outcomes' "contacted by us" for ONE step (OUTCOMES-CONTACTED-1027, owner 2026-10-27: « tu dis
 * "contacted by us" dans la colonne alors qu'ils ne le sont pas »), on a reach row LEFT JOINed to
 * `contactedPeople` `c` on (step, person): lead-service holds the person in that step's bucket under
 * one of the brand's offers, i.e. a campaign of ours served them and lead-service credits the step
 * to it. Per step it is therefore the dashboard's "Contacted by us" tab, one person once. NOT contacted:
 *  - a person lead-service merely holds (`state_source = 'lead_service'`): it holds every signup;
 *  - an Instantly presence alone: distribute.you's 32 signups with one were written to by follow-up
 *    campaigns AFTER signing up; no offer's signup bucket holds them;
 *  - lead-service's brand-wide bucket of the step (its ledger matches non-contacted leads).
 */
const CONTACTED_FOR_STEP = sql`(c.person_key IS NOT NULL)`;

export interface OutcomeStepCount {
  step: OutcomeStep;
  /** Distinct people who reached the step, any source, one person once. */
  people: number;
  /** Distinct people per source stating the step. Overlaps: the same person on two sources counts in both. */
  sources: { source: string; people: number }[];
  /** Of `people`, those our campaigns brought to the step (`CONTACTED_FOR_STEP`). */
  contactedByUs: number;
  /**
   * Month by month (UTC, `YYYY-MM`), the people who reached the step that month, dated by their
   * earliest dated statement of it, one person once, and of those the ones contacted by us. Every
   * month from the brand's first dated reach (any step) up to the current month (or a later dated
   * one), empty months included; [] when the brand holds no dated reach.
   */
  months: OutcomeMonth[];
  /** Reaches no source dates (a campaigns-only reach: lead-service states no bucket date). sum(months) + undated = people. */
  undated: { people: number; contactedByUs: number };
}

export interface OutcomeMonth {
  month: string;
  people: number;
  contactedByUs: number;
  /** Running totals since the first month, this month included: the cumulative line. */
  cumulativePeople: number;
  cumulativeContactedByUs: number;
}

/** `YYYY-MM` of a UTC month index (year * 12 + month). */
const monthLabel = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const monthIndex = (label: string) => Number(label.slice(0, 4)) * 12 + Number(label.slice(5, 7)) - 1;

/**
 * PURE: every month from the first to the last (or `now`'s month when later) with its figures,
 * empty months as zeros. `first`/`last` = the brand's whole span, so every step shares one axis.
 */
export function fillMonths(
  rows: { month: string; people: number; contacted: number }[],
  span: { first: string; last: string } | null,
  now: Date,
): OutcomeMonth[] {
  if (!span) return [];
  const from = monthIndex(span.first);
  const to = Math.max(monthIndex(span.last), now.getUTCFullYear() * 12 + now.getUTCMonth());
  const by = new Map(rows.map((r) => [r.month, r]));
  const out: OutcomeMonth[] = [];
  let people = 0;
  let contacted = 0;
  for (let i = from; i <= to; i++) {
    const r = by.get(monthLabel(i));
    people += r?.people ?? 0;
    contacted += r?.contacted ?? 0;
    out.push({
      month: monthLabel(i),
      people: r?.people ?? 0,
      contactedByUs: r?.contacted ?? 0,
      cumulativePeople: people,
      cumulativeContactedByUs: contacted,
    });
  }
  return out;
}

export async function readOutcomeCounts(orgId: string, brandId: string, inputs: OutcomeInputs): Promise<OutcomeStepCount[]> {
  const ev = evidence(orgId, brandId, null, inputs.reach);
  // ONE statement, the evidence computed once (it used to run twice, in two parallel queries).
  const all = await rows<{
    kind: "total" | "source" | "month";
    step: OutcomeStep;
    source: string | null;
    month: string | null;
    people: number;
    contacted: number;
  }>(sql`
    WITH e AS MATERIALIZED (${ev}),
    c AS MATERIALIZED (${contactedPeople(orgId, brandId, inputs.contacted)}),
    r0 AS (SELECT step, person_key, min(occurred_at) AS reach_at FROM e GROUP BY step, person_key),
    r AS (
      SELECT r.step, r.person_key, ${CONTACTED_FOR_STEP} AS ours, to_char(r.reach_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month
      FROM r0 r LEFT JOIN c ON c.step = r.step AND c.person_key = r.person_key
    )
    SELECT 'total'::text AS kind, step, NULL::text AS source, NULL::text AS month, count(*)::int AS people,
           count(*) FILTER (WHERE ours)::int AS contacted
    FROM r GROUP BY step
    UNION ALL
    SELECT 'month'::text AS kind, step, NULL::text AS source, month, count(*)::int AS people,
           count(*) FILTER (WHERE ours)::int AS contacted
    FROM r GROUP BY step, month
    UNION ALL
    SELECT 'source'::text AS kind, step, source, NULL::text AS month, count(DISTINCT person_key)::int AS people, 0 AS contacted
    FROM e GROUP BY step, source
  `);
  const totals = all.filter((x) => x.kind === "total");
  const months = all.filter((x) => x.kind === "month");
  const dated = months.filter((x) => x.month !== null).map((x) => x.month as string).sort();
  const span = dated.length > 0 ? { first: dated[0], last: dated[dated.length - 1] } : null;
  const now = new Date();
  // Per step: most people first, then source name (source tokens are lower-case ASCII).
  const bySource = all
    .filter((x) => x.kind === "source")
    .map((x) => ({ step: x.step, source: x.source as string, people: x.people }))
    .sort((a, b) => b.people - a.people || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return OUTCOME_STEPS.map((step) => {
    const t = totals.find((x) => x.step === step);
    const own = months.filter((x) => x.step === step);
    const undated = own.find((x) => x.month === null);
    return {
      step,
      people: t?.people ?? 0,
      sources: bySource.filter((s) => s.step === step).map((s) => ({ source: s.source, people: s.people })),
      contactedByUs: t?.contacted ?? 0,
      months: fillMonths(
        own.filter((x) => x.month !== null).map((x) => ({ month: x.month as string, people: x.people, contacted: x.contacted })),
        span,
        now,
      ),
      undated: { people: undated?.people ?? 0, contactedByUs: undated?.contacted ?? 0 },
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
  inputs: OutcomeInputs,
): Promise<{ total: number; people: OutcomePerson[] }> {
  const ev = evidence(orgId, brandId, step, inputs.reach);
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
    c AS (${contactedPeople(orgId, brandId, inputs.contacted)}),
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
           ${CONTACTED_FOR_STEP} AS contacted, p.state, p.state_source,
           count(*) OVER ()::int AS total
    FROM who w
    LEFT JOIN c ON c.step = ${step} AND c.person_key = w.person_key
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

// ─── Cached reads (DASH-LATENCY-1014) ───────────────────────────────────────
//
// The dashboard reads a brand's outcomes on EVERY brand page, every few seconds per
// open tab. Both inputs are cached per (org, brand), stale-while-revalidate (swr.ts):
//  - lead-service's buckets: re-read at most every `outcomesFreshMs()`;
//  - the counts: recomputed only when what they are computed FROM moved: the people
//    build (`people_scopes.last_built_at`), the fact feed (`max(feed_seq)`: a
//    withdrawal or a re-owning is always written beside a new fact, in the same
//    transaction), the brand's GoHighLevel calendars (the booking-form rule), or the
//    campaigns reach. Unchanged inputs reuse the figures, at most `outcomesReuseMaxMs()`.
// A served figure is at most ~`outcomesFreshMs()` + one refresh old while a tab polls.

export const outcomesFreshMs = () => Number(process.env.PEOPLE_OUTCOMES_FRESH_MS) || 10_000;
/** Past fresh and under this age, the cached answer is served while ONE refresh runs behind it. */
export const outcomesMaxStaleMs = () => Number(process.env.PEOPLE_OUTCOMES_MAX_STALE_MS) || 60_000;
/** Unchanged inputs reuse the figures at most this long (a recompute still happens on a quiet brand). */
export const outcomesReuseMaxMs = () => Number(process.env.PEOPLE_OUTCOMES_REUSE_MAX_MS) || 300_000;

/** lead-service could not be read: the route answers 502 campaign_outcomes_unavailable. */
export class CampaignReachUnavailable extends Error {}

const reachCache = new SwrCache<OutcomeInputs>("outcomes campaign reach", outcomesFreshMs, outcomesMaxStaleMs);

/** Every step's campaigns reach of the brand (readCampaignReach over all steps) + its contacted leads, cached. */
export function cachedOutcomeInputs(identity: SiblingIdentity): Promise<OutcomeInputs> {
  return reachCache.get(`${identity.orgId}|${identity.brandId}`, () =>
    Promise.all([readCampaignReach(identity, OUTCOME_STEPS), readContactedReach(identity, OUTCOME_STEPS)])
      .then(([reach, contacted]) => ({ reach, contacted }))
      .catch((err: Error) => {
        throw new CampaignReachUnavailable(err.message);
      }),
  );
}

/** What the counts are computed from, besides the campaigns reach. One indexed probe. */
export async function outcomesFingerprint(orgId: string, brandId: string): Promise<string> {
  const [r] = await rows<{ built: string | null; seq: string | null; calendars: string | null }>(sql`
    SELECT (SELECT last_built_at::text FROM people_scopes WHERE org_id = ${orgId} AND brand_id = ${brandId}) AS built,
           (SELECT max(feed_seq)::text FROM people_facts WHERE org_id = ${orgId} AND brand_id = ${brandId}) AS seq,
           (SELECT md5(string_agg(external_id || ':' || content_hash, ',' ORDER BY external_id, content_hash))
              FROM ghl_raw_records WHERE org_id = ${orgId} AND brand_id = ${brandId} AND kind = 'calendar') AS calendars
  `);
  return `${r?.built ?? ""}|${r?.seq ?? ""}|${r?.calendars ?? ""}`;
}

const reachDigest = (inputs: OutcomeInputs) => createHash("sha256").update(JSON.stringify(inputs)).digest("hex");

interface CountsEntry {
  steps: OutcomeStepCount[];
  fingerprint: string;
  computedAt: number;
}

const countsCache = new SwrCache<CountsEntry>("outcomes counts", outcomesFreshMs, outcomesMaxStaleMs);

/** `readOutcomeCounts` for the brand, cached (figures identical to a fresh computation of the same inputs). */
export async function cachedOutcomeCounts(identity: SiblingIdentity): Promise<OutcomeStepCount[]> {
  const { orgId, brandId } = identity;
  const entry = await countsCache.get(`${orgId}|${brandId}`, async (previous) => {
    const startedAt = Date.now();
    const inputs = await cachedOutcomeInputs(identity);
    const fingerprint = `${await outcomesFingerprint(orgId, brandId)}|${reachDigest(inputs)}`;
    const prev = previous?.value;
    if (prev && prev.fingerprint === fingerprint && Date.now() - prev.computedAt < outcomesReuseMaxMs()) return prev;
    return { steps: await readOutcomeCounts(orgId, brandId, inputs), fingerprint, computedAt: startedAt };
  });
  return entry.steps;
}

/** Tests: forget every cached read. */
export function clearOutcomesCache(): void {
  reachCache.clear();
  countsCache.clear();
}
