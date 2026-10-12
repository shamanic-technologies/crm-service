/**
 * Leg reach — how the brand's OWN team converts on one funnel leg (FROM step →
 * TO step), read off the brand's own tools, for a server-to-server caller
 * (features-service prices the "your team" pipes off it).
 *
 * Population: the brand's people (one person once across sources, the fact's
 * CURRENT owner, `owner_person_key`) who reached FROM on any source we mirror,
 * MINUS:
 *   - the people our campaigns contacted (`CONTACTED`: an Instantly presence =
 *     at least one real cold email, or lead-service holds them as our lead);
 *   - the people the people layer holds as nobody (`automated` senders, and
 *     `not_business` personal-channel threads).
 * A fact owner that left the people index since is kept (nothing says we
 * contacted them).
 *
 * TO counts only for a member of that population, and only when it happened
 * on or after the UTC DAY they first reached FROM (same day counts: a form
 * creating the contact and the booking it led to are seconds apart, in either
 * order). An undated end cannot be ordered and counts. A person who reached TO
 * only on an earlier day is `toBeforeFrom`, reported, never counted.
 * TO people are served twice by day: `byDay` on the day they reached TO, and
 * `byFromDay` on the day they first reached FROM (the cohort: a period's TO is
 * then always a subset of that period's FROM).
 *
 * Steps (lead-service's bucket tokens, plus `conversation` and `lead_found`):
 *   lead_found      ← every person the brand HOLDS in its tools (the people
 *                     index, any source), dated on the earliest live fact of the
 *                     person (when they first appeared: a CRM contact's
 *                     creation, a CSV upload, a first message...), else undated.
 *                     Recorded whenever the brand has people; FROM only ever
 *                     (nothing "reaches" being held after another step).
 *   conversation    ← message_in (Gmail / Matrix: the person WROTE to the brand,
 *                     and the people layer kept the thread as business)
 *   website_visit   ← website_visit (PostHog)
 *   signup          ← signup (PostHog, auth providers)
 *   form_submission ← form_submitted (GoHighLevel): a submission of a lead
 *                     form, or a contact a form / survey created (`form_origin`);
 *                     a submission of a calendar's own booking form is the
 *                     BOOKING, not a form step (`NOT_CALENDAR_BOOKING_FORM`)
 *   meeting_booked / meeting_attended ← GoHighLevel
 *   sale            ← sale (GoHighLevel deal won) | payment that stands (Stripe)
 * The source that records each step is fixed by what the fact feed derives;
 * a leg whose FROM or TO has no CONNECTED recording source answers a named
 * reason, never 0.
 *
 * Read-only on our own gold: never opens a scope, never builds, no vendor call,
 * no model, no cost.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleScopes } from "../../db/schema.js";
import { AUTH_PROVIDER_NAMES } from "../auth/providers.js";
import { CONTACTED, NOT_CALENDAR_BOOKING_FORM, PAYMENT_STANDS } from "./outcomes.js";

export const LEG_STEPS = [
  "lead_found",
  "conversation",
  "website_visit",
  "signup",
  "form_submission",
  "meeting_booked",
  "meeting_attended",
  "sale",
] as const;
export type LegStep = (typeof LEG_STEPS)[number];

/** The catalogue's step keys (features-service / dashboard) accepted beside lead-service's tokens. */
export const LEG_STEP_ALIASES: Record<string, LegStep> = {
  form_submitted: "form_submission",
  paid_client: "sale",
};

export function parseLegStep(raw: unknown): LegStep | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if ((LEG_STEPS as readonly string[]).includes(t)) return t as LegStep;
  return LEG_STEP_ALIASES[t] ?? null;
}

/** Which crm fact types state each step. */
const STEP_FACTS: Record<LegStep, readonly string[]> = {
  lead_found: [],
  conversation: ["message_in"],
  website_visit: ["website_visit"],
  signup: ["signup"],
  form_submission: ["form_submitted"],
  meeting_booked: ["meeting_booked"],
  meeting_attended: ["meeting_attended"],
  sale: ["sale", "payment"],
};

/** Which people sources can state each step (what the fact feed derives per source). */
export const STEP_SOURCES: Record<LegStep, readonly string[]> = {
  // Any source the people index holds a person from (our own outreach excluded: those people are out of every population).
  lead_found: ["gohighlevel", "csv", "gmail", "matrix", "posthog", "stripe", ...AUTH_PROVIDER_NAMES],
  conversation: ["gmail", "matrix"],
  website_visit: ["posthog"],
  signup: ["posthog", ...AUTH_PROVIDER_NAMES],
  form_submission: ["gohighlevel"],
  meeting_booked: ["gohighlevel"],
  meeting_attended: ["gohighlevel"],
  sale: ["gohighlevel", "stripe"],
};

type SourceStatus = "ok" | "failed" | "not_connected";

interface ScopeRow {
  id: string;
  orgId: string;
  brandId: string;
  status: string;
  lastBuiltAt: Date | null;
  sourceReads: unknown;
}

/** The scope's last build verdict per source (`source_reads.sources`). */
function sourceStatuses(scope: ScopeRow): Map<string, SourceStatus> {
  const out = new Map<string, SourceStatus>();
  const reads = scope.sourceReads as { sources?: { source: string; status: SourceStatus }[] } | null;
  for (const s of reads?.sources ?? []) out.set(s.source, s.status);
  return out;
}

/** Sources connected to the scope (connected but last read failed still counts: its facts stay live). */
function connectedSources(scope: ScopeRow): string[] {
  return [...sourceStatuses(scope)].filter(([, st]) => st !== "not_connected").map(([s]) => s);
}

/** Fact-recorded steps some connected source of the scope can state (`lead_found` aside: it is recorded by the people index). */
function factRecordedSteps(scope: ScopeRow): LegStep[] {
  const connected = new Set(connectedSources(scope));
  return LEG_STEPS.filter((step) => step !== "lead_found" && STEP_SOURCES[step].some((s) => connected.has(s)));
}

/** Steps a leg of the scope can start or end on: `lead_found` whenever the brand holds people. */
function recordedSteps(scope: ScopeRow, hasPeople: boolean): LegStep[] {
  return hasPeople ? ["lead_found", ...factRecordedSteps(scope)] : factRecordedSteps(scope);
}

/** Scope ids holding at least one person. */
async function scopesWithPeople(scopeIds: string[]): Promise<Set<string>> {
  if (scopeIds.length === 0) return new Set();
  const found = await rows<{ scope_id: string }>(sql`
    SELECT s.id AS scope_id FROM people_scopes s
    WHERE s.id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND EXISTS (SELECT 1 FROM people p WHERE p.scope_id = s.id)`);
  return new Set(found.map((r) => r.scope_id));
}

const SCOPE_COLUMNS = {
  id: peopleScopes.id,
  orgId: peopleScopes.orgId,
  brandId: peopleScopes.brandId,
  status: peopleScopes.status,
  lastBuiltAt: peopleScopes.lastBuiltAt,
  sourceReads: peopleScopes.sourceReads,
};

export interface LegReachBrand {
  orgId: string;
  brandId: string;
  scopeStatus: string;
  lastBuiltAt: string | null;
  connectedSources: string[];
  /** The steps a leg of this brand can start or end on. Empty = nothing answerable. */
  recordedSteps: LegStep[];
}

/** Every (org, brand) whose people layer exists, with the steps it can answer. */
export async function listLegReachBrands(): Promise<LegReachBrand[]> {
  const scopes = await db.select(SCOPE_COLUMNS).from(peopleScopes).orderBy(peopleScopes.brandId, peopleScopes.orgId);
  const withPeople = await scopesWithPeople(scopes.map((s) => s.id));
  return scopes.map((s) => ({
    orgId: s.orgId,
    brandId: s.brandId,
    scopeStatus: s.status,
    lastBuiltAt: s.lastBuiltAt ? s.lastBuiltAt.toISOString() : null,
    connectedSources: connectedSources(s),
    recordedSteps: recordedSteps(s, withPeople.has(s.id)),
  }));
}

export type LegReachReasonCode =
  | "no_people_scope"
  | "not_synced"
  | "no_connected_source"
  | "from_step_not_recorded"
  | "to_step_not_recorded";

export interface LegReachReason {
  code: LegReachReasonCode;
  message: string;
  /** For a `*_step_not_recorded` / `not_synced` reason: the step and the sources that would record it. */
  step?: LegStep;
  recordedBy?: string[];
}

export interface LegEnd {
  /** Distinct people who reached this end (TO: a subset of FROM's people). */
  people: number;
  /** Of `people`, those no source dated (not in `byDay`). */
  undated: number;
  /** Dated people per UTC day of reaching this end (first time); sums with `undated` to `people`. */
  byDay: { day: string; people: number }[];
  /** Distinct people per source evidencing this end; a person on two sources counts in both. */
  sources: { source: string; people: number }[];
}

export type LegReach =
  | { status: "ambiguous"; orgIds: string[] }
  | {
      status: "answered";
      orgId: string | null;
      scope: { status: string; lastBuiltAt: string | null } | null;
      connectedSources: string[];
      stepSources: { from: readonly string[]; to: readonly string[] };
      available: boolean;
      /** The first of `reasons`; null when available. */
      reason: LegReasonCodeOrNull;
      reasons: LegReachReason[];
      reachedFrom?: LegEnd;
      /** `byFromDay` = the same TO people filed on the UTC day they first reached FROM (cohort). */
      reachedTo?: LegEnd & { toBeforeFrom: number; byFromDay: { day: string; people: number }[]; undatedFrom: number };
      excluded?: { contactedByUs: number; automated: number; notBusiness: number };
    };
type LegReasonCodeOrNull = LegReachReasonCode | null;

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

function reasonsFor(scope: ScopeRow | null, from: LegStep, to: LegStep, hasPeople: boolean): LegReachReason[] {
  if (!scope) {
    return [{ code: "no_people_scope", message: "this brand's people layer was never opened (no one has read its people yet)" }];
  }
  if (scope.status === "pending" || !scope.lastBuiltAt) {
    return [{ code: "not_synced", message: "this brand's people layer has not finished its first build" }];
  }
  const statuses = sourceStatuses(scope);
  const connected = connectedSources(scope);
  if (factRecordedSteps(scope).length === 0 && !(hasPeople && from === "lead_found")) {
    return [{ code: "no_connected_source", message: "no source that records a funnel step is connected for this brand" }];
  }
  const out: LegReachReason[] = [];
  for (const [end, step] of [["from", from], ["to", to]] as const) {
    if (step === "lead_found") {
      if (end === "to") {
        out.push({
          code: "to_step_not_recorded",
          message: "lead_found is where a person starts (held in the brand's tools), never a step reached after another",
          step,
          recordedBy: [],
        });
      } else if (!hasPeople) {
        out.push({
          code: "from_step_not_recorded",
          message: "lead_found = a person the brand holds in its tools; this brand's people layer holds nobody",
          step,
          recordedBy: [...STEP_SOURCES.lead_found],
        });
      }
      continue;
    }
    const recordedBy = [...STEP_SOURCES[step]];
    const states = recordedBy.map((s) => statuses.get(s) ?? "not_connected");
    if (states.every((st) => st === "not_connected")) {
      out.push({
        code: end === "from" ? "from_step_not_recorded" : "to_step_not_recorded",
        message: `${step} is recorded by ${recordedBy.join(" / ")}, none connected for this brand`,
        step,
        recordedBy,
      });
    } else if (!states.includes("ok")) {
      out.push({
        code: "not_synced",
        message: `${step} is recorded by ${recordedBy.join(" / ")}: connected, but none has read successfully yet`,
        step,
        recordedBy,
      });
    }
  }
  return out;
}

/**
 * The scope a brand-only read answers for. Several orgs can hold a people
 * scope on one brand (a moved brand, a staff look); only those whose
 * connected sources record a step can answer. Several such → ambiguous.
 */
async function resolveScope(brandId: string, orgId: string | null): Promise<{ scope: ScopeRow | null } | { ambiguous: string[] }> {
  const where = orgId ? and(eq(peopleScopes.brandId, brandId), eq(peopleScopes.orgId, orgId)) : eq(peopleScopes.brandId, brandId);
  const scopes = await db.select(SCOPE_COLUMNS).from(peopleScopes).where(where).orderBy(desc(peopleScopes.lastBuiltAt));
  if (scopes.length <= 1) return { scope: scopes[0] ?? null };
  const answering = scopes.filter((s) => factRecordedSteps(s).length > 0);
  if (answering.length > 1) return { ambiguous: answering.map((s) => s.orgId) };
  return { scope: answering[0] ?? scopes[0] };
}

export async function readLegReach(brandId: string, orgId: string | null, from: LegStep, to: LegStep): Promise<LegReach> {
  const resolved = await resolveScope(brandId, orgId);
  if ("ambiguous" in resolved) return { status: "ambiguous", orgIds: resolved.ambiguous };
  const scope = resolved.scope;
  const base = {
    status: "answered" as const,
    orgId: scope?.orgId ?? orgId,
    scope: scope ? { status: scope.status, lastBuiltAt: scope.lastBuiltAt ? scope.lastBuiltAt.toISOString() : null } : null,
    connectedSources: scope ? connectedSources(scope) : [],
    stepSources: { from: STEP_SOURCES[from], to: STEP_SOURCES[to] },
  };
  const hasPeople = scope ? (await scopesWithPeople([scope.id])).has(scope.id) : false;
  const reasons = reasonsFor(scope, from, to, hasPeople);
  if (reasons.length > 0 || !scope) {
    return { ...base, available: false, reason: reasons[0].code, reasons };
  }
  const counts = await countLeg(scope.orgId, brandId, from, to);
  return { ...base, available: true, reason: null, reasons: [], ...counts };
}

function stepCase(from: LegStep, to: LegStep): SQL {
  const types = (step: LegStep) => sql.join(STEP_FACTS[step].map((t) => sql`${t}`), sql`, `);
  return sql`CASE WHEN f.type IN (${types(from)}) THEN 'from' WHEN f.type IN (${types(to)}) THEN 'to' END`;
}

/** crm's own bookkeeping facts: no presence of the person in the brand's tools. */
const META_FACT_TYPES = ["person_merged", "person_split", "withdrawn"];

/**
 * `lead_found` evidence: every person the people index holds (one row per
 * source they appear on, undated), plus every live fact owner (dated: the
 * earliest one is when the person first appeared in the brand's tools; an owner
 * that left the index since is kept, as for every other step), plus the TO
 * step's own facts.
 */
function leadFoundEvidence(orgId: string, brandId: string, to: LegStep): SQL {
  const toTypes = sql.join(STEP_FACTS[to].map((t) => sql`${t}`), sql`, `);
  return sql`
    SELECT p.person_key AS pk, 'from' AS end_, src.source, NULL::timestamptz AS occurred_at
    FROM people p CROSS JOIN LATERAL jsonb_array_elements_text(p.sources) AS src(source)
    WHERE p.org_id = ${orgId} AND p.brand_id = ${brandId}
    UNION ALL
    SELECT f.owner_person_key AS pk, 'from' AS end_, f.source, f.occurred_at
    FROM people_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.live AND f.owner_person_key IS NOT NULL
      AND f.type NOT IN (${sql.join(META_FACT_TYPES.map((t) => sql`${t}`), sql`, `)})
    UNION ALL
    SELECT f.owner_person_key AS pk, 'to' AS end_, f.source, f.occurred_at
    FROM people_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.live AND f.owner_person_key IS NOT NULL
      AND f.type IN (${toTypes})
      AND ${PAYMENT_STANDS}
      AND ${NOT_CALENDAR_BOOKING_FORM}
  `;
}

async function countLeg(orgId: string, brandId: string, from: LegStep, to: LegStep) {
  const allTypes = [...new Set([...STEP_FACTS[from], ...STEP_FACTS[to]])];
  // One row per (person, end, source, UTC day | null) of the live evidence.
  const evidence = from === "lead_found" ? leadFoundEvidence(orgId, brandId, to) : sql`
    SELECT f.owner_person_key AS pk, ${stepCase(from, to)} AS end_, f.source, f.occurred_at
    FROM people_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.live AND f.owner_person_key IS NOT NULL
      AND f.type IN (${sql.join(allTypes.map((t) => sql`${t}`), sql`, `)})
      AND ${PAYMENT_STANDS}
      AND ${NOT_CALENDAR_BOOKING_FORM}
  `;
  const base = sql`
    WITH e AS (${evidence}),
    fromers AS (
      SELECT e.pk, min(e.occurred_at) AS from_at
      FROM e WHERE e.end_ = 'from' GROUP BY e.pk
    ),
    tagged AS (
      SELECT fr.pk, fr.from_at,
             COALESCE(${CONTACTED}, false) AS contacted,
             COALESCE(p.automated, false) AS automated,
             COALESCE(p.not_business, false) AS not_business
      FROM fromers fr
      LEFT JOIN people p ON p.org_id = ${orgId} AND p.brand_id = ${brandId} AND p.person_key = fr.pk
    ),
    pop AS (SELECT pk, from_at FROM tagged WHERE NOT contacted AND NOT automated AND NOT not_business),
    to_ev AS (
      SELECT e.pk, e.source, e.occurred_at,
             (e.occurred_at IS NULL OR pop.from_at IS NULL
              OR (e.occurred_at AT TIME ZONE 'UTC')::date >= (pop.from_at AT TIME ZONE 'UTC')::date) AS counts
      FROM e JOIN pop ON pop.pk = e.pk WHERE e.end_ = 'to'
    ),
    toers AS (
      SELECT pk, min(occurred_at) AS to_at FROM to_ev WHERE counts GROUP BY pk
    )
  `;
  const day = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
  const [excluded, fromDays, fromSources, toDays, toSources, before, toCohort] = await Promise.all([
    rows<{ contacted: number; automated: number; not_business: number }>(sql`${base}
      SELECT count(*) FILTER (WHERE contacted)::int AS contacted,
             count(*) FILTER (WHERE NOT contacted AND automated)::int AS automated,
             count(*) FILTER (WHERE NOT contacted AND NOT automated AND not_business)::int AS not_business
      FROM tagged`),
    rows<{ day: string | null; people: number }>(sql`${base}
      SELECT ${day("from_at")} AS day, count(*)::int AS people FROM pop GROUP BY 1 ORDER BY 1 NULLS LAST`),
    rows<{ source: string; people: number }>(sql`${base}
      SELECT e.source, count(DISTINCT e.pk)::int AS people
      FROM e JOIN pop ON pop.pk = e.pk WHERE e.end_ = 'from' GROUP BY e.source ORDER BY people DESC, e.source`),
    rows<{ day: string | null; people: number }>(sql`${base}
      SELECT ${day("to_at")} AS day, count(*)::int AS people FROM toers GROUP BY 1 ORDER BY 1 NULLS LAST`),
    rows<{ source: string; people: number }>(sql`${base}
      SELECT source, count(DISTINCT pk)::int AS people FROM to_ev WHERE counts GROUP BY source ORDER BY people DESC, source`),
    rows<{ n: number }>(sql`${base}
      SELECT count(DISTINCT pk)::int AS n FROM to_ev WHERE pk NOT IN (SELECT pk FROM toers)`),
    rows<{ day: string | null; people: number }>(sql`${base}
      SELECT ${day("pop.from_at")} AS day, count(*)::int AS people
      FROM toers JOIN pop ON pop.pk = toers.pk GROUP BY 1 ORDER BY 1 NULLS LAST`),
  ]);
  const end = (days: { day: string | null; people: number }[], sources: { source: string; people: number }[]): LegEnd => ({
    people: days.reduce((n, d) => n + d.people, 0),
    undated: days.filter((d) => d.day === null).reduce((n, d) => n + d.people, 0),
    byDay: days.filter((d) => d.day !== null).map((d) => ({ day: d.day as string, people: d.people })),
    sources,
  });
  return {
    reachedFrom: end(fromDays, fromSources),
    reachedTo: {
      ...end(toDays, toSources),
      toBeforeFrom: before[0].n,
      byFromDay: toCohort.filter((d) => d.day !== null).map((d) => ({ day: d.day as string, people: d.people })),
      undatedFrom: toCohort.filter((d) => d.day === null).reduce((n, d) => n + d.people, 0),
    },
    excluded: { contactedByUs: excluded[0].contacted, automated: excluded[0].automated, notBusiness: excluded[0].not_business },
  };
}
