/**
 * The PostHog ingestion pass: bronze → silver, for one connection. Read-only
 * toward PostHog; free (PostHog bills by ingestion, not by API read), so no
 * cost is declared — crm-service declares none of its own.
 *
 *  - BRONZE  every identified person, every visit (session) and every custom
 *            event of an identified person, verbatim in `posthog_raw_records`,
 *            keyed on PostHog's own id. The upsert writes only when the content
 *            hash moved.
 *  - SILVER  persons → `contacts` (source `posthog`), visits + events →
 *            `posthog_activities`, read back from BRONZE, zero LLM.
 *
 * Persons are re-listed in full each pass (cheap: one keyset query per 5,000).
 * Activity is read from a window: everything since the last pass's start minus
 * one hour, so an event PostHog ingested late is still picked up. The first pass
 * reads the project's whole history.
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
  listVisits,
  POSTHOG_MAX_PAGES,
  type PosthogRegion,
  type PosthogTarget,
} from "./client.js";
import {
  deriveKeyEvent,
  derivePosthogContact,
  deriveVisit,
  POSTHOG_SOURCE,
  visitId,
  type PosthogRecordKind,
} from "./records.js";

export const POSTHOG_PROVIDER = "posthog";
/** How far before the last pass's start the next pass re-reads activity. */
export const POSTHOG_LATE_INGESTION_MS = 60 * 60 * 1000;
const FIRST_PASS_SINCE = new Date("2000-01-01T00:00:00Z");

export interface PosthogSyncResult {
  connectionId: string;
  runId: string;
  personsMirrored: number;
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

async function deriveContacts(conn: PosthogConnection, externalIds?: string[]): Promise<number> {
  const now = new Date();
  let derived = 0;
  for (const payload of await readBronze(conn, "person", externalIds)) {
    const c = derivePosthogContact(payload);
    if (!c) continue;
    const fields = {
      primaryEmail: c.primaryEmail,
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
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
        rawAttributes: {},
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

export async function syncPosthogConnection(conn: PosthogConnection): Promise<PosthogSyncResult> {
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
    const since = conn.syncedThrough
      ? new Date(conn.syncedThrough.getTime() - POSTHOG_LATE_INGESTION_MS)
      : FIRST_PASS_SINCE;

    const persons = { mirrored: 0, changed: [] as string[] };
    for await (const page of listIdentifiedPersons(target)) {
      persons.mirrored += page.length;
      persons.changed.push(...(await mirrorBatch(conn, "person", page, (r) => String(r.id))));
    }
    // A stream that hit the page ceiling stopped early: the next pass must
    // resume from the last row it actually read, not from this pass's start.
    let resumeFrom: Date | null = null;
    const capped = (pages: number, last: unknown) => {
      if (pages < POSTHOG_MAX_PAGES || typeof last !== "string") return;
      const at = new Date(last);
      if (!resumeFrom || at < resumeFrom) resumeFrom = at;
    };
    const visits = { mirrored: 0, changed: [] as string[] };
    let pages = 0;
    let last: unknown = null;
    for await (const page of listVisits(target, since)) {
      pages++;
      last = page[page.length - 1].started_at;
      visits.mirrored += page.length;
      visits.changed.push(...(await mirrorBatch(conn, "visit", page, visitId)));
    }
    capped(pages, last);
    const events = { mirrored: 0, changed: [] as string[] };
    pages = 0;
    last = null;
    for await (const page of listKeyEvents(target, since)) {
      pages++;
      last = page[page.length - 1].timestamp;
      events.mirrored += page.length;
      events.changed.push(...(await mirrorBatch(conn, "event", page, (r) => String(r.id))));
    }
    capped(pages, last);

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
export async function runPosthogSyncPass(connectionId?: string) {
  const where = connectionId
    ? eq(posthogConnections.id, connectionId)
    : inArray(posthogConnections.status, ["active", "error"]);
  const connections = await db.select().from(posthogConnections).where(where);
  const results: PosthogSyncResult[] = [];
  const failures: { connectionId: string; error: string }[] = [];
  for (const conn of connections) {
    if (conn.status === "paused") continue;
    try {
      results.push(await syncPosthogConnection(conn));
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
