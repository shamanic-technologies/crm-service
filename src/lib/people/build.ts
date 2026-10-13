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

import { resolveBrandWhatsappPhones, type PhoneResolutionResult } from "../whatsapp/phone-resolution.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { leadStandingObservations, people, peopleScopes, type PeopleScope } from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, updateRun } from "../runs-client.js";
import {
  clusterPeople,
  keysOf,
  PEOPLE_SOURCES,
  type Evidence,
  type PersonCluster,
  type PeopleSource,
} from "./identity.js";
import { mapLimit, type SiblingIdentity } from "./siblings.js";
import {
  lookupLeadStanding,
  walkLeadStandings,
  type LeadStandingAnswer,
  readCsvEvidence,
  readWhatsappSendEvidence,
  readStatedMergeEvidence,
  readGmail,
  readGoHighLevel,
  readGoogleContactEvidence,
  readInstantly,
  readLeadPairingEvidence,
  type PossibleLead,
  readMatrix,
  readOwnAddresses,
  readPosthog,
  readStripe,
  readAuthUsers,
  readCopilot,
  readApiCalls,
  withoutOwnAddresses,
  type EvidenceRead,
  type StripeStanding,
  type SourceRead,
} from "./sources.js";
import {
  isAutomatedPerson,
  personVerdicts,
  resolveSenderVerdicts,
  type SenderVerdictSummary,
} from "./automated.js";
import { personRelevance, resolvePeopleRelevance, type RelevanceSummary } from "./relevance.js";
import { leadAddressesFirst, resolvePersonState, type GhlDeal, type LeadObservation, type StripeStandingInput } from "./state.js";
import { indexScopeMessages, type MessageIndexSummary } from "./search.js";
import { emitScopeFacts, type FactEmissionSummary } from "./facts.js";
import { persistPersonIds } from "./person-id.js";
import {
  humanEvidence,
  judgmentId,
  personHumanId,
  resolveScopeHumans,
  type HumanIdentitySummary,
  type IdentityRecord,
  type Judgment,
} from "./humans.js";

/** How long lead-service's answer about an address is reused. */
export const STANDING_TTL_MS = 60 * 60 * 1000;
const STANDING_CONCURRENCY = 6;
/**
 * From this many addresses to ask, lead-service is read in ONE walk of the
 * brand's lead list instead of one search per address (a brand whose cold email
 * wrote to 17.5k people would otherwise make 17.5k searches every hour).
 */
export const standingWalkMin = () => Number(process.env.PEOPLE_STANDING_WALK_MIN) || 200;

/** Display-name / company precedence: the CRM first, then address books, then the rest. */
const NAME_PRECEDENCE: (PeopleSource | Evidence["kind"])[] = [
  "gohighlevel",
  "gohighlevel_contact",
  "lead_pairing",
  "google_contact",
  "stripe",
  "stripe_customer",
  "clerk",
  "copilot",
  "api",
  "matrix",
  "gmail",
  "csv_contact",
  "posthog",
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
  /** Jev's human-vs-automated verdicts: how many reused, judged now, still pending; people hidden. */
  senderVerdicts: SenderVerdictSummary;
  /** Jev's business / brand / offer verdicts on personal-channel conversations; people hidden. */
  relevance?: RelevanceSummary;
  /** The message search index refresh that followed the build (absent until it ran). */
  messageIndex?: ({ status: "ok" } & MessageIndexSummary) | { status: "failed"; error: string };
  /** The fact feed emission that followed (absent until it ran). */
  facts?: ({ status: "ok" } & FactEmissionSummary) | { status: "failed"; error: string };
  /** human-service's answer to "same human?" (people/humans.ts; absent on builds before it existed). */
  humanIdentity?: HumanIdentitySummary & { peopleWithHumanId: number; peopleWithoutHumanId: number };
  /** WhatsApp ghost → phone resolution run before reading Matrix (absent on builds before it existed). */
  whatsappPhones?: PhoneResolutionResult | { status: "failed"; error: string };
}

const NUMBER_IN_NAME = /\d[\d\s().-]{5,}\d/;

export function firstNonNull(
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
  // A "name" carrying a phone number (a WhatsApp chat with a number nobody saved:
  // "+923065554166 (WA)") is a label, not a name: any real name wins over it.
  const numberOnly = (v: string) => (field === "displayName" && NUMBER_IN_NAME.test(v) ? 1 : 0);
  candidates.sort((a, b) => numberOnly(a.value) - numberOnly(b.value) || a.rank - b.rank || (a.value < b.value ? -1 : 1));
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
      (!lastActivity || new Date(lastActivity) <= hit.observedAt) &&
      // An answer cached before lead-service served `standing.tag`, or before it
      // served its Disqualified mark (`disqualification`, null or the mark), is
      // re-asked: an absent mark is not "not disqualified".
      (!hit.found ||
        (typeof (hit.payload as { standing?: { tag?: unknown } } | null)?.standing?.tag === "string" &&
          (hit.payload as { disqualification?: unknown } | null)?.disqualification !== undefined));
    if (fresh) {
      observations.set(email, hit.found ? ({ found: true, email, ...(hit.payload as object) } as LeadObservation) : { found: false });
      reused++;
    } else {
      toAsk.push(email);
    }
  }
  let failed = 0;
  const answers = new Map<string, LeadStandingAnswer | Error>();
  if (toAsk.length >= standingWalkMin()) {
    try {
      for (const [email, answer] of await walkLeadStandings(identity, new Set(toAsk))) answers.set(email, answer);
    } catch (err) {
      for (const email of toAsk) answers.set(email, err as Error);
    }
  } else {
    await mapLimit(toAsk, STANDING_CONCURRENCY, async (email) => {
      try {
        answers.set(email, await lookupLeadStanding(identity, email));
      } catch (err) {
        answers.set(email, err as Error);
      }
    });
  }
  const observedAt = new Date();
  const records: (typeof leadStandingObservations.$inferInsert)[] = [];
  for (const [email, answer] of answers) {
    if (answer instanceof Error) {
      failed++;
      observations.set(email, { found: "error", error: answer.message });
      continue;
    }
    const payload = answer.found ? { ...answer, found: undefined } : null;
    records.push({ orgId: scope.orgId, brandId: scope.brandId, email, found: answer.found, payload, observedAt });
    observations.set(email, answer.found ? { ...answer, email } : { found: false });
  }
  for (let i = 0; i < records.length; i += 500) {
    await db
      .insert(leadStandingObservations)
      .values(records.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [leadStandingObservations.orgId, leadStandingObservations.brandId, leadStandingObservations.email],
        set: { found: sql`excluded.found`, payload: sql`excluded.payload`, observedAt: sql`excluded.observed_at` },
      });
  }
  return { observations, asked: toAsk.length, reused, failed };
}

/** PURE: a cluster of PostHog presences alone, holding no email and no phone. */
export function isUnnamedPosthogOnly(c: PersonCluster): boolean {
  return c.emails.length === 0 && c.phones.length === 0 && c.presences.every((p) => p.source === "posthog");
}

/** Read, merge, resolve, write. Returns what the build saw, per source. */
export async function buildScopePeople(scope: PeopleScope, runId: string): Promise<BuildSummary> {
  const identity: SiblingIdentity = {
    orgId: scope.orgId,
    userId: scope.createdByUserId,
    runId,
    brandId: scope.brandId,
  };

  // Before reading Matrix: put on each mirrored WhatsApp contact the phone the
  // bridge says its ghost IS, for every phone the CRM knows (lib/whatsapp/
  // phone-resolution.ts), so this build merges those threads into their person.
  // Never fails the build: a bridge outage leaves today's merge and is retried.
  const whatsappPhones = await resolveBrandWhatsappPhones(scope.orgId, scope.brandId).catch((err) => {
    console.error(`[crm-service] whatsapp phone resolution failed scope=${scope.id}:`, err);
    return { status: "failed" as const, error: (err as Error).message };
  });

  const [rawGmail, rawInstantly, rawMatrix, rawGhl, rawPosthog, rawStripe, rawClerk, rawCopilot, rawApi, own] = await Promise.all([
    readGmail(identity),
    readInstantly(identity),
    readMatrix(scope.orgId, scope.brandId),
    readGoHighLevel(scope.orgId, scope.brandId),
    readPosthog(scope.orgId, scope.brandId),
    readStripe(scope.orgId, scope.brandId),
    readAuthUsers(scope.orgId, scope.brandId, "clerk"),
    readCopilot(scope.orgId, scope.brandId),
    readApiCalls(scope.orgId, scope.brandId),
    readOwnAddresses(identity),
  ]);
  const filtered = [rawGmail, rawInstantly, rawMatrix, rawGhl, rawPosthog, rawStripe, rawClerk, rawCopilot, rawApi].map((r) => withoutOwnAddresses(r, own));
  const reads: SourceRead[] = filtered.map((f) => f.read);
  const [gmail, , , gohighlevel, , stripe] = reads;

  const evidenceReads: EvidenceRead[] = [
    await readCsvEvidence(scope.orgId, scope.brandId),
    await readWhatsappSendEvidence(scope.orgId, scope.brandId),
    await readStatedMergeEvidence(scope.orgId, scope.brandId),
  ];
  if (gmail.status !== "not_connected") evidenceReads.push(await readGoogleContactEvidence(identity));
  // A pairing lead-service is only GUESSING (`toConfirm`) merges nothing: it rides on the CRM contact as a hint.
  const possibleLeadsByCrmContact = new Map<string, PossibleLead[]>();
  if (gohighlevel.status === "ok") {
    const pairings = await readLeadPairingEvidence(identity);
    evidenceReads.push(pairings);
    for (const h of pairings.possibleLeads) {
      possibleLeadsByCrmContact.set(h.crmContactId, [...(possibleLeadsByCrmContact.get(h.crmContactId) ?? []), h]);
    }
  }
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

  // Likewise a Stripe customer holding an email and a phone.
  const stripeEvidence: Evidence[] = stripe.presences
    .filter((p) => p.emails.length + p.phones.length > 1)
    .map((p) => ({
      kind: "stripe_customer",
      ref: p.sourceRef,
      displayName: p.displayName,
      company: p.company,
      emails: p.emails,
      phones: p.phones,
    }));

  // "Same human?" is human-service's call (people/humans.ts). Every record is
  // stated to it (keys given together = one contact); a judgment (a stated
  // merge, a confident lead-service pairing) is stated as an org-scoped link;
  // its answer comes back as `human_identity` evidence. A judgment it does not
  // hold yet (no email / phone on a side, not resolved yet, human-service down)
  // still ties keys here, as before.
  const presences = reads.flatMap((r) => r.presences);
  const allEvidence = [...ghlEvidence, ...stripeEvidence, ...evidenceReads.flatMap((e) => e.evidence)];
  const isJudgment = (e: Evidence) => !!e.sides && !!e.judgedBy;
  const judgments: Judgment[] = allEvidence.filter(isJudgment).map((e) => ({
    kind: e.kind as Judgment["kind"],
    ref: e.ref,
    sides: e.sides!,
    judgedBy: e.judgedBy!,
    evidence:
      e.kind === "stated_merge"
        ? `Stated in the brand's CRM (crm-service person merge ${e.ref}) that two people are one human`
        : `lead-service paired the brand's CRM contact ${e.ref} with one of its leads`,
  }));
  const records: IdentityRecord[] = [
    ...presences.map((p) => ({ emails: p.emails, phones: p.phones })),
    ...allEvidence.filter((e) => !isJudgment(e)).map((e) => ({ emails: e.emails, phones: e.phones })),
  ];
  const kindsRead = new Set<Judgment["kind"]>(
    evidenceReads
      .filter((e) => e.status === "ok" && (e.kind === "stated_merge" || e.kind === "lead_pairing"))
      .map((e) => e.kind as Judgment["kind"]),
  );
  const humans = await resolveScopeHumans(scope, records, judgments, kindsRead);
  const heldEvidence = allEvidence.filter((e) => isJudgment(e) && humans.heldJudgments.has(judgmentId({ kind: e.kind as Judgment["kind"], ref: e.ref })));
  const buildKeys = new Set<string>();
  for (const x of [...presences, ...allEvidence]) for (const k of keysOf(x, null)) buildKeys.add(k);

  // A PostHog person PostHog holds no email for, whom no other record names by
  // their user id, says nothing about who they are: nobody to show (their
  // facts are held). Once the brand's auth provider names them, they join.
  const clusters = clusterPeople(presences, [
    ...allEvidence.filter((e) => !heldEvidence.includes(e)),
    ...humanEvidence(buildKeys, humans.humanOf),
  ]).filter((c) => !isUnnamedPosthogOnly(c));
  // A judgment human-service holds no longer ties keys here, but it still
  // describes the person (name, "a CRM contact paired with a lead" = business).
  for (const e of heldEvidence) {
    const ks = new Set(keysOf(e, null));
    for (const c of clusters) if (c.identityKeys.some((k) => ks.has(k))) c.evidence.push(e);
  }

  // lead-service is asked about every address of every person.
  const wanted = new Map<string, string | null>();
  for (const c of clusters) {
    const last = maxDate(c.presences.map((p) => p.lastActivityAt));
    for (const e of c.emails) wanted.set(e, last);
  }
  const standings = await observeStandings(scope, identity, wanted);

  // Jev says which addresses are automated senders (judged once per address, recorded).
  const senders = await resolveSenderVerdicts(clusters, identity, gmail.status === "ok");

  // Jev says which personal-channel conversations (Gmail, Matrix) are about THIS
  // brand and which offer (judged once per conversation, recorded). An automated
  // sender is already hidden: not judged.
  const automated = new Map(clusters.map((c) => [c.personKey, isAutomatedPerson(c, senders.verdicts)]));
  const relevance = await resolvePeopleRelevance(
    identity,
    clusters.filter((c) => !automated.get(c.personKey)),
    gmail.status === "ok",
  );
  // A lead-service read that failed may be hiding a lead: never hide on it.
  const isOurLead = (c: PersonCluster) =>
    c.emails.some((e) => {
      const found = standings.observations.get(e)?.found;
      return found === true || found === "error";
    });

  const rows = clusters.map((c) => {
    const ghlDeals: GhlDeal[] = c.presences
      .filter((p) => p.source === "gohighlevel")
      .flatMap((p) => (p.detail.deals as GhlDeal[]) ?? []);
    const matrixStatuses = c.presences
      .filter((p) => p.source === "matrix" && typeof p.detail.leadStatus === "string")
      .sort((a, b) => ((a.lastActivityAt ?? "") < (b.lastActivityAt ?? "") ? 1 : -1))
      .map((p) => p.detail.leadStatus as string);
    const inst = c.presences.filter((p) => p.source === "instantly");
    const stripeStandings: StripeStandingInput[] = c.presences
      .filter((p) => p.source === "stripe")
      .map((p) => ({ customerId: p.detail.externalId as string, ...(p.detail.stripe as StripeStanding) }));
    const state = resolvePersonState({
      leadObservations: c.emails.map((e) => standings.observations.get(e)!).filter(Boolean),
      ghlDeals,
      stripe: stripeStandings,
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
      humanId: personHumanId(c.identityKeys, humans.humanOf),
      identityKeys: c.identityKeys,
      displayName: firstNonNull(c, "displayName"),
      company: firstNonNull(c, "company"),
      emails: leadAddressesFirst(c.emails, standings.observations),
      phones: c.phones,
      sources: PEOPLE_SOURCES.filter((s) => c.presences.some((p) => p.source === s)),
      presences: c.presences,
      mergeEvidence: c.evidence.map((e) => ({
        kind: e.kind,
        ref: e.ref,
        emails: e.emails,
        phones: e.phones,
        ...(e.keys ? { keys: e.keys } : {}),
        ...(e.kind === "stated_merge" || e.kind === "lead_pairing" ? { heldBy: heldEvidence.includes(e) ? "human-service" : "crm-service" } : {}),
      })),
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
      automated: automated.get(c.personKey)!,
      automatedVerdict: c.emails.length ? personVerdicts(c.emails, senders.verdicts) : null,
      ...(automated.get(c.personKey)
        ? { notBusiness: false, offerIds: [] as string[], relevance: null }
        : personRelevance(c, relevance.verdicts, isOurLead(c))),
      possibleLeads: c.presences
        .filter((p) => p.source === "gohighlevel")
        .flatMap((p) => possibleLeadsByCrmContact.get(p.sourceRef) ?? [])
        .filter((h) => !h.email || !c.emails.includes(h.email)),
    };
  });

  const withHuman = rows.filter((r) => r.humanId).length;
  const summary: BuildSummary = {
    whatsappPhones,
    humanIdentity: { ...humans.summary, peopleWithHumanId: withHuman, peopleWithoutHumanId: rows.length - withHuman },
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
    senderVerdicts: { ...senders.summary, automatedPeople: rows.filter((r) => r.automated).length },
    relevance: { ...relevance.summary, notBusinessPeople: rows.filter((r) => r.notBusiness).length },
  };

  await db.transaction(async (tx) => {
    // Same person, same opaque id as last build (people/person-id.ts).
    const { ids } = await persistPersonIds(tx, scope.orgId, scope.brandId, rows);
    const withIds = rows.map((r) => ({ ...r, personId: ids.get(r.personKey)! }));
    await tx.delete(people).where(eq(people.scopeId, scope.id));
    for (let i = 0; i < withIds.length; i += 500) {
      await tx.insert(people).values(withIds.slice(i, i + 500));
    }
    await tx
      .update(peopleScopes)
      .set({ status: "built", sourceReads: summary, lastError: null, lastBuiltAt: new Date(), lastRunId: runId })
      .where(eq(peopleScopes.id, scope.id));
  });

  // The people are live; now bring the message search index up to date with them.
  // Its failure does not undo the build: it is recorded beside it and retried next pass.
  try {
    // A person hidden as not about the brand keeps no copy of their messages in our index.
    const indexed = await indexScopeMessages(scope, rows.filter((r) => !r.notBusiness), identity, gmail.status === "ok");
    summary.messageIndex = { status: "ok", ...indexed };
  } catch (err) {
    console.error(`[crm-service] people message index failed scope=${scope.id}:`, err);
    summary.messageIndex = { status: "failed", error: (err as Error).message };
  }

  // Then append to the fact feed what this build changed (lead-service reads it).
  // Same contract: a failure is recorded beside the build and retried next pass.
  try {
    summary.facts = { status: "ok", ...(await emitScopeFacts(scope)) };
  } catch (err) {
    console.error(`[crm-service] people fact emission failed scope=${scope.id}:`, err);
    summary.facts = { status: "failed", error: (err as Error).message };
  }
  await db.update(peopleScopes).set({ sourceReads: summary }).where(eq(peopleScopes.id, scope.id));

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
      `[crm-service] people build scope=${scope.id} brand=${scope.brandId} people=${summary.people} humanIds=${summary.humanIdentity?.peopleWithHumanId}/${summary.people}:${summary.humanIdentity?.status}:+${summary.humanIdentity?.resolved}~${summary.humanIdentity?.pending} automated=${summary.senderVerdicts.automatedPeople} notBusiness=${summary.relevance?.notBusinessPeople} relevanceJudged=${summary.relevance?.judged} relevancePending=${summary.relevance?.pending} judged=${summary.senderVerdicts.judged} pending=${summary.senderVerdicts.pending} facts=${summary.facts?.status === "ok" ? `+${summary.facts.emitted}/-${summary.facts.corrected + summary.facts.withdrawnGone}` : summary.facts?.status} sources=${summary.sources
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
