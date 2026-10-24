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
 * Persons are re-listed in full each pass (cheap: one keyset query per 5,000).
 * Activity is read from a window: everything since the last pass's start minus
 * one hour, so an event PostHog ingested late is still picked up. The first pass
 * reads the project's whole history, and so does a person mirrored for the
 * first time on a later pass (newly identified, or newly named by an auth
 * user id): their past visits predate the window.
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
  listIdentifiedPersons,
  listKeyEvents,
  listPersonIdsTouchedSince,
  listPersonsByIds,
  listPersonsByDistinctIds,
  listVisits,
  POSTHOG_MAX_PAGES,
  type PersonScope,
  type PosthogRegion,
  type PosthogTarget,
} from "./client.js";
import { authUserIds } from "../auth/sync.js";
import { AUTH_PROVIDER_NAMES } from "../auth/providers.js";
import { normalizePhone } from "../people/identity.js";
import {
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
  for (const payload of await readBronze(conn, kind, externalIds)) {
    const a = kind === "visit" ? deriveVisit(payload) : deriveKeyEvent(payload);
    if (!a) continue;
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

export async function syncPosthogConnection(conn: PosthogConnection, rereadSince?: Date): Promise<PosthogSyncResult> {
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
    const windowed = conn.syncedThrough
      ? new Date(conn.syncedThrough.getTime() - POSTHOG_LATE_INGESTION_MS)
      : FIRST_PASS_SINCE;
    // A re-read asked from an earlier instant (POSTHOG-SCANNER-VISIT-1025 backfill) widens the window, never narrows it.
    const since = rereadSince && rereadSince < windowed ? rereadSince : windowed;

    const before = new Set(
      (
        await db
          .select({ externalId: posthogRawRecords.externalId })
          .from(posthogRawRecords)
          .where(and(eq(posthogRawRecords.connectionId, conn.id), eq(posthogRawRecords.kind, "person")))
      ).map((r) => r.externalId),
    );
    const persons = { mirrored: 0, changed: [] as string[], listed: [] as string[] };
    for await (const page of listIdentifiedPersons(target)) {
      persons.mirrored += page.length;
      persons.listed.push(...page.map((r) => String(r.id)));
      persons.changed.push(...(await mirrorBatch(conn, "person", page, (r) => String(r.id))));
    }
    const byAuthId = new Set<string>();
    for (const ids of chunks(await authUserIds(conn.orgId, conn.brandId))) {
      const page = await listPersonsByDistinctIds(target, ids);
      for (const r of page) byAuthId.add(String(r.id));
      persons.listed.push(...page.map((r) => String(r.id)));
      persons.changed.push(...(await mirrorBatch(conn, "person", page, (r) => String(r.id))));
    }
    persons.mirrored += byAuthId.size;

    // A stream that hit the page ceiling stopped early: the next pass must
    // resume from the last row it actually read, not from this pass's start.
    let resumeFrom: Date | null = null;
    const visits = { mirrored: 0, changed: [] as string[] };
    const events = { mirrored: 0, changed: [] as string[] };
    const readActivity = async (from: Date, scope: PersonScope, windowed: boolean) => {
      let pages = 0;
      let last: unknown = null;
      for await (const page of listVisits(target, from, scope)) {
        pages++;
        last = page[page.length - 1].started_at;
        visits.mirrored += page.length;
        visits.changed.push(...(await mirrorBatch(conn, "visit", page, visitId)));
      }
      const capped = (n: number, at: unknown) => {
        if (!windowed || n < POSTHOG_MAX_PAGES || typeof at !== "string") return;
        const d = new Date(at);
        if (!resumeFrom || d < resumeFrom) resumeFrom = d;
      };
      capped(pages, last);
      pages = 0;
      last = null;
      for await (const page of listKeyEvents(target, from, scope)) {
        pages++;
        last = page[page.length - 1].timestamp;
        events.mirrored += page.length;
        events.changed.push(...(await mirrorBatch(conn, "event", page, (r) => String(r.id))));
      }
      capped(pages, last);
    };
    await readActivity(since, { kind: "identified" }, true);
    for (const ids of chunks([...byAuthId])) await readActivity(since, { kind: "ids", ids }, true);
    const fresh = since === FIRST_PASS_SINCE ? [] : [...new Set(persons.listed)].filter((id) => !before.has(id));
    for (const ids of chunks(fresh)) await readActivity(FIRST_PASS_SINCE, { kind: "ids", ids }, false);

    const contactsDerived = await deriveContacts(conn, persons.changed);
    const activitiesDerived =
      (await deriveActivities(conn, "visit", visits.changed)) + (await deriveActivities(conn, "event", events.changed));
    const activitiesLinked = await linkActivities(conn);

    await db
      .update(posthogConnections)
      .set({
        status: "active",
        lastError: null,
        lastRunId: run.id,
        lastSyncedAt: new Date(),
        syncedThrough: resumeFrom ?? startedAt,
      })
      .where(eq(posthogConnections.id, conn.id));
    await updateRun(run.id, "completed", identity);
    return {
      connectionId: conn.id,
      runId: run.id,
      personsMirrored: persons.mirrored,
      personsByAuthUserId: byAuthId.size,
      personsBackfilled: fresh.length,
      personsChanged: persons.changed.length,
      visitsMirrored: visits.mirrored,
      visitsChanged: visits.changed.length,
      eventsMirrored: events.mirrored,
      eventsChanged: events.changed.length,
      contactsDerived,
      activitiesDerived,
      activitiesLinked,
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

/** Every active connection (or one). Failures are recorded AND returned, never swallowed. */
export async function runPosthogSyncPass(connectionId?: string, rereadSince?: Date) {
  const where = connectionId
    ? eq(posthogConnections.id, connectionId)
    : inArray(posthogConnections.status, ["active", "error"]);
  const connections = await db.select().from(posthogConnections).where(where);
  const results: PosthogSyncResult[] = [];
  const failures: { connectionId: string; error: string }[] = [];
  for (const conn of connections) {
    if (conn.status === "paused") continue;
    try {
      results.push(await syncPosthogConnection(conn, rereadSince));
    } catch (err) {
      console.error(`[crm-service][posthog] sync failed for connection ${conn.id}:`, err);
      failures.push({ connectionId: conn.id, error: (err as Error).message });
    }
  }
  return { connections: connections.length, results, failures };
}

/** Re-derive all silver from bronze alone — no PostHog call, no credential. */
export async function rebuildPosthogFromBronze(conn: PosthogConnection) {
  const contactsDerived = await deriveContacts(conn);
  await db.update(posthogActivities).set({ contactId: null }).where(eq(posthogActivities.connectionId, conn.id));
  const activitiesDerived = (await deriveActivities(conn, "visit")) + (await deriveActivities(conn, "event"));
  const activitiesLinked = await linkActivities(conn);
  return { contactsDerived, activitiesDerived, activitiesLinked };
}

export interface FastMirrorResult {
  /** Persons whose bronze moved (new, or a property changed). */
  changed: string[];
  /** Of the persons touched, those mirrored for the first time (their whole history read). */
  created: number;
  /** Custom events mirrored for persons already known (they show on the thread at once). */
  eventsChanged: number;
}

/**
 * The fast path (WA-GIVEN-TRIGGER-1015, ONBOARDING-IN-UNIBOX-1015), asked every minute
 * by the phone watch (lib/phone-trigger/): mirror NOW, bronze + silver, without
 * waiting for the 15-min pass, the persons the brand learned something about since
 * `since` (`listPersonIdsTouchedSince`: a phone / email / name / website set, or a
 * custom event of a known person) and their custom events since `since`. A person
 * mirrored here for the first time gets their whole activity history read (the full
 * pass would otherwise treat them as already known and never backfill it): the steps
 * an anonymous visitor walked before saying who they are land on their thread too.
 */
export async function mirrorRecentPersons(conn: PosthogConnection, since: Date): Promise<FastMirrorResult> {
  const apiKey = await resolveBrandCredential(POSTHOG_PROVIDER, "PostHog", conn.brandId, {
    orgId: conn.orgId,
    userId: conn.createdByUserId,
  });
  const target = targetOf(conn, apiKey);
  const ids = await listPersonIdsTouchedSince(target, since);
  if (ids.length === 0) return { changed: [], created: 0, eventsChanged: 0 };
  const known = new Set(
    (
      await db
        .select({ externalId: posthogRawRecords.externalId })
        .from(posthogRawRecords)
        .where(and(eq(posthogRawRecords.connectionId, conn.id), eq(posthogRawRecords.kind, "person"), inArray(posthogRawRecords.externalId, ids)))
    ).map((r) => r.externalId),
  );
  const changed: string[] = [];
  const listed = new Set<string>();
  for (const part of chunks(ids)) {
    const persons = await listPersonsByIds(target, part);
    for (const r of persons) listed.add(String(r.id));
    changed.push(...(await mirrorBatch(conn, "person", persons, (r) => String(r.id))));
  }
  // A person PostHog does not hold as known (yet) is not mirrored, nor is their activity.
  const fresh = ids.filter((id) => listed.has(id) && !known.has(id));
  const already = ids.filter((id) => listed.has(id) && known.has(id));
  const visits: string[] = [];
  const events: string[] = [];
  for (const part of chunks(fresh)) {
    for await (const page of listVisits(target, FIRST_PASS_SINCE, { kind: "ids", ids: part })) {
      visits.push(...(await mirrorBatch(conn, "visit", page, visitId)));
    }
    for await (const page of listKeyEvents(target, FIRST_PASS_SINCE, { kind: "ids", ids: part })) {
      events.push(...(await mirrorBatch(conn, "event", page, (r) => String(r.id))));
    }
  }
  let eventsChanged = 0;
  for (const part of chunks(already)) {
    for await (const page of listKeyEvents(target, since, { kind: "ids", ids: part })) {
      const moved = await mirrorBatch(conn, "event", page, (r) => String(r.id));
      eventsChanged += moved.length;
      events.push(...moved);
    }
  }
  await deriveContacts(conn, changed);
  await deriveActivities(conn, "visit", visits);
  await deriveActivities(conn, "event", events);
  await linkActivities(conn);
  return { changed, created: fresh.length, eventsChanged };
}
