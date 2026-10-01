/**
 * Building one scope's people: read every source, merge on positive evidence,
 * resolve each person's ONE state, and replace the scope's gold rows in one
 * transaction (a reader never sees half a build).
 *
 * A source that fails to read does not stop the build — its failure is recorded
 * in `source_reads` (status `failed` + the error) and its people are simply
 * absent, which the read surfaces as such. Only a failure of crm-service itself
 * (its database, run tracking) fails the build.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { leadStandingObservations, people, peopleScopes, type PeopleScope } from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, updateRun } from "../runs-client.js";
import {
  clusterPeople,
  PEOPLE_SOURCES,
  type Evidence,
  type PersonCluster,
  type PeopleSource,
} from "./identity.js";
import { mapLimit, type SiblingIdentity } from "./siblings.js";
import {
  lookupLeadStanding,
  readCsvEvidence,
  readGmail,
  readGoHighLevel,
  readGoogleContactEvidence,
  readInstantly,
  readLeadRulingEvidence,
  readMatrix,
  readOwnAddresses,
  withoutOwnAddresses,
  type EvidenceRead,
  type SourceRead,
} from "./sources.js";
import { resolvePersonState, type GhlDeal, type LeadObservation } from "./state.js";

/** How long lead-service's answer about an address is reused. */
export const STANDING_TTL_MS = 60 * 60 * 1000;
const STANDING_CONCURRENCY = 6;

/** Display-name / company precedence: the CRM first, then address books, then the rest. */
const NAME_PRECEDENCE: (PeopleSource | Evidence["kind"])[] = [
  "gohighlevel",
  "gohighlevel_contact",
  "lead_ruling",
  "google_contact",
  "matrix",
  "gmail",
  "csv_contact",
  "instantly",
];

export interface SourceReadSummary {
  source: PeopleSource;
  status: SourceRead["status"];
  scope: SourceRead["scope"];
  /** Source records read (one per address / contact). */
  presences: number;
  /** What the source itself counts. */
  sourceCount: number | null;
  sourceCountBasis: string;
  /** Records dropped because they are the brand's own address (a sending mailbox, its domain). */
  excludedOwn: number;
  error: string | null;
}

export interface BuildSummary {
  people: number;
  sources: SourceReadSummary[];
  evidence: { kind: string; status: string; records: number; error: string | null }[];
  standing: { asked: number; reused: number; failed: number };
  ownAddresses: { status: "ok" | "failed"; addresses: number; domain: string | null; error: string | null };
}

function firstNonNull(
  cluster: PersonCluster,
  field: "displayName" | "company",
): string | null {
  const candidates: { rank: number; value: string }[] = [];
  for (const p of cluster.presences) {
    const v = p[field];
    if (v && v.trim()) candidates.push({ rank: NAME_PRECEDENCE.indexOf(p.source), value: v.trim() });
  }
  for (const e of cluster.evidence) {
    const v = e[field];
    if (v && v.trim()) candidates.push({ rank: NAME_PRECEDENCE.indexOf(e.kind), value: v.trim() });
  }
  candidates.sort((a, b) => a.rank - b.rank || (a.value < b.value ? -1 : 1));
  return candidates[0]?.value ?? null;
}

const toTimes = (xs: (string | null)[]) =>
  xs.filter((x): x is string => !!x).map((x) => new Date(x).getTime()).filter((t) => !Number.isNaN(t));
const minDate = (xs: (string | null)[]) => {
  const t = toTimes(xs);
  return t.length ? new Date(Math.min(...t)).toISOString() : null;
};
const maxDate = (xs: (string | null)[]) => {
  const t = toTimes(xs);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
};

/**
 * lead-service's answer for every address, reusing a fresh cached answer. An
 * answer is re-asked when older than the TTL or older than the person's last
 * activity (something happened since).
 */
async function observeStandings(
  scope: PeopleScope,
  identity: SiblingIdentity,
  wanted: Map<string, string | null>,
): Promise<{ observations: Map<string, LeadObservation>; asked: number; reused: number; failed: number }> {
  const cached = await db
    .select()
    .from(leadStandingObservations)
    .where(and(eq(leadStandingObservations.orgId, scope.orgId), eq(leadStandingObservations.brandId, scope.brandId)));
  const cache = new Map(cached.map((c) => [c.email, c]));
  const now = Date.now();
  const observations = new Map<string, LeadObservation>();
  const toAsk: string[] = [];
  let reused = 0;
  for (const [email, lastActivity] of wanted) {
    const hit = cache.get(email);
    const fresh =
      hit &&
      now - hit.observedAt.getTime() < STANDING_TTL_MS &&
      (!lastActivity || new Date(lastActivity) <= hit.observedAt);
    if (fresh) {
      observations.set(email, hit.found ? ({ found: true, email, ...(hit.payload as object) } as LeadObservation) : { found: false });
      reused++;
    } else {
      toAsk.push(email);
    }
  }
  let failed = 0;
  await mapLimit(toAsk, STANDING_CONCURRENCY, async (email) => {
    try {
      const answer = await lookupLeadStanding(identity, email);
      const payload = answer.found ? { ...answer, found: undefined } : null;
      await db
        .insert(leadStandingObservations)
        .values({ orgId: scope.orgId, brandId: scope.brandId, email, found: answer.found, payload, observedAt: new Date() })
        .onConflictDoUpdate({
          target: [leadStandingObservations.orgId, leadStandingObservations.brandId, leadStandingObservations.email],
          set: { found: answer.found, payload, observedAt: new Date() },
        });
      observations.set(email, answer.found ? { ...answer, email } : { found: false });
    } catch (err) {
      failed++;
      observations.set(email, { found: "error", error: (err as Error).message });
    }
  });
  return { observations, asked: toAsk.length, reused, failed };
}

/** Read, merge, resolve, write. Returns what the build saw, per source. */
export async function buildScopePeople(scope: PeopleScope, runId: string): Promise<BuildSummary> {
  const identity: SiblingIdentity = {
    orgId: scope.orgId,
    userId: scope.createdByUserId,
    runId,
    brandId: scope.brandId,
  };

  const [rawGmail, rawInstantly, rawMatrix, rawGhl, own] = await Promise.all([
    readGmail(identity),
    readInstantly(identity),
    readMatrix(scope.orgId, scope.brandId),
    readGoHighLevel(scope.orgId, scope.brandId),
    readOwnAddresses(identity),
  ]);
  const filtered = [rawGmail, rawInstantly, rawMatrix, rawGhl].map((r) => withoutOwnAddresses(r, own));
  const reads: SourceRead[] = filtered.map((f) => f.read);
  const [gmail, , , gohighlevel] = reads;

  const evidenceReads: EvidenceRead[] = [await readCsvEvidence(scope.orgId, scope.brandId)];
  if (gmail.status !== "not_connected") evidenceReads.push(await readGoogleContactEvidence(identity));
  if (gohighlevel.status === "ok") evidenceReads.push(await readLeadRulingEvidence(identity));
  // A GoHighLevel contact holding an email and a phone ties them — it is also a presence.
  const ghlEvidence: Evidence[] = gohighlevel.presences
    .filter((p) => p.emails.length + p.phones.length > 1)
    .map((p) => ({
      kind: "gohighlevel_contact",
      ref: p.sourceRef,
      displayName: p.displayName,
      company: p.company,
      emails: p.emails,
      phones: p.phones,
    }));

  const clusters = clusterPeople(
    reads.flatMap((r) => r.presences),
    [...ghlEvidence, ...evidenceReads.flatMap((e) => e.evidence)],
  );

  // lead-service is asked about every address of every person.
  const wanted = new Map<string, string | null>();
  for (const c of clusters) {
    const last = maxDate(c.presences.map((p) => p.lastActivityAt));
    for (const e of c.emails) wanted.set(e, last);
  }
  const standings = await observeStandings(scope, identity, wanted);

  const rows = clusters.map((c) => {
    const ghlDeals: GhlDeal[] = c.presences
      .filter((p) => p.source === "gohighlevel")
      .flatMap((p) => (p.detail.deals as GhlDeal[]) ?? []);
    const matrixStatuses = c.presences
      .filter((p) => p.source === "matrix" && typeof p.detail.leadStatus === "string")
      .sort((a, b) => ((a.lastActivityAt ?? "") < (b.lastActivityAt ?? "") ? 1 : -1))
      .map((p) => p.detail.leadStatus as string);
    const inst = c.presences.filter((p) => p.source === "instantly");
    const state = resolvePersonState({
      leadObservations: c.emails.map((e) => standings.observations.get(e)!).filter(Boolean),
      ghlDeals,
      matrixStatuses,
      instantly: inst.length
        ? {
            replied: inst.some((p) => p.detail.replied === true),
            clicked: inst.some((p) => p.detail.clicked === true),
            replyClassification: (inst[0].detail.replyClassification as string | null) ?? null,
          }
        : null,
    });
    return {
      scopeId: scope.id,
      orgId: scope.orgId,
      brandId: scope.brandId,
      personKey: c.personKey,
      identityKeys: c.identityKeys,
      displayName: firstNonNull(c, "displayName"),
      company: firstNonNull(c, "company"),
      emails: c.emails,
      phones: c.phones,
      sources: PEOPLE_SOURCES.filter((s) => c.presences.some((p) => p.source === s)),
      presences: c.presences,
      mergeEvidence: c.evidence.map((e) => ({ kind: e.kind, ref: e.ref, emails: e.emails, phones: e.phones })),
      firstActivityAt: (() => {
        const d = minDate(c.presences.map((p) => p.firstActivityAt));
        return d ? new Date(d) : null;
      })(),
      lastActivityAt: (() => {
        const d = maxDate(c.presences.map((p) => p.lastActivityAt));
        return d ? new Date(d) : null;
      })(),
      state: state.state,
      stateSource: state.stateSource,
      stateDetail: state.stateDetail,
    };
  });

  const summary: BuildSummary = {
    people: rows.length,
    sources: reads.map((r) => ({
      source: r.source,
      status: r.status,
      scope: r.scope,
      presences: r.presences.length,
      sourceCount: r.sourceCount,
      sourceCountBasis: r.sourceCountBasis,
      excludedOwn: filtered.find((f) => f.read.source === r.source)!.excluded,
      error: r.error,
    })),
    evidence: evidenceReads.map((e) => ({
      kind: e.kind,
      status: e.status,
      records: e.evidence.length,
      error: e.error,
    })),
    standing: { asked: standings.asked, reused: standings.reused, failed: standings.failed },
    ownAddresses: { status: own.status, addresses: own.addresses.size, domain: own.domain, error: own.error },
  };

  await db.transaction(async (tx) => {
    await tx.delete(people).where(eq(people.scopeId, scope.id));
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(people).values(rows.slice(i, i + 500));
    }
    await tx
      .update(peopleScopes)
      .set({ status: "built", sourceReads: summary, lastError: null, lastBuiltAt: new Date(), lastRunId: runId })
      .where(eq(peopleScopes.id, scope.id));
  });

  return summary;
}

const building = new Set<string>();

/**
 * One build of one scope under its own ORG run (the org that owns the scope,
 * attributed to the user who opened it). A build already running for the scope
 * in this process is not started twice.
 */
export async function runScopeBuild(scope: PeopleScope): Promise<{ scopeId: string; ok: boolean; summary?: BuildSummary; error?: string; skipped?: boolean }> {
  if (building.has(scope.id)) return { scopeId: scope.id, ok: true, skipped: true };
  building.add(scope.id);
  let runId: string | null = null;
  try {
    const run = await createRun({
      orgId: scope.orgId,
      userId: scope.createdByUserId,
      brandIds: [scope.brandId],
      serviceName: SERVICE_NAME,
      taskName: "people.build",
    });
    runId = run.id;
    const summary = await buildScopePeople(scope, run.id);
    await updateRun(run.id, "completed", { orgId: scope.orgId, userId: scope.createdByUserId });
    console.log(
      `[crm-service] people build scope=${scope.id} brand=${scope.brandId} people=${summary.people} sources=${summary.sources
        .map((s) => `${s.source}:${s.status}:${s.presences}`)
        .join(",")}`,
    );
    return { scopeId: scope.id, ok: true, summary };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[crm-service] people build failed scope=${scope.id}:`, err);
    await db
      .update(peopleScopes)
      .set({ status: "error", lastError: message, lastRunId: runId })
      .where(eq(peopleScopes.id, scope.id));
    if (runId) {
      await updateRun(runId, "failed", { orgId: scope.orgId, userId: scope.createdByUserId }).catch((e) =>
        console.error(`[crm-service] failed to close people build run ${runId}:`, e),
      );
    }
    return { scopeId: scope.id, ok: false, error: message };
  } finally {
    building.delete(scope.id);
  }
}

/** Every scope (or one), one after the other. */
export async function runPeopleBuildPass(scopeId?: string) {
  const scopes = await db
    .select()
    .from(peopleScopes)
    .where(scopeId ? eq(peopleScopes.id, scopeId) : sql`true`);
  const results = [];
  for (const scope of scopes) results.push(await runScopeBuild(scope));
  return { scopes: scopes.length, results };
}

/** The scope for (org, brand), created on first use with its creator recorded. */
export async function ensureScope(orgId: string, brandId: string, userId: string): Promise<{ scope: PeopleScope; created: boolean }> {
  const inserted = await db
    .insert(peopleScopes)
    .values({ orgId, brandId, createdByUserId: userId })
    .onConflictDoNothing({ target: [peopleScopes.orgId, peopleScopes.brandId] })
    .returning();
  if (inserted.length > 0) return { scope: inserted[0], created: true };
  const [scope] = await db
    .select()
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
  return { scope, created: false };
}
