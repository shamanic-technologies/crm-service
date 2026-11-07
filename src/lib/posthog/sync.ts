/**
 * The PostHog ingestion pass: bronze → silver, for one connection. Read-only
 * toward PostHog; free (PostHog bills by ingestion, not by API read), so no
 * cost is declared — crm-service declares none of its own.
 *
 *  - BRONZE  every identified person (plus every person named by one of the
 *            brand's auth user ids, see client.ts), every visit (session) and every custom
 *            event of an identified person, verbatim in `posthog_raw_records`,
 *            keyed on PostHog's own id. The upsert writes only when the content
 *            hash moved.
 *  - SILVER  persons → `contacts` (source `posthog`), visits + events →
 *            `posthog_activities`, read back from BRONZE, zero LLM.
 *
 * Persons are re-listed in full every 6 h (one keyset query per 5,000, ~0.27 GB each;
 * the fast mirror catches who becomes known in between). Activity is read from a
 * window: everything since the last pass's start minus one hour, so an event PostHog
 * ingested late is still picked up. A person's PAST (anything before the window: a
 * first connection, a person new to us) is the history backlog, read paced
 * (POSTHOG-429-1107: the project's hourly read budget, see client.ts and syncPosthogConnection).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  posthogActivities,
  posthogConnections,
  posthogRawRecords,
  type PosthogConnection,
} from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, updateRun } from "../runs-client.js";
import { resolveBrandCredential } from "../gohighlevel/credentials.js";
import { canonicalHash } from "../gohighlevel/records.js";
import {
  bytesReadLastHour,
  distinctIdsOfPersons,
  holdReads,
  listIdentifiedPersons,
  listKeyEvents,
  listPersonIdsTouchedSince,
  listPersonsByIds,
  listPersonsByDistinctIds,
  listVisits,
  POSTHOG_MAX_PAGES,
  PosthogThrottled,
  type PersonScope,
  type PosthogRegion,
  type PosthogTarget,
} from "./client.js";
import { authUserIds } from "../auth/sync.js";
import { AUTH_PROVIDER_NAMES } from "../auth/providers.js";
import { normalizePhone } from "../people/identity.js";
import {
  BRONZE_MACHINE_VISIT_SQL,
  deriveKeyEvent,
  derivePosthogContact,
  deriveVisit,
  POSTHOG_SOURCE,
  visitId,
  websiteDomain,
  type PosthogRecordKind,
} from "./records.js";

export const POSTHOG_PROVIDER = "posthog";
/** How far before the last pass's start the next pass re-reads activity. */
export const POSTHOG_LATE_INGESTION_MS = 60 * 60 * 1000;
const FIRST_PASS_SINCE = new Date("2000-01-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Every known person is re-listed this often (one full persons read, ~0.27 GB a page of 5,000). */
export const POSTHOG_PERSON_RELIST_MS = Number(process.env.POSTHOG_PERSON_RELIST_MS) || 6 * 60 * 60 * 1000;
/**
 * The history backlog reads only while our reads of the project over the last hour stay under this (bytes PostHog
 * reported). PostHog does not publish the project budget; our steady reads are ~2-3 GB/h (see client.ts), so the
 * backlog adds at most ~2 GB/h on top and the rest of the budget stays for the project's other readers.
 */
export const POSTHOG_BACKFILL_HOURLY_BYTES = Number(process.env.POSTHOG_BACKFILL_HOURLY_BYTES) || 2_000_000_000;
/** Persons per history read (their distinct ids go in one `IN` list). */
const HISTORY_CHUNK = 50;
/** Distinct ids read per person for its history. */
const HISTORY_DISTINCT_IDS = 100;
/** The fast mirror reads at once the history of a person created this recently; older ones go to the backlog. */
const RECENT_PERSON_MS = 7 * DAY_MS;

/** Ids per HogQL `IN (…)` list. */
const ID_CHUNK = 200;
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / ID_CHUNK) }, (_, i) => xs.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK));

export interface PosthogSyncResult {
  connectionId: string;
  runId: string;
  personsMirrored: number;
  /** Of which: not identified in PostHog, mirrored because an auth user id names them. */
  personsByAuthUserId: number;
  /** Persons mirrored for the first time on this pass whose whole history was read. */
  personsBackfilled: number;
  personsChanged: number;
  visitsMirrored: number;
  visitsChanged: number;
  eventsMirrored: number;
  eventsChanged: number;
  contactsDerived: number;
  activitiesDerived: number;
  /** Activities of a machine's session dropped from silver (ROBOTS-NEVER-LEAVE-BRONZE-1028). */
  machineActivitiesDropped: number;
  activitiesLinked: number;
}

async function mirrorBatch(
  conn: PosthogConnection,
  kind: PosthogRecordKind,
  records: Record<string, unknown>[],
  idOf: (r: Record<string, unknown>) => string,
): Promise<string[]> {
  if (records.length === 0) return [];
  const byId = new Map(records.map((r) => [idOf(r), r]));
  const values = [...byId.entries()].map(([externalId, payload]) => ({
    orgId: conn.orgId,
    brandId: conn.brandId,
    connectionId: conn.id,
    kind,
    externalId,
    contentHash: canonicalHash(payload),
    payload,
  }));
  const changed: string[] = [];
  for (let i = 0; i < values.length; i += 500) {
    const rows = await db
      .insert(posthogRawRecords)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [posthogRawRecords.connectionId, posthogRawRecords.kind, posthogRawRecords.externalId],
        set: { contentHash: sql`excluded.content_hash`, payload: sql`excluded.payload`, mirroredAt: new Date() },
        setWhere: sql`${posthogRawRecords.contentHash} <> excluded.content_hash`,
      })
      .returning({ externalId: posthogRawRecords.externalId });
    for (const row of rows) changed.push(row.externalId);
  }
  return changed;
}

async function readBronze(
  conn: PosthogConnection,
  kind: PosthogRecordKind,
  externalIds?: string[],
): Promise<Record<string, unknown>[]> {
  const base = [eq(posthogRawRecords.connectionId, conn.id), eq(posthogRawRecords.kind, kind)];
  const read = async (ids?: string[]) =>
    (
      await db
        .select({ payload: posthogRawRecords.payload })
        .from(posthogRawRecords)
        .where(and(...base, ...(ids ? [inArray(posthogRawRecords.externalId, ids)] : [])))
    ).map((r) => r.payload as Record<string, unknown>);
  if (!externalIds) return read();
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < externalIds.length; i += 1000) out.push(...(await read(externalIds.slice(i, i + 1000))));
  return out;
}

/**
 * Bronze persons whose silver contact is missing or older than the mirror. Bronze and
 * silver are written in separate steps: a pass that dies between them (a vendor read
 * failing, a restart) leaves a person mirrored but never derived, and the no-churn
 * upsert never reports it as changed again, so the changed-only derive never retried
 * it (2026-10-17: a paying client's PostHog person, mirrored at signup, had no contact,
 * so their onboarding steps reached no thread). Every derive heals these too.
 *
 * Also a contact whose stored signup verdict (records.ts notSignup) no longer matches its
 * bronze: an account appeared (the brand's auth provider mirrored the user AFTER the person)
 * or the rule moved (POSTHOG-EMAIL-NOT-SIGNUP-1024: an email alone is no signup). Neither
 * moves the person's bronze, so nothing else would re-derive them.
 */
async function personsBehindSilver(conn: PosthogConnection): Promise<string[]> {
  const authSources = sql.join(AUTH_PROVIDER_NAMES.map((n) => sql`${n}`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT r.external_id FROM posthog_raw_records r
    LEFT JOIN contacts c
      ON c.org_id = r.org_id AND c.brand_id = r.brand_id AND c.source = ${POSTHOG_SOURCE} AND c.external_id = r.external_id
    WHERE r.connection_id = ${conn.id} AND r.kind = 'person'
      AND (
        c.id IS NULL OR c.last_rebuilt_at < r.mirrored_at
        OR (coalesce(c.raw_attributes->>'notSignup', 'false') = 'true') = (
          coalesce(r.payload->>'is_identified', '') IN ('1', 'true')
          OR EXISTS (
            SELECT 1 FROM contacts a
            WHERE a.org_id = r.org_id AND a.brand_id = r.brand_id AND a.source IN (${authSources})
              AND jsonb_typeof(r.payload->'distinct_ids') = 'array'
              AND (r.payload->'distinct_ids') ? a.external_id
          )
        )
      )
  `)) as unknown as { external_id: string }[];
  return rows.map((r) => r.external_id);
}

async function deriveContacts(conn: PosthogConnection, externalIds?: string[]): Promise<number> {
  const now = new Date();
  let derived = 0;
  const ids = externalIds ? [...new Set([...externalIds, ...(await personsBehindSilver(conn))])] : undefined;
  if (ids && ids.length === 0) return 0;
  // A person named by an auth provider's user id has an account (records.ts notSignup).
  const authIds = new Set(await authUserIds(conn.orgId, conn.brandId));
  for (const payload of await readBronze(conn, "person", ids)) {
    const c = derivePosthogContact(payload, authIds);
    if (!c) continue;
    const fields = {
      primaryEmail: c.primaryEmail,
      // A number typed with no country (no `+`) is no international phone: kept in raw_attributes only.
      phoneE164: c.phones.map((p) => normalizePhone(p)).find((p) => !!p) ?? null,
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
      rawAttributes: { distinctIds: c.distinctIds, phones: c.phones, phoneOnly: c.phoneOnly, notSignup: c.notSignup, website: c.website },
      // The website the person typed is their company's (WA-THREAD-IDENTITY-1023): the canonical
      // columns every source's company evidence reads (people/organizations.ts), never raw only.
      website: c.website,
      companyDomain: websiteDomain(c.website),
      sourceCreatedAt: c.sourceCreatedAt,
      sourceConnectionId: conn.id,
      lastRebuiltAt: now,
    };
    await db
      .insert(contacts)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        ...fields,
        consentStatus: "unknown",
        unsubscribed: false,
        source: POSTHOG_SOURCE,
        externalId: c.externalId,
      })
      .onConflictDoUpdate({
        target: [contacts.orgId, contacts.brandId, contacts.source, contacts.externalId],
        set: fields,
      });
    derived++;
  }
  return derived;
}

async function deriveActivities(
  conn: PosthogConnection,
  kind: "visit" | "event",
  externalIds?: string[],
): Promise<number> {
  const now = new Date();
  let derived = 0;
  const machines = await machineSessions(conn);
  for (const payload of await readBronze(conn, kind, externalIds)) {
    const a = kind === "visit" ? deriveVisit(payload) : deriveKeyEvent(payload);
    if (!a) continue;
    const sessionId = (a.detail as { sessionId?: string | null }).sessionId;
    if (sessionId && machines.has(`${sessionId}:${a.externalPersonId}`)) continue;
    const fields = {
      externalPersonId: a.externalPersonId,
      occurredAt: a.occurredAt,
      endedAt: a.endedAt,
      name: a.name,
      url: a.url,
      pageviews: a.pageviews,
      detail: a.detail,
      lastRebuiltAt: now,
    };
    await db
      .insert(posthogActivities)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        connectionId: conn.id,
        kind: a.kind,
        externalId: a.externalId,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [posthogActivities.connectionId, posthogActivities.kind, posthogActivities.externalId],
        set: fields,
      });
    derived++;
  }
  return derived;
}

/**
 * ROBOTS-NEVER-LEAVE-BRONZE-1028 (owner 2026-10-28: « Les robots ne sont pas des clics, ils ne doivent même pas
 * arriver sur l'unibox ni nulle part, ils doivent être filtrés direct »): the sessions (`<session>:<person>`, the
 * visit's bronze id) a MACHINE made, read off bronze (`BRONZE_MACHINE_VISIT_SQL`, records.ts `visitMachine`). Such a
 * session stays in bronze only: neither its visit nor any event fired in it is written to silver, so no fact, no
 * timeline item, no count ever reads it.
 */
async function machineSessions(conn: PosthogConnection): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT payload->>'session_id' AS session_id, payload->>'person_id' AS person_id
    FROM posthog_raw_records
    WHERE connection_id = ${conn.id} AND kind = 'visit' AND ${sql.raw(BRONZE_MACHINE_VISIT_SQL("payload"))}
  `)) as unknown as { session_id: string | null; person_id: string | null }[];
  return new Set(rows.filter((r) => r.session_id && r.person_id).map((r) => `${r.session_id}:${r.person_id}`));
}

/**
 * Drop from silver every activity of a machine's session: one written before its visit was read (an event the fast
 * mirror took first), or before the fingerprint existed. Runs after each derivation, so it is also the cleanup of
 * what earlier code wrote. Their live facts are withdrawn `machine_visit` by the next emission (people/facts.ts).
 */
async function dropMachineActivities(conn: PosthogConnection): Promise<number> {
  const rows = await db.execute(sql`
    DELETE FROM posthog_activities a
    USING posthog_raw_records r
    WHERE a.connection_id = ${conn.id} AND r.connection_id = ${conn.id} AND r.kind = 'visit'
      AND ${sql.raw(BRONZE_MACHINE_VISIT_SQL("r.payload"))}
      AND a.external_person_id = r.payload->>'person_id'
      AND a.detail->>'sessionId' = r.payload->>'session_id'
    RETURNING a.id
  `);
  return (rows as unknown as unknown[]).length;
}

/**
 * Attach every unattached activity to its person's silver contact. An activity
 * can arrive before its person is mirrored (or the person can be identified
 * later); this is what links them once both exist, touching only the rows
 * that move.
 */
async function linkActivities(conn: PosthogConnection): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE posthog_activities a SET contact_id = c.id
    FROM contacts c
    WHERE a.connection_id = ${conn.id} AND a.contact_id IS NULL
      AND c.source = ${POSTHOG_SOURCE} AND c.source_connection_id = ${conn.id}
      AND c.external_id = a.external_person_id
    RETURNING a.id
  `);
  return (rows as unknown as unknown[]).length;
}

export function targetOf(conn: Pick<PosthogConnection, "region" | "projectId">, apiKey: string): PosthogTarget {
  return { region: conn.region as PosthogRegion, projectId: conn.projectId, apiKey };
}

/** What the full pass did besides mirroring (POSTHOG-429-1107). */
export interface PosthogPassState {
  /** The window of activity since the last pass was read whole (syncedThrough advanced). */
  windowRead: boolean;
  /** Every known person was re-listed on this pass (every `POSTHOG_PERSON_RELIST_MS`). */
  personsListed: boolean;
  /** Persons whose whole history this pass read, and those still waiting for it. */
  historyRead: number;
  historyBacklog: number;
  /** PostHog refused a read (project read budget used up): when it said reads come back. Null = never refused. */
  waitingUntil: string | null;
  /** Bytes our reads of this project made PostHog scan in the last hour, as PostHog reported them. */
  bytesReadLastHour: number;
}

/** Record that PostHog refused reads: a wait, never an error, never a pause (POSTHOG-429-1107). */
export async function recordPosthogThrottle(connectionId: string, err: PosthogThrottled): Promise<void> {
  await db
    .update(posthogConnections)
    .set({
      rateLimitedUntil: err.retryAt,
      rateLimitedSince: sql`coalesce(${posthogConnections.rateLimitedSince}, now())`,
      rateLimitMessage: err.vendorMessage,
      status: sql`CASE WHEN ${posthogConnections.status} = 'paused' THEN 'paused' ELSE 'active' END`,
      lastError: sql`CASE WHEN ${posthogConnections.status} = 'paused' THEN ${posthogConnections.lastError} ELSE NULL END`,
    })
    .where(eq(posthogConnections.id, connectionId));
}

export interface PosthogSyncView {
  state: "up_to_date" | "catching_up" | "first_sync" | "failed" | "paused";
  reason: "posthog_read_budget" | "reading_history" | null;
  retryAt: string | null;
  waitingSince: string | null;
  behindSince: string | null;
  historyBacklog: number | null;
  message: string | null;
}

/**
 * PURE (POSTHOG-429-1107): what a connection tells the client. A read-budget wait is `catching_up` (we are behind on
 * purpose, retrying at `retryAt`), never `failed`: `failed` is only a real failure (bad key, wrong project).
 */
export function posthogSyncState(
  row: Pick<PosthogConnection, "status" | "lastError" | "lastSyncedAt" | "syncedThrough" | "rateLimitedUntil" | "rateLimitedSince" | "rateLimitMessage">,
  historyBacklog: number | null,
  now = Date.now(),
): PosthogSyncView {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const base = {
    reason: null,
    retryAt: null,
    waitingSince: null,
    behindSince: iso(row.syncedThrough),
    historyBacklog,
    message: null,
  };
  if (row.status === "paused") return { ...base, state: "paused" };
  if (row.status === "error") return { ...base, state: "failed", message: row.lastError };
  if (row.rateLimitedSince || row.rateLimitedUntil) {
    return {
      ...base,
      state: "catching_up",
      reason: "posthog_read_budget",
      retryAt: row.rateLimitedUntil && row.rateLimitedUntil.getTime() > now ? iso(row.rateLimitedUntil) : null,
      waitingSince: iso(row.rateLimitedSince),
      message: row.rateLimitMessage,
    };
  }
  if (!row.lastSyncedAt) return { ...base, state: "first_sync" };
  if (historyBacklog && historyBacklog > 0) return { ...base, state: "catching_up", reason: "reading_history" };
  return { ...base, state: "up_to_date" };
}

/** Persons still waiting for their history, per connection. */
export async function historyBacklogs(connectionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of connectionIds) out.set(id, await countHistoryBacklog(id));
  return out;
}

/** PURE: the stored refusal still holds at `now` (no read may be sent). */
export function waitingForBudget(conn: Pick<PosthogConnection, "rateLimitedUntil">, now = Date.now()): Date | null {
  return conn.rateLimitedUntil && conn.rateLimitedUntil.getTime() > now ? conn.rateLimitedUntil : null;
}

interface KnownPerson {
  id: string;
  createdAt: string | null;
  historyReadAt: Date | null;
}

async function knownPersons(conn: PosthogConnection, ids?: string[]): Promise<Map<string, KnownPerson>> {
  if (ids && ids.length === 0) return new Map();
  const only = ids ? sql`AND external_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql``;
  const rows = (await db.execute(sql`
    SELECT external_id, payload->>'created_at' AS created_at, history_read_at
    FROM posthog_raw_records WHERE connection_id = ${conn.id} AND kind = 'person' ${only}
  `)) as unknown as { external_id: string; created_at: string | null; history_read_at: Date | string | null }[];
  return new Map(
    rows.map((r) => [
      r.external_id,
      { id: r.external_id, createdAt: r.created_at, historyReadAt: r.history_read_at ? new Date(r.history_read_at) : null },
    ]),
  );
}

/**
 * Read the WHOLE visit + event history of these persons (each mirrored without it: new to us, or mirrored while
 * PostHog refused reads), scoped by their distinct ids and dated from the earliest creation among them minus a day:
 * the events table is sorted by day then distinct id, so this reads only their granules (never the persons table).
 * Marks each person's `history_read_at` once both reads went through.
 */
async function readHistory(
  conn: PosthogConnection,
  target: PosthogTarget,
  persons: KnownPerson[],
  out: { visits: string[]; events: string[] },
): Promise<void> {
  const ids = persons.map((p) => p.id);
  const distinct = await distinctIdsOfPersons(target, ids, HISTORY_DISTINCT_IDS);
  const distinctIds = [...new Set([...distinct.values()].flat())];
  if (distinctIds.length > 0) {
    const created = persons.map((p) => (p.createdAt ? Date.parse(p.createdAt) : NaN));
    const earliest = created.some((t) => Number.isNaN(t)) ? FIRST_PASS_SINCE : new Date(Math.min(...created) - DAY_MS);
    const mine = new Set(ids);
    const scope: PersonScope = { kind: "distinctIds", ids: distinctIds };
    for await (const page of listVisits(target, earliest, scope)) {
      out.visits.push(...(await mirrorBatch(conn, "visit", page.filter((r) => mine.has(String(r.person_id))), visitId)));
    }
    for await (const page of listKeyEvents(target, earliest, scope)) {
      out.events.push(...(await mirrorBatch(conn, "event", page.filter((r) => mine.has(String(r.person_id))), (r) => String(r.id))));
    }
  }
  await db
    .update(posthogRawRecords)
    .set({ historyReadAt: new Date() })
    .where(and(eq(posthogRawRecords.connectionId, conn.id), eq(posthogRawRecords.kind, "person"), inArray(posthogRawRecords.externalId, ids)));
}

/** Persons still waiting for their history, newest first (a recent visitor matters most). */
async function historyBacklog(conn: PosthogConnection, limit: number): Promise<KnownPerson[]> {
  const rows = (await db.execute(sql`
    SELECT external_id, payload->>'created_at' AS created_at
    FROM posthog_raw_records
    WHERE connection_id = ${conn.id} AND kind = 'person' AND history_read_at IS NULL
    ORDER BY payload->>'created_at' DESC NULLS LAST, external_id
    LIMIT ${limit}
  `)) as unknown as { external_id: string; created_at: string | null }[];
  return rows.map((r) => ({ id: r.external_id, createdAt: r.created_at, historyReadAt: null }));
}

async function countHistoryBacklog(connectionId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM posthog_raw_records
    WHERE connection_id = ${connectionId} AND kind = 'person' AND history_read_at IS NULL
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/**
 * One full pass for one connection (POSTHOG-429-1107: inside the project's hourly read budget, on its own).
 *  1. persons re-listed only every `POSTHOG_PERSON_RELIST_MS` (6 h; the fast mirror catches who becomes known within
 *     a minute in between);
 *  2. the activity window since the last pass, read with NO persons filter and kept for the persons we hold;
 *  3. the history backlog (persons whose history was never read), paced: only while our reads of this project in the
 *     last hour stay under `POSTHOG_BACKFILL_HOURLY_BYTES`, the rest next pass;
 *  4. silver from what moved.
 * A 429 at any step stops the reads, keeps what was mirrored (derived like any pass), records when PostHog said reads
 * come back (`rate_limited_until`), and leaves the connection `active`: a wait, never an error.
 */
export async function syncPosthogConnection(
  conn: PosthogConnection,
  rereadSince?: Date,
): Promise<PosthogSyncResult & { state: PosthogPassState }> {
  const startedAt = new Date();
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "posthog.sync",
  });
  const identity = { orgId: conn.orgId, userId: conn.createdByUserId, runId: run.id, brandIds: [conn.brandId] };
  try {
    const apiKey = await resolveBrandCredential(POSTHOG_PROVIDER, "PostHog", conn.brandId, {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
    });
    const target = targetOf(conn, apiKey);
    const stored = waitingForBudget(conn, startedAt.getTime());
    if (stored) holdReads(target, stored);
    // A first pass reads the last day; every person's history comes through the backlog, paced.
    const windowed = conn.syncedThrough
      ? new Date(conn.syncedThrough.getTime() - POSTHOG_LATE_INGESTION_MS)
      : new Date(startedAt.getTime() - DAY_MS);
    // A re-read asked from an earlier instant (POSTHOG-SCANNER-VISIT-1025 backfill) widens the window, never narrows it.
    const since = rereadSince && rereadSince < windowed ? rereadSince : windowed;

    let throttle: PosthogThrottled | null = null;
    const step = async (fn: () => Promise<void>) => {
      if (throttle) return;
      try {
        await fn();
      } catch (err) {
        if (err instanceof PosthogThrottled) throttle = err;
        else throw err;
      }
    };

    const persons = { mirrored: 0, changed: [] as string[], listed: [] as string[] };
    const byAuthId = new Set<string>();
    let personsListed = false;
    const relistDue =
      !conn.personsListedAt || startedAt.getTime() - conn.personsListedAt.getTime() >= POSTHOG_PERSON_RELIST_MS;
    if (relistDue) {
      await step(async () => {
        for await (const page of listIdentifiedPersons(target)) {
          persons.mirrored += page.length;
          persons.listed.push(...page.map((r) => String(r.id)));
          persons.changed.push(...(await mirrorBatch(conn, "person", page, (r) => String(r.id))));
        }
        personsListed = true;
      });
    }
    // Persons named by the brand's auth user ids, every pass: two small reads (~18 MB), a signup's PostHog person
    // joins its user within one pass even when nothing made it known in PostHog.
    await step(async () => {
      for (const ids of chunks(await authUserIds(conn.orgId, conn.brandId))) {
        const page = await listPersonsByDistinctIds(target, ids);
        for (const r of page) byAuthId.add(String(r.id));
        persons.listed.push(...page.map((r) => String(r.id)));
        persons.changed.push(...(await mirrorBatch(conn, "person", page, (r) => String(r.id))));
      }
      persons.mirrored += byAuthId.size;
    });

    // A stream that hit the page ceiling stopped early: the next pass must
    // resume from the last row it actually read, not from this pass's start.
    let resumeFrom: Date | null = null;
    let windowRead = false;
    // A refusal half-way through the window keeps what was read: the next pass resumes from the last row of the
    // stream that stopped (never the whole gap again, so a long gap is crossed in steps). null = no row read.
    let partialThrough: Date | null = null;
    let visitsDone = false;
    let lastEventAt: Date | null = null;
    const visits = { mirrored: 0, changed: [] as string[] };
    const events = { mirrored: 0, changed: [] as string[] };
    await step(async () => {
      const held = await knownPersons(conn);
      const ours = (page: Record<string, unknown>[]) => page.filter((r) => held.has(String(r.person_id)));
      const capped = (n: number, at: unknown) => {
        if (n < POSTHOG_MAX_PAGES || typeof at !== "string") return;
        const d = new Date(at);
        if (!resumeFrom || d < resumeFrom) resumeFrom = d;
      };
      let pages = 0;
      let last: unknown = null;
      for await (const page of listVisits(target, since, { kind: "window" })) {
        pages++;
        last = page[page.length - 1].started_at;
        const kept = ours(page);
        visits.mirrored += kept.length;
        visits.changed.push(...(await mirrorBatch(conn, "visit", kept, visitId)));
      }
      capped(pages, last);
      visitsDone = true;
      pages = 0;
      last = null;
      for await (const page of listKeyEvents(target, since, { kind: "window" })) {
        pages++;
        last = page[page.length - 1].timestamp;
        lastEventAt = new Date(String(last));
        const kept = ours(page);
        events.mirrored += kept.length;
        events.changed.push(...(await mirrorBatch(conn, "event", kept, (r) => String(r.id))));
      }
      capped(pages, last);
      windowRead = true;
    });
    // Visits are cheap (~12 MB a day) and read first: only an events stream stopped half-way moves the window.
    if (!windowRead && throttle && visitsDone) partialThrough = lastEventAt;

    let historyRead = 0;
    const history = { visits: [] as string[], events: [] as string[] };
    await step(async () => {
      while (bytesReadLastHour(target) < POSTHOG_BACKFILL_HOURLY_BYTES) {
        const due = await historyBacklog(conn, HISTORY_CHUNK);
        if (due.length === 0) break;
        await readHistory(conn, target, due, history);
        historyRead += due.length;
      }
    });
    visits.changed.push(...history.visits);
    events.changed.push(...history.events);

    const contactsDerived = await deriveContacts(conn, persons.changed);
    const activitiesDerived =
      (await deriveActivities(conn, "visit", visits.changed)) + (await deriveActivities(conn, "event", events.changed));
    const machineActivitiesDropped = await dropMachineActivities(conn);
    const activitiesLinked = await linkActivities(conn);

    const refused = throttle as PosthogThrottled | null;
    await db
      .update(posthogConnections)
      .set({
        status: sql`CASE WHEN ${posthogConnections.status} = 'paused' THEN 'paused' ELSE 'active' END`,
        lastError: null,
        lastRunId: run.id,
        ...(windowRead ? { lastSyncedAt: new Date(), syncedThrough: resumeFrom ?? startedAt } : {}),
        // `syncedThrough - 1h` is where the next window starts: one past the last row read, never before the old one.
        ...(!windowRead && partialThrough && (partialThrough as Date).getTime() > since.getTime()
          ? { syncedThrough: new Date((partialThrough as Date).getTime() + POSTHOG_LATE_INGESTION_MS) }
          : {}),
        ...(personsListed ? { personsListedAt: startedAt } : {}),
        ...(refused
          ? {
              rateLimitedUntil: refused.retryAt,
              rateLimitedSince: sql`coalesce(${posthogConnections.rateLimitedSince}, now())`,
              rateLimitMessage: refused.vendorMessage,
            }
          : { rateLimitedUntil: null, rateLimitedSince: null, rateLimitMessage: null }),
      })
      .where(eq(posthogConnections.id, conn.id));
    await updateRun(run.id, "completed", identity);
    if (refused) {
      console.log(
        `[crm-service][posthog] ${conn.id}: PostHog's read budget is used up, next read at ${refused.retryAt.toISOString()} (kept what was read)`,
      );
    }
    return {
      connectionId: conn.id,
      runId: run.id,
      personsMirrored: persons.mirrored,
      personsByAuthUserId: byAuthId.size,
      personsBackfilled: historyRead,
      personsChanged: persons.changed.length,
      visitsMirrored: visits.mirrored,
      visitsChanged: visits.changed.length,
      eventsMirrored: events.mirrored,
      eventsChanged: events.changed.length,
      contactsDerived,
      activitiesDerived,
      machineActivitiesDropped,
      activitiesLinked,
      state: {
        windowRead,
        personsListed,
        historyRead,
        historyBacklog: await countHistoryBacklog(conn.id),
        waitingUntil: refused ? refused.retryAt.toISOString() : null,
        bytesReadLastHour: bytesReadLastHour(target),
      },
    };
  } catch (err) {
    await db
      .update(posthogConnections)
      .set({ status: "error", lastError: (err as Error).message, lastRunId: run.id })
      .where(eq(posthogConnections.id, conn.id));
    await updateRun(run.id, "failed", identity).catch((e) =>
      console.error("[crm-service][posthog] failed to close run:", e),
    );
    throw err;
  }
}

/**
 * Every active connection (or one). Failures are recorded AND returned, never swallowed. A connection PostHog asked
 * to wait (`rate_limited_until` ahead) is not read at all, no run opened: `deferred`, with when it is read next.
 */
export async function runPosthogSyncPass(connectionId?: string, rereadSince?: Date) {
  const where = connectionId
    ? eq(posthogConnections.id, connectionId)
    : inArray(posthogConnections.status, ["active", "error"]);
  const connections = await db.select().from(posthogConnections).where(where);
  const results: (PosthogSyncResult & { state: PosthogPassState })[] = [];
  const failures: { connectionId: string; error: string }[] = [];
  const deferred: { connectionId: string; waitingUntil: string }[] = [];
  for (const conn of connections) {
    if (conn.status === "paused") continue;
    const waiting = waitingForBudget(conn);
    if (waiting) {
      deferred.push({ connectionId: conn.id, waitingUntil: waiting.toISOString() });
      continue;
    }
    try {
      results.push(await syncPosthogConnection(conn, rereadSince));
    } catch (err) {
      console.error(`[crm-service][posthog] sync failed for connection ${conn.id}:`, err);
      failures.push({ connectionId: conn.id, error: (err as Error).message });
    }
  }
  return { connections: connections.length, results, failures, deferred };
}

/** Re-derive all silver from bronze alone — no PostHog call, no credential. */
export async function rebuildPosthogFromBronze(conn: PosthogConnection) {
  const contactsDerived = await deriveContacts(conn);
  await db.update(posthogActivities).set({ contactId: null }).where(eq(posthogActivities.connectionId, conn.id));
  const activitiesDerived = (await deriveActivities(conn, "visit")) + (await deriveActivities(conn, "event"));
  const machineActivitiesDropped = await dropMachineActivities(conn);
  const activitiesLinked = await linkActivities(conn);
  return { contactsDerived, activitiesDerived, machineActivitiesDropped, activitiesLinked };
}

export interface FastMirrorResult {
  /** Persons whose bronze moved (new, or a property changed). */
  changed: string[];
  /** Of the persons touched, those mirrored for the first time. */
  created: number;
  /** Custom events of this window mirrored for persons whose whole history was not read here (they show at once). */
  eventsChanged: number;
  /** PostHog refused reads (project read budget used up): when it said they come back. Null = not refused. */
  waitingUntil: string | null;
}

/**
 * The fast path (WA-GIVEN-TRIGGER-1015, ONBOARDING-IN-UNIBOX-1015), asked every minute
 * by the phone watch (lib/phone-trigger/): mirror NOW, bronze + silver, without
 * waiting for the 15-min pass, the persons the brand learned something about since
 * `since` (`listPersonIdsTouchedSince`: a person-setting event or a custom event)
 * and their custom events since `since`. A person new to us created in the last
 * `RECENT_PERSON_MS` gets their whole history read here (the steps an anonymous visitor
 * walked before saying who they are land on their thread at once: a recent person's
 * history is a few days of granules, cheap); an older one waits for the paced backlog.
 * POSTHOG-429-1107: ~2.8 MB (who moved) + ~18 MB (their person rows) a minute with
 * something new, instead of 2-3 GB. Not called while PostHog asks to wait; a 429 is
 * recorded as a wait (`rate_limited_until`), never thrown.
 */
export async function mirrorRecentPersons(conn: PosthogConnection, since: Date): Promise<FastMirrorResult> {
  const stored = waitingForBudget(conn);
  if (stored) return { changed: [], created: 0, eventsChanged: 0, waitingUntil: stored.toISOString() };
  const apiKey = await resolveBrandCredential(POSTHOG_PROVIDER, "PostHog", conn.brandId, {
    orgId: conn.orgId,
    userId: conn.createdByUserId,
  });
  const target = targetOf(conn, apiKey);
  const changed: string[] = [];
  const visits: string[] = [];
  const events: string[] = [];
  let created = 0;
  let eventsChanged = 0;
  let refused: PosthogThrottled | null = null;
  try {
    const ids = await listPersonIdsTouchedSince(target, since);
    if (ids.length === 0) return { changed: [], created: 0, eventsChanged: 0, waitingUntil: null };
    const authIds = new Set(await authUserIds(conn.orgId, conn.brandId));
    const before = await knownPersons(conn, ids);
    const listed: Record<string, unknown>[] = [];
    for (const part of chunks(ids)) {
      const persons = await listPersonsByIds(target, part, authIds);
      listed.push(...persons);
      changed.push(...(await mirrorBatch(conn, "person", persons, (r) => String(r.id))));
    }
    // A person PostHog does not hold as known (yet) is not mirrored, nor is their activity.
    const held = await knownPersons(conn, listed.map((r) => String(r.id)));
    created = listed.filter((r) => !before.has(String(r.id))).length;
    const recentFrom = Date.now() - RECENT_PERSON_MS;
    const fresh = [...held.values()].filter(
      (p) => !p.historyReadAt && !!p.createdAt && Date.parse(p.createdAt) >= recentFrom,
    );
    for (let i = 0; i < fresh.length; i += HISTORY_CHUNK) {
      await readHistory(conn, target, fresh.slice(i, i + HISTORY_CHUNK), { visits, events });
    }
    // Everyone else touched (history read before, or older history left to the paced backlog): this window's events.
    const readWhole = new Set(fresh.map((p) => p.id));
    const already = listed.filter((r) => held.has(String(r.id)) && !readWhole.has(String(r.id)));
    const distinctIds = [...new Set(already.flatMap((r) => (Array.isArray(r.distinct_ids) ? r.distinct_ids.map(String) : [])))];
    for (let i = 0; i < distinctIds.length; i += ID_CHUNK) {
      const mine = new Set(already.map((r) => String(r.id)));
      for await (const page of listKeyEvents(target, since, { kind: "distinctIds", ids: distinctIds.slice(i, i + ID_CHUNK) })) {
        const moved = await mirrorBatch(conn, "event", page.filter((r) => mine.has(String(r.person_id))), (r) => String(r.id));
        eventsChanged += moved.length;
        events.push(...moved);
      }
    }
  } catch (err) {
    if (!(err instanceof PosthogThrottled)) throw err;
    refused = err;
    await recordPosthogThrottle(conn.id, err);
  }
  await deriveContacts(conn, changed);
  await deriveActivities(conn, "visit", visits);
  await deriveActivities(conn, "event", events);
  await dropMachineActivities(conn);
  await linkActivities(conn);
  return { changed, created, eventsChanged, waitingUntil: refused ? (refused as PosthogThrottled).retryAt.toISOString() : null };
}
