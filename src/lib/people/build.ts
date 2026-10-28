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
import { contacts, leadStandingObservations, people, peopleScopes, type PeopleScope } from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, lazyChildRun, SUPPORT_RUNS, updateRun } from "../runs-client.js";
import {
  clusterPeople,
  keysOf,
  PEOPLE_SOURCES,
  type Evidence,
  type PersonCluster,
  type PeopleSource,
  type Presence,
  presenceFallbackKey,
} from "./identity.js";
import { mapLimit, type SiblingIdentity } from "./siblings.js";
import {
  cachedAnswerIsCurrent,
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
  readBilling,
  readTransactional,
  readOnboarding,
  readManualContacts,
  isGroupOnly,
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
import { judgeNameTwins, readNameTwinEvidence, type NameTwinSummary } from "./name-twins.js";
import { personRelevance, personView, readBrandContext, resolvePeopleRelevance, type PersonView, type RelevanceSummary } from "./relevance.js";
import { leadAddressesFirst, resolvePersonState, type GhlDeal, type LeadObservation, type StripeStandingInput } from "./state.js";
import { indexScopeMessages, type MessageIndexSummary } from "./search.js";
import { type FactEmissionSummary } from "./facts.js";
import { requestEmission } from "./fact-emitter.js";
import { persistPersonIds } from "./person-id.js";
import { visitorLabel } from "../posthog/records.js";
import { readAccountUsers } from "./account-users.js";
import { CONNECTION_TAGS, personConnectionTags, type ConnectionTag, type TagLookups } from "./connection-tags.js";
import { resolveGroupTags, type GroupTags, type GroupTagsSummary } from "./group-tags.js";
import { contactWebsites, overrideDomains, personOrganizations, presenceContactId, resolveOrganizationLookups, websiteOfPresence, type OrganizationsSummary } from "./organizations.js";
import { activeCorrections, applyCorrections, correctionsOf, domainOverrides } from "./corrections.js";
import {
  correctPointTags,
  knownCompanies,
  personRelations,
  readPoints,
  resolvePointCompanies,
  type ContactPointReading,
  type PointOrgSummary,
} from "./relations.js";
import type { DomainKind } from "./organizations.js";
import type { PeopleCorrection } from "../../db/schema.js";
import {
  crmRecordKey,
  humanEvidence,
  recordKeys,
  judgmentId,
  type CrmRecord,
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
  // What the client typed for a contact added by hand (MANUAL-CONTACT-IS-A-PERSON-1024).
  "csv",
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
  /** SAME-HUMAN-TWO-LEADS-1022: people sharing a full name, judged by Jev (people/name-twins.ts). */
  nameTwins?: NameTwinSummary;
  /** CONNECTION-TAGS-1017: the groups' judgments, and how many people carry at least one tag. */
  connectionTags?: GroupTagsSummary & {
    people: number;
    peopleTagged: number;
    peopleUntagged: number;
    byTag: Record<ConnectionTag, number>;
  };
  /** PERSON-ORGANIZATIONS-1017: domains judged, companies resolved, human x organization links made. */
  organizations?: OrganizationsSummary;
  /** PERSON-RELATIONS-1017: contact points whose company Jev was asked about (no evidence of their own). */
  relations?: PointOrgSummary;
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
      // An answer cached before lead-service served `standing.tag`, its
      // Disqualified mark (`disqualification`, null or the mark, now with its
      // `level`) or its company block (`company`, null or the block), is
      // re-asked: an absent value is not "no".
      (!hit.found || cachedAnswerIsCurrent(hit.payload));
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

/** The website a PostHog presence's person typed (sources.ts readPosthog). */
const presenceWebsite = (p: { detail: Record<string, unknown> }) => (typeof p.detail?.website === "string" ? p.detail.website : null);

/**
 * PURE: a cluster of PostHog presences alone that says nothing about who they are: no
 * email, no phone, no name, no website (ONBOARDING-IN-UNIBOX-1015: a visitor who typed
 * their name or website is a person, account or not).
 */
export function isUnnamedPosthogOnly(c: PersonCluster): boolean {
  return (
    c.emails.length === 0 &&
    c.phones.length === 0 &&
    c.presences.every((p) => p.source === "posthog" && !p.displayName?.trim() && !visitorLabel(presenceWebsite(p)))
  );
}

/** PURE: the person's name, else "Visitor from <domain>" when a presence carries the website they typed. */
export function personDisplayName(c: PersonCluster): string | null {
  return firstNonNull(c, "displayName") ?? c.presences.map((p) => visitorLabel(presenceWebsite(p))).find((v) => !!v) ?? null;
}

const CRM_RECORD_SOURCES = new Set<string>(["gohighlevel", "stripe", "posthog", "clerk"]);

/**
 * The CRM record each name-only presence IS (no usable email, phone or handle): provider, the
 * client account (GoHighLevel location, Stripe account, PostHog project, else the connection
 * the record was read through) and the vendor's own record id.
 */
export async function crmRecordsOf(presences: Presence[]): Promise<Map<string, CrmRecord>> {
  const nameOnly = presences.filter(
    (p) =>
      CRM_RECORD_SOURCES.has(p.source) &&
      // No key human-service can hold: an unusable phone (`+1262849`, too short) names nobody either.
      recordKeys({ emails: p.emails, phones: p.phones, handles: (p.keys ?? []).filter((k: string) => k.startsWith("msg:")) }).length === 0 &&
      typeof p.detail.contactId === "string",
  );
  const out = new Map<string, CrmRecord>();
  if (nameOnly.length === 0) return out;
  const ids = [...new Set(nameOnly.map((p) => p.detail.contactId as string))];
  const account = new Map<string, { externalId: string | null; accountId: string | null }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = (await db.execute(sql`
      SELECT c.id, c.external_id,
             COALESCE(g.location_id, s.account_id, ph.project_id, c.source_connection_id::text) AS account_id
      FROM contacts c
      LEFT JOIN ghl_connections g ON c.source = 'gohighlevel' AND g.id = c.source_connection_id
      LEFT JOIN stripe_connections s ON c.source = 'stripe' AND s.id = c.source_connection_id
      LEFT JOIN posthog_connections ph ON c.source = 'posthog' AND ph.id = c.source_connection_id
      WHERE c.id IN (${sql.join(ids.slice(i, i + 1000).map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { id: string; external_id: string | null; account_id: string | null }[];
    for (const r of rows) account.set(r.id, { externalId: r.external_id, accountId: r.account_id });
  }
  for (const p of nameOnly) {
    const a = account.get(p.detail.contactId as string);
    if (!a?.externalId?.trim() || !a.accountId?.trim() || a.accountId.includes(":")) continue;
    out.set(presenceFallbackKey(p), { provider: p.source as CrmRecord["provider"], accountId: a.accountId.trim(), id: a.externalId.trim() });
  }
  return out;
}

/** Every CSV contact of the brand holding an email or a phone, as the keys its row states together. */
export async function readCsvIdentityRecords(orgId: string, brandId: string): Promise<IdentityRecord[]> {
  const rows = await db
    .select({ email: contacts.primaryEmail, phone: contacts.phoneE164 })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.brandId, brandId),
        eq(contacts.source, "csv"),
        sql`(${contacts.primaryEmail} IS NOT NULL OR ${contacts.phoneE164} IS NOT NULL)`,
      ),
    );
  return rows.map((r) => ({ emails: r.email ? [r.email] : [], phones: r.phone ? [r.phone] : [] }));
}

/** Read, merge, resolve, write. Returns what the build saw, per source. */
export async function buildScopePeople(scope: PeopleScope, runId: string): Promise<BuildSummary> {
  const identity: SiblingIdentity = {
    orgId: scope.orgId,
    userId: scope.createdByUserId,
    runId,
    brandId: scope.brandId,
  };
  // LEDGER-CRM-UNDECLARED-1027: identity resolution (domain kinds, same-name twins, a contact point's company) serves every person of the registry,
  // never one lead: its Jev calls ride a child run marked support, opened only when one is made. The build run keeps the
  // lead judgments (relevance, tags), what its lead_identified occurrences cost.
  const identityRun = lazyChildRun(async () => runId, { orgId: scope.orgId, userId: scope.createdByUserId, brandId: scope.brandId }, SUPPORT_RUNS.identityResolution);
  let failed = true;
  try {
    const summary = await buildScopePeopleOn(scope, runId, identity, identityRun.runId);
    failed = false;
    return summary;
  } finally {
    await identityRun.close(failed);
  }
}

async function buildScopePeopleOn(
  scope: PeopleScope,
  runId: string,
  identity: SiblingIdentity,
  identityRunId: () => Promise<string>,
): Promise<BuildSummary> {

  // Before reading Matrix: put on each mirrored WhatsApp contact the phone the
  // bridge says its ghost IS, for every phone the CRM knows (lib/whatsapp/
  // phone-resolution.ts), so this build merges those threads into their person.
  // Never fails the build: a bridge outage leaves today's merge and is retried.
  const whatsappPhones = await resolveBrandWhatsappPhones(scope.orgId, scope.brandId).catch((err) => {
    console.error(`[crm-service] whatsapp phone resolution failed scope=${scope.id}:`, err);
    return { status: "failed" as const, error: (err as Error).message };
  });

  const [rawGmail, rawInstantly, rawMatrix, rawGhl, rawPosthog, rawStripe, rawClerk, rawCopilot, rawApi, rawBilling, rawTransactional, rawOnboarding, rawManual, own] = await Promise.all([
    readGmail(identity),
    readInstantly(identity),
    readMatrix(scope.orgId, scope.brandId),
    readGoHighLevel(scope.orgId, scope.brandId),
    readPosthog(scope.orgId, scope.brandId),
    readStripe(scope.orgId, scope.brandId),
    readAuthUsers(scope.orgId, scope.brandId, "clerk"),
    readCopilot(scope.orgId, scope.brandId),
    readApiCalls(scope.orgId, scope.brandId),
    readBilling(scope.orgId, scope.brandId),
    readTransactional(scope.orgId, scope.brandId),
    readOnboarding(scope.orgId, scope.brandId),
    readManualContacts(scope.orgId, scope.brandId),
    readOwnAddresses(identity),
  ]);
  const filtered = [rawGmail, rawInstantly, rawMatrix, rawGhl, rawPosthog, rawStripe, rawClerk, rawCopilot, rawApi, rawBilling, rawTransactional, rawOnboarding, rawManual].map((r) => withoutOwnAddresses(r, own));
  const reads: SourceRead[] = filtered.map((f) => f.read);
  const [gmail, , , gohighlevel, , stripe] = reads;

  // SAME-HUMAN-TWO-LEADS-1022: two people of the last build sharing a full name are asked to Jev once (one
  // human with two addresses?); a `same` answer is read as evidence just below, so this build already merges them.
  const nameTwins = await judgeNameTwins(scope, identity, identityRunId);
  const evidenceReads: EvidenceRead[] = [
    await readCsvEvidence(scope.orgId, scope.brandId),
    await readWhatsappSendEvidence(scope.orgId, scope.brandId),
    await readStatedMergeEvidence(scope.orgId, scope.brandId),
    await readNameTwinEvidence(scope.orgId, scope.brandId),
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
        : e.kind === "name_twin"
          ? `Jev judged two contacts of the brand sharing a full name to be one human (crm-service same-person verdict ${e.ref})`
          : `lead-service paired the brand's CRM contact ${e.ref} with one of its leads`,
  }));
  // A record a messaging handle alone names (a group member who never wrote) is
  // stated LAST: the long tail of the brand's groups never holds back the rest.
  const handlesOf = (p: (typeof presences)[number]) => (p.keys ?? []).filter((k) => k.startsWith("msg:"));
  const lurker = (p: (typeof presences)[number]) => isGroupOnly([p]) && p.phones.length === 0;
  // HUMAN-RECORD-KEYS-1017: a record of the brand's own tool with no email, phone or handle
  // (a GoHighLevel contact known by a name) is stated by its record id.
  const recordOf = await crmRecordsOf(presences);
  const records: IdentityRecord[] = [
    ...[...presences.filter((p) => !lurker(p)), ...presences.filter(lurker)].map((p) => {
      const crm = recordOf.get(presenceFallbackKey(p));
      return { emails: p.emails, phones: p.phones, handles: handlesOf(p), ...(crm ? { crmRecords: [crm] } : {}) };
    }),
    ...allEvidence.filter((e) => !isJudgment(e)).map((e) => ({ emails: e.emails, phones: e.phones })),
    // HUMAN-ID-COVERAGE-1017: every CSV row too (an imported contact nobody talked to yet is
    // no person of the Unibox, but its facts name a human). Stated last: never holds back the rest.
    ...(await readCsvIdentityRecords(scope.orgId, scope.brandId)),
  ];
  const kindsRead = new Set<Judgment["kind"]>(
    evidenceReads
      .filter((e) => e.status === "ok" && (e.kind === "stated_merge" || e.kind === "lead_pairing" || e.kind === "name_twin"))
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
  // CONNECTION-TAGS-1017: the brand's groups and each member's own posts in them (people/group-tags.ts).
  const viewByContact = new Map<string, PersonView>();
  for (const c of clusters) {
    const view = personView(c);
    for (const p of c.presences) if (p.source === "matrix") viewByContact.set(p.sourceRef, view);
  }
  const groupTags = await (async (): Promise<GroupTags> => {
    try {
      const context = relevance.context ?? (await readBrandContext(identity));
      const users = relevance.users ?? (await readAccountUsers(identity, gmail.status === "ok"));
      return await resolveGroupTags(identity, context, users, (id) => viewByContact.get(id) ?? null);
    } catch (err) {
      const error = (err as Error).message.slice(0, 1000);
      console.error(`[crm-service] group tags failed scope=${scope.id}: ${error}`);
      return { groups: new Map(), posters: new Map(), summary: { status: "failed", groups: 0, posters: 0, judged: 0, reused: 0, error } };
    }
  })();
  const conversationTags: TagLookups["conversations"] = new Map();
  for (const [key, v] of relevance.verdicts) {
    if (v.content === "none") conversationTags.set(key, { noWords: true, userIds: v.userIds });
    else if (v.tags) conversationTags.set(key, { tags: v.tags, scores: v.tagScores, userIds: v.userIds });
  }
  // A direct thread with no message to read is a direct thread with no words (the user wrote to them).
  const gmailUserIds = [...new Set((relevance.users?.gmail ?? []).map((g) => g.user.userId).filter((u): u is string => !!u))].sort();
  for (const key of relevance.nothingToRead) {
    if (!conversationTags.has(key)) conversationTags.set(key, { noWords: true, userIds: key.startsWith("gmail:") ? gmailUserIds : [] });
  }

  // PERSON-ORGANIZATIONS-1017: the companies people speak for (work email domains, CRM websites).
  const websites = await contactWebsites([
    ...new Set(clusters.flatMap((c) => c.presences.map(presenceContactId).filter((id): id is string => !!id))),
  ]);
  const websiteOf = websiteOfPresence(websites);
  const orgLookups = await resolveOrganizationLookups(identity, clusters, websiteOf, identityRunId).catch((err) => {
    const error = (err as Error).message.slice(0, 1000);
    console.error(`[crm-service] organizations failed scope=${scope.id}: ${error}`);
    return null;
  });

  // PEOPLE-CORRECTIONS-1017: what the brand's users stated wins over every automatic answer.
  const corrections = await activeCorrections(scope.orgId, scope.brandId);
  if (orgLookups) overrideDomains(orgLookups.kinds, orgLookups.companyOf, domainOverrides(corrections));

  // A lead-service read that failed may be hiding a lead: never hide on it.
  const isOurLead = (c: PersonCluster) =>
    c.emails.some((e) => {
      const found = standings.observations.get(e)?.found;
      return found === true || found === "error";
    });

  const tagLookupsOf = (c: PersonCluster): TagLookups => ({
    brandId: scope.brandId,
    automated: automated.get(c.personKey)!,
    conversations: conversationTags,
    groups: groupTags.groups,
    posters: groupTags.posters,
  });
  // PERSON-RELATIONS-1017: each contact point read on its own (capacity, company), then grouped.
  const emptyKinds = new Map<string, { kind: DomainKind; confidence: number }>();
  const readingsOf = new Map<string, ContactPointReading[]>();
  const correctionsByPerson = new Map<string, PeopleCorrection[]>();
  for (const c of clusters) {
    const mine = correctionsOf(c.identityKeys, corrections);
    correctionsByPerson.set(c.personKey, mine);
    const raw = readPoints(c.presences, tagLookupsOf(c), orgLookups?.kinds ?? emptyKinds, orgLookups?.companyOf ?? new Map(), websiteOf);
    readingsOf.set(c.personKey, correctPointTags(raw, mine, scope.brandId));
  }
  const pointCompanies = await resolvePointCompanies(
    identity,
    [...readingsOf.values()].map((readings) => ({ readings, known: knownCompanies(readings) })),
    identityRunId,
  ).catch((err) => {
    const error = (err as Error).message.slice(0, 1000);
    console.error(`[crm-service] contact point companies failed scope=${scope.id}: ${error}`);
    return { answers: new Map(), summary: { status: "failed" as const, candidates: 0, reused: 0, judged: 0, error } };
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
      humanId:
        personHumanId(c.identityKeys, humans.humanOf) ??
        personHumanId(
          c.presences.map((p) => recordOf.get(presenceFallbackKey(p))).filter((r): r is CrmRecord => !!r).map(crmRecordKey),
          humans.humanOf,
        ),
      identityKeys: c.identityKeys,
      displayName: personDisplayName(c),
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
        ...(e.kind === "stated_merge" || e.kind === "lead_pairing" || e.kind === "name_twin" ? { heldBy: heldEvidence.includes(e) ? "human-service" : "crm-service" } : {}),
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
      // RELATIONSHIP-TAGS-1014: `notBusiness` hides NOBODY any more (list, search,
      // fact feed all ignore it); who a person is to the brand is lead-service's
      // relationship tag. It only keeps today's serve (no relationship policy)
      // exactly as it was: never wider than before the tags existed.
      ...(automated.get(c.personKey)
        ? { notBusiness: false, offerIds: [] as string[], relevance: null }
        : personRelevance(c, relevance.verdicts, isOurLead(c))),
      groupOnly: isGroupOnly(c.presences),
      ...applyCorrections(
        {
          connectionTags: personConnectionTags(c, tagLookupsOf(c)),
          organizations: orgLookups ? personOrganizations(c, tagLookupsOf(c), orgLookups.kinds, orgLookups.companyOf, websiteOf) : [],
        },
        correctionsOf(c.identityKeys, corrections),
        scope.brandId,
      ),
      possibleLeads: c.presences
        .filter((p) => p.source === "gohighlevel")
        .flatMap((p) => possibleLeadsByCrmContact.get(p.sourceRef) ?? [])
        .filter((h) => !h.email || !c.emails.includes(h.email)),
    };
  });

  const withHuman = rows.filter((r) => r.humanId).length;
  const summary: BuildSummary = {
    whatsappPhones,
    nameTwins,
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
    connectionTags: {
      ...groupTags.summary,
      people: rows.length,
      peopleTagged: rows.filter((r) => r.connectionTags.length > 0).length,
      peopleUntagged: rows.filter((r) => r.connectionTags.length === 0).length,
      byTag: Object.fromEntries(CONNECTION_TAGS.map((t) => [t, rows.filter((r) => r.connectionTags.some((x) => x.tag === t)).length])) as Record<ConnectionTag, number>,
    },
    relations: { ...pointCompanies.summary },
    organizations: orgLookups
      ? {
          status: orgLookups.domainKinds.status === "ok" && orgLookups.companies?.status !== "failed" ? "ok" : "failed",
          domainKinds: orgLookups.domainKinds,
          companies: orgLookups.companies,
          organizations: new Set(rows.flatMap((r) => r.organizations.map((o) => o.companyId))).size,
          links: rows.reduce((n, r) => n + r.organizations.length, 0),
          peopleWithOrganization: rows.filter((r) => r.organizations.length > 0).length,
        }
      : { status: "failed", domainKinds: { status: "failed", domains: 0, reused: 0, judged: 0, pending: 0, error: "lookup failed" }, companies: null, organizations: 0, links: 0, peopleWithOrganization: 0 },
  };

  await db.transaction(async (tx) => {
    // Same person, same opaque id as last build (people/person-id.ts).
    const { ids } = await persistPersonIds(tx, scope.orgId, scope.brandId, rows);
    const withIds = rows.map((r) => {
      const personId = ids.get(r.personKey)!;
      return {
        ...r,
        personId,
        relations: personRelations(personId, readingsOf.get(r.personKey) ?? [], pointCompanies.answers, correctionsByPerson.get(r.personKey) ?? []),
      };
    });
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
  // On a child run marked support (a product feature: re-reading threads produces no outcome, LEDGER-RESIDUAL-1025), so the
  // build run holds only the lead judgments, what its lead_identified occurrences cost.
  let indexRunId: string | null = null;
  try {
    indexRunId = (await createRun({ orgId: scope.orgId, userId: scope.createdByUserId, brandIds: [scope.brandId], ...SUPPORT_RUNS.messageIndex, parentRunId: runId })).id;
    const indexed = await indexScopeMessages(scope, rows, { ...identity, runId: indexRunId }, gmail.status === "ok");
    summary.messageIndex = { status: "ok", ...indexed };
  } catch (err) {
    console.error(`[crm-service] people message index failed scope=${scope.id}:`, err);
    summary.messageIndex = { status: "failed", error: (err as Error).message };
  }
  if (indexRunId) {
    await updateRun(indexRunId, summary.messageIndex.status === "ok" ? "completed" : "failed", { orgId: scope.orgId, userId: scope.createdByUserId }).catch((e) =>
      console.error(`[crm-service] failed to close message index run ${indexRunId}:`, e),
    );
  }

  // Then append to the fact feed what this build changed (lead-service reads it), through the fact
  // emitter (one emission per scope at a time; it also emits on its own when a record moves).
  // Same contract: a failure is recorded beside the build and retried next pass.
  try {
    summary.facts = { status: "ok", ...(await requestEmission(scope)) };
  } catch (err) {
    console.error(`[crm-service] people fact emission failed scope=${scope.id}:`, err);
    summary.facts = { status: "failed", error: (err as Error).message };
  }
  await db.update(peopleScopes).set({ sourceReads: summary }).where(eq(peopleScopes.id, scope.id));

  return summary;
}

const building = new Set<string>();
/** Scopes asked to build again once the running build ends (`followUp`). */
const buildAgain = new Set<string>();

/**
 * One build of one scope under its own ORG run (the org that owns the scope,
 * attributed to the user who opened it). A build already running for the scope
 * in this process is not started twice. `followUp`: the caller learned something
 * the running build may have read too early (a person mirrored mid-build), so ONE
 * more build runs right after it (coalesced, never queued twice).
 */
export async function runScopeBuild(
  scope: PeopleScope,
  opts: { followUp?: boolean } = {},
): Promise<{ scopeId: string; ok: boolean; summary?: BuildSummary; error?: string; skipped?: boolean }> {
  if (building.has(scope.id)) {
    if (opts.followUp) buildAgain.add(scope.id);
    return { scopeId: scope.id, ok: true, skipped: true };
  }
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
    if (buildAgain.delete(scope.id)) void runScopeBuild(scope);
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
