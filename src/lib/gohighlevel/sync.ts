/**
 * The GoHighLevel ingestion pass: bronze → silver, for one connection.
 *
 * Layering, mirroring the CSV and Matrix paths:
 *  - BRONZE  mirror every contact, opportunity and pipeline verbatim into
 *            `ghl_raw_records`, keyed on GoHighLevel's own record id. The upsert
 *            writes ONLY when the content hash moved, so a re-sync of an
 *            unchanged record touches nothing at all.
 *  - SILVER  derive contacts, pipelines and opportunities by reading BRONZE back
 *            — never the API response — deterministically, zero LLM.
 *
 * There is no gold table: the pipeline view is a deterministic grouping over
 * silver (see `readPipelineView`), and the sendable-contacts gold view already
 * excludes this source by construction.
 *
 * Because silver is derived from bronze alone, wiping it and running
 * `rebuildFromBronze` reproduces it with no call to GoHighLevel.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  ghlAppointments,
  ghlConnections,
  ghlOpportunities,
  ghlOpportunityHistory,
  ghlPipelines,
  ghlRawRecords,
  type GhlConnection,
  type NewGhlRawRecord,
} from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import {
  listCalendarAppointments,
  listCalendars,
  listContacts,
  listOpportunities,
  listPipelines,
} from "./client.js";
import { resolveGhlToken } from "./credentials.js";
import {
  canonicalHash,
  deriveAppointment,
  deriveCalendarName,
  deriveContact,
  deriveOpportunity,
  derivePipeline,
  GHL_SOURCE,
  type DerivedOpportunity,
  type DerivedPipeline,
  type GhlRecordKind,
} from "./records.js";
import { decideStageMeanings } from "./stage-meanings.js";

export interface ConnectionSyncResult {
  connectionId: string;
  locationId: string;
  runId: string;
  contactsMirrored: number;
  contactsChanged: number;
  opportunitiesMirrored: number;
  opportunitiesChanged: number;
  pipelinesMirrored: number;
  pipelinesChanged: number;
  appointmentsMirrored: number;
  appointmentsChanged: number;
  contactsDerived: number;
  opportunitiesDerived: number;
  pipelinesDerived: number;
  appointmentsDerived: number;
  /** Stage / status observations appended to the opportunity history. */
  historyAppended: number;
  /** Stages given a recorded meaning this pass (0 once every stage is decided). */
  stageMeaningsDecided: number;
}

/**
 * BRONZE — upsert a batch of records, returning the external ids that ACTUALLY
 * changed.
 *
 * `setWhere` is the no-churn guard: when the incoming hash equals the stored
 * one, Postgres performs no update, so the row is not rewritten and it is not
 * returned. A second identical sync therefore reports zero changes and leaves
 * `mirrored_at` where it was.
 */
async function mirrorBatch(
  conn: GhlConnection,
  kind: GhlRecordKind,
  records: { id: string; [key: string]: unknown }[],
): Promise<string[]> {
  if (records.length === 0) return [];

  const values: NewGhlRawRecord[] = records.map((record) => ({
    orgId: conn.orgId,
    brandId: conn.brandId,
    connectionId: conn.id,
    kind,
    externalId: record.id,
    contentHash: canonicalHash(record),
    payload: record as Record<string, unknown>,
  }));

  const changed: string[] = [];
  for (let i = 0; i < values.length; i += 500) {
    const rows = await db
      .insert(ghlRawRecords)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [ghlRawRecords.connectionId, ghlRawRecords.kind, ghlRawRecords.externalId],
        set: {
          contentHash: sql`excluded.content_hash`,
          payload: sql`excluded.payload`,
          mirroredAt: new Date(),
        },
        setWhere: sql`${ghlRawRecords.contentHash} <> excluded.content_hash`,
      })
      .returning({ externalId: ghlRawRecords.externalId });
    for (const row of rows) changed.push(row.externalId);
  }
  return changed;
}

interface MirrorCounts {
  mirrored: number;
  changed: string[];
}

/** BRONZE — drain every contact, opportunity and pipeline of the sub-account. */
async function mirrorAll(
  conn: GhlConnection,
  token: string,
): Promise<Record<GhlRecordKind, MirrorCounts>> {
  const out: Record<GhlRecordKind, MirrorCounts> = {
    contact: { mirrored: 0, changed: [] },
    opportunity: { mirrored: 0, changed: [] },
    pipeline: { mirrored: 0, changed: [] },
    calendar: { mirrored: 0, changed: [] },
    appointment: { mirrored: 0, changed: [] },
  };

  const pipelines = await listPipelines(token, conn.locationId);
  out.pipeline.mirrored = pipelines.length;
  out.pipeline.changed = await mirrorBatch(conn, "pipeline", pipelines);

  for await (const page of listContacts(token, conn.locationId)) {
    out.contact.mirrored += page.length;
    out.contact.changed.push(...(await mirrorBatch(conn, "contact", page)));
  }

  for await (const page of listOpportunities(token, conn.locationId)) {
    out.opportunity.mirrored += page.length;
    out.opportunity.changed.push(...(await mirrorBatch(conn, "opportunity", page)));
  }

  const calendars = await listCalendars(token, conn.locationId);
  out.calendar.mirrored = calendars.length;
  out.calendar.changed = await mirrorBatch(conn, "calendar", calendars);

  for (const calendar of calendars) {
    const appointments = await listCalendarAppointments(token, conn.locationId, calendar.id);
    out.appointment.mirrored += appointments.length;
    out.appointment.changed.push(...(await mirrorBatch(conn, "appointment", appointments)));
  }

  return out;
}

/** Read mirrored records of one kind back out of bronze. */
async function readBronze(
  conn: GhlConnection,
  kind: GhlRecordKind,
  externalIds?: string[],
): Promise<Record<string, unknown>[]> {
  if (externalIds && externalIds.length === 0) return [];
  const filters = [eq(ghlRawRecords.connectionId, conn.id), eq(ghlRawRecords.kind, kind)];
  if (externalIds) filters.push(inArray(ghlRawRecords.externalId, externalIds));

  const rows = await db
    .select({ payload: ghlRawRecords.payload })
    .from(ghlRawRecords)
    .where(and(...filters));
  return rows.map((r) => r.payload as Record<string, unknown>);
}

/** SILVER — pipelines with their ordered stages. */
async function derivePipelines(
  conn: GhlConnection,
  externalIds?: string[],
): Promise<number> {
  const payloads = await readBronze(conn, "pipeline", externalIds);
  const now = new Date();
  let derived = 0;

  for (const payload of payloads) {
    const pipeline = derivePipeline(payload);
    if (!pipeline) continue;
    await db
      .insert(ghlPipelines)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        connectionId: conn.id,
        externalId: pipeline.externalId,
        name: pipeline.name,
        stages: pipeline.stages,
        lastRebuiltAt: now,
      })
      .onConflictDoUpdate({
        target: [ghlPipelines.connectionId, ghlPipelines.externalId],
        set: { name: pipeline.name, stages: pipeline.stages, lastRebuiltAt: now },
      });
    derived += 1;
  }
  return derived;
}

/**
 * SILVER — contacts, under the shared `contacts` table with `source =
 * 'gohighlevel'`.
 *
 * Keyed on (org, brand, source, external_id): GoHighLevel's own contact id. The
 * CSV email dedup key is a partial index on `source = 'csv'`, so a GoHighLevel
 * contact who shares an email with a CSV contact cannot overwrite them.
 */
async function deriveContacts(conn: GhlConnection, externalIds?: string[]): Promise<number> {
  const payloads = await readBronze(conn, "contact", externalIds);
  const now = new Date();
  let derived = 0;

  for (const payload of payloads) {
    const contact = deriveContact(payload);
    if (!contact) continue;
    await db
      .insert(contacts)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        primaryEmail: contact.primaryEmail,
        phoneE164: contact.phoneE164,
        fullName: contact.fullName,
        firstName: contact.firstName,
        lastName: contact.lastName,
        companyName: contact.companyName,
        website: contact.website,
        city: contact.city,
        stateRegion: contact.stateRegion,
        country: contact.country,
        postalCode: contact.postalCode,
        streetAddress: contact.streetAddress,
        leadSource: contact.leadSource,
        contactType: contact.contactType,
        tags: contact.tags,
        originMedium: contact.originMedium,
        originUrl: contact.originUrl,
        originReferrer: contact.originReferrer,
        sourceCreatedAt: contact.sourceCreatedAt,
        sourceUpdatedAt: contact.sourceUpdatedAt,
        // The full record stays verbatim in bronze; silver carries the canonical
        // subset — identity, company, location and record provenance.
        rawAttributes: {},
        consentStatus: "unknown",
        unsubscribed: contact.unsubscribed,
        source: GHL_SOURCE,
        externalId: contact.externalId,
        sourceConnectionId: conn.id,
        lastRebuiltAt: now,
      })
      .onConflictDoUpdate({
        target: [contacts.orgId, contacts.brandId, contacts.source, contacts.externalId],
        set: {
          primaryEmail: contact.primaryEmail,
          phoneE164: contact.phoneE164,
          fullName: contact.fullName,
          firstName: contact.firstName,
          lastName: contact.lastName,
          companyName: contact.companyName,
          website: contact.website,
          city: contact.city,
          stateRegion: contact.stateRegion,
          country: contact.country,
          postalCode: contact.postalCode,
          streetAddress: contact.streetAddress,
          leadSource: contact.leadSource,
          contactType: contact.contactType,
          tags: contact.tags,
          originMedium: contact.originMedium,
          originUrl: contact.originUrl,
          originReferrer: contact.originReferrer,
          sourceCreatedAt: contact.sourceCreatedAt,
          sourceUpdatedAt: contact.sourceUpdatedAt,
          unsubscribed: contact.unsubscribed,
          sourceConnectionId: conn.id,
          lastRebuiltAt: now,
        },
      });
    derived += 1;
  }
  return derived;
}

/** Silver contact ids of the connection, keyed on GoHighLevel's contact id. */
async function contactIdsByExternalId(conn: GhlConnection): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: contacts.id, externalId: contacts.externalId })
    .from(contacts)
    .where(and(eq(contacts.sourceConnectionId, conn.id), eq(contacts.source, GHL_SOURCE)));
  const byExternalId = new Map<string, string>();
  for (const row of rows) {
    if (row.externalId) byExternalId.set(row.externalId, row.id);
  }
  return byExternalId;
}

interface HistoryHead {
  value: string | null;
  changedAt: Date | null;
}

/**
 * The LATEST history row of each (opportunity, kind) of the connection, keyed
 * `<opportunity id>\u0000<kind>`. What a new observation is compared against.
 */
async function latestHistory(conn: GhlConnection): Promise<Map<string, HistoryHead>> {
  const rows = await db.execute<{
    opportunity_external_id: string;
    kind: string;
    value: string | null;
    changed_at: string | Date | null;
  }>(sql`
    SELECT DISTINCT ON (opportunity_external_id, kind)
      opportunity_external_id, kind, value, changed_at
    FROM ghl_opportunity_history
    WHERE connection_id = ${conn.id}
    ORDER BY opportunity_external_id, kind, observed_at DESC, id DESC
  `);
  const heads = new Map<string, HistoryHead>();
  for (const row of rows) {
    heads.set(`${row.opportunity_external_id}\u0000${row.kind}`, {
      value: row.value,
      changedAt: row.changed_at === null ? null : new Date(row.changed_at),
    });
  }
  return heads;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * APPEND-ONLY history — record the opportunity's stage and status when either
 * differs from the latest recorded observation (value OR GoHighLevel's own
 * change date), so a stage left and re-entered between two syncs is still seen.
 *
 * The date is GoHighLevel's (`lastStageChangeAt` / `lastStatusChangeAt`) or
 * null. It is never the observation time: when GoHighLevel gives no date, the
 * row says the date is unknown.
 */
async function appendHistory(
  conn: GhlConnection,
  opportunity: DerivedOpportunity,
  resolved: { pipelineName: string | null; stageName: string | null },
  latest: Map<string, HistoryHead>,
  now: Date,
): Promise<number> {
  const observations = [
    {
      kind: "stage" as const,
      value: opportunity.stageExternalId,
      changedAt: opportunity.stageChangedAt,
    },
    {
      kind: "status" as const,
      value: opportunity.status,
      changedAt: opportunity.statusChangedAt,
    },
  ];

  let appended = 0;
  for (const observation of observations) {
    if (observation.value === null) continue;
    const key = `${opportunity.externalId}\u0000${observation.kind}`;
    const head = latest.get(key);
    if (head && head.value === observation.value && sameInstant(head.changedAt, observation.changedAt)) {
      continue;
    }
    await db.insert(ghlOpportunityHistory).values({
      orgId: conn.orgId,
      brandId: conn.brandId,
      connectionId: conn.id,
      opportunityExternalId: opportunity.externalId,
      externalContactId: opportunity.externalContactId,
      kind: observation.kind,
      value: observation.value,
      pipelineExternalId: opportunity.pipelineExternalId,
      pipelineName: resolved.pipelineName,
      stageName: resolved.stageName,
      changedAt: observation.changedAt,
      observedAt: now,
    });
    latest.set(key, { value: observation.value, changedAt: observation.changedAt });
    appended += 1;
  }
  return appended;
}

/**
 * APPEND-ONLY history — observe EVERY mirrored opportunity on every pass, not
 * only the ones whose bronze row just moved.
 *
 * Tying the history to the changed-records derivation would never observe an
 * opportunity mirrored before this table existed (or before a wipe of it): its
 * bronze row does not move, so it would never be seen. Comparing every
 * opportunity against the latest history row is cheap (one read of bronze and
 * silver) and appends only what differs, so a quiet pass still appends nothing.
 */
async function recordHistory(conn: GhlConnection): Promise<number> {
  const rows = await db
    .select({
      payload: ghlRawRecords.payload,
      pipelineName: ghlOpportunities.pipelineName,
      stageName: ghlOpportunities.stageName,
    })
    .from(ghlRawRecords)
    .innerJoin(
      ghlOpportunities,
      and(
        eq(ghlOpportunities.connectionId, ghlRawRecords.connectionId),
        eq(ghlOpportunities.externalId, ghlRawRecords.externalId),
      ),
    )
    .where(and(eq(ghlRawRecords.connectionId, conn.id), eq(ghlRawRecords.kind, "opportunity")));
  if (rows.length === 0) return 0;

  const latest = await latestHistory(conn);
  const now = new Date();
  let appended = 0;
  for (const row of rows) {
    const opportunity = deriveOpportunity(row.payload as Record<string, unknown>);
    if (!opportunity) continue;
    appended += await appendHistory(
      conn,
      opportunity,
      { pipelineName: row.pipelineName, stageName: row.stageName },
      latest,
      now,
    );
  }
  return appended;
}

/**
 * SILVER — calendar appointments, with the calendar NAME resolved from the
 * mirrored calendars and the contact linked when we have mirrored it.
 */
async function deriveAppointments(
  conn: GhlConnection,
  externalIds?: string[],
): Promise<number> {
  const payloads = await readBronze(conn, "appointment", externalIds);
  if (payloads.length === 0) return 0;

  const calendarNames = new Map<string, string | null>();
  for (const payload of await readBronze(conn, "calendar")) {
    const calendar = deriveCalendarName(payload);
    if (calendar) calendarNames.set(calendar.externalId, calendar.name);
  }
  const contactByExternalId = await contactIdsByExternalId(conn);

  const now = new Date();
  let derived = 0;
  for (const payload of payloads) {
    const appointment = deriveAppointment(payload);
    if (!appointment) continue;

    const values = {
      calendarExternalId: appointment.calendarExternalId,
      calendarName: appointment.calendarExternalId
        ? (calendarNames.get(appointment.calendarExternalId) ?? null)
        : null,
      title: appointment.title,
      status: appointment.status,
      externalContactId: appointment.externalContactId,
      contactId: appointment.externalContactId
        ? (contactByExternalId.get(appointment.externalContactId) ?? null)
        : null,
      bookedAt: appointment.bookedAt,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      ghlUpdatedAt: appointment.ghlUpdatedAt,
      lastRebuiltAt: now,
    };

    await db
      .insert(ghlAppointments)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        connectionId: conn.id,
        externalId: appointment.externalId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [ghlAppointments.connectionId, ghlAppointments.externalId],
        set: values,
      });
    derived += 1;
  }
  return derived;
}

/**
 * SILVER — opportunities, with pipeline and stage NAMES resolved against the
 * silver pipelines so the read can group them the way GoHighLevel does.
 */
async function deriveOpportunities(
  conn: GhlConnection,
  externalIds?: string[],
): Promise<number> {
  const payloads = await readBronze(conn, "opportunity", externalIds);
  if (payloads.length === 0) return 0;

  const pipelineRows = await db
    .select()
    .from(ghlPipelines)
    .where(eq(ghlPipelines.connectionId, conn.id));
  const pipelineById = new Map<string, { name: string; stages: DerivedPipeline["stages"] }>();
  for (const row of pipelineRows) {
    pipelineById.set(row.externalId, {
      name: row.name,
      stages: (row.stages as DerivedPipeline["stages"]) ?? [],
    });
  }

  const contactByExternalId = await contactIdsByExternalId(conn);

  const now = new Date();
  let derived = 0;

  for (const payload of payloads) {
    const opportunity = deriveOpportunity(payload);
    if (!opportunity) continue;

    const pipeline = opportunity.pipelineExternalId
      ? pipelineById.get(opportunity.pipelineExternalId)
      : undefined;
    const stage = pipeline?.stages.find((s) => s.id === opportunity.stageExternalId);

    const values = {
      name: opportunity.name,
      pipelineExternalId: opportunity.pipelineExternalId,
      pipelineName: pipeline?.name ?? null,
      stageExternalId: opportunity.stageExternalId,
      stageName: stage?.name ?? null,
      status: opportunity.status,
      monetaryValue: opportunity.monetaryValue,
      assignedTo: opportunity.assignedTo,
      externalContactId: opportunity.externalContactId,
      // Null rather than a guess when GoHighLevel names a contact we have not
      // mirrored — the attachment is never invented.
      contactId: opportunity.externalContactId
        ? (contactByExternalId.get(opportunity.externalContactId) ?? null)
        : null,
      ghlCreatedAt: opportunity.ghlCreatedAt,
      ghlUpdatedAt: opportunity.ghlUpdatedAt,
      lastRebuiltAt: now,
    };

    await db
      .insert(ghlOpportunities)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        connectionId: conn.id,
        externalId: opportunity.externalId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [ghlOpportunities.connectionId, ghlOpportunities.externalId],
        set: values,
      });
    derived += 1;
  }
  return derived;
}

/**
 * SILVER — derive everything, or only what changed.
 *
 * `changed` omitted = a full rebuild (the `rebuildFromBronze` path). When it is
 * given, only the records whose bronze row actually moved are re-derived, which
 * is what makes a second identical sync a no-op all the way down.
 *
 * One coupling is deliberate: a pipeline can be renamed or re-staged without any
 * opportunity changing, and every opportunity carries its pipeline and stage
 * name — so a pipeline change re-derives every opportunity of the connection.
 */
export interface DerivedCounts {
  contacts: number;
  opportunities: number;
  pipelines: number;
  appointments: number;
  historyAppended: number;
}

async function deriveSilver(
  conn: GhlConnection,
  changed?: Record<GhlRecordKind, string[]>,
): Promise<DerivedCounts> {
  const pipelines = await derivePipelines(conn, changed?.pipeline);
  const contactCount = await deriveContacts(conn, changed?.contact);

  const pipelinesMoved = changed ? changed.pipeline.length > 0 : true;
  const opportunityIds = changed && !pipelinesMoved ? changed.opportunity : undefined;
  const opportunities = await deriveOpportunities(conn, opportunityIds);
  const historyAppended = await recordHistory(conn);

  // Same coupling for calendars: a renamed calendar re-labels all its appointments.
  const calendarsMoved = changed ? changed.calendar.length > 0 : true;
  const appointmentIds = changed && !calendarsMoved ? changed.appointment : undefined;
  const appointments = await deriveAppointments(conn, appointmentIds);

  return {
    contacts: contactCount,
    opportunities,
    pipelines,
    appointments,
    historyAppended,
  };
}

/**
 * One full pass for one connection, under its OWN org run.
 *
 * The run is an ORG run built from the connection row's org + creator, not a
 * platform run: the work belongs to the org that owns the connection. The cron
 * carries no inbound identity; the connection row IS the carrier.
 *
 * Fails loud: any error marks the connection `error` with the message, fails the
 * run, and rethrows so the caller records it.
 */
export async function syncConnection(conn: GhlConnection): Promise<ConnectionSyncResult> {
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "gohighlevel.sync",
  });

  try {
    const token = await resolveGhlToken(conn.brandId, {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
    });

    const mirrored = await mirrorAll(conn, token);
    const derived = await deriveSilver(conn, {
      contact: mirrored.contact.changed,
      opportunity: mirrored.opportunity.changed,
      pipeline: mirrored.pipeline.changed,
      calendar: mirrored.calendar.changed,
      appointment: mirrored.appointment.changed,
    });
    const stageMeaningsDecided = await decideStageMeanings(conn, run.id);

    await db
      .update(ghlConnections)
      .set({ status: "active", lastError: null, lastRunId: run.id, lastSyncedAt: new Date() })
      .where(eq(ghlConnections.id, conn.id));
    await updateRun(run.id, "completed", {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
      brandIds: [conn.brandId],
    });

    return {
      connectionId: conn.id,
      locationId: conn.locationId,
      runId: run.id,
      contactsMirrored: mirrored.contact.mirrored,
      contactsChanged: mirrored.contact.changed.length,
      opportunitiesMirrored: mirrored.opportunity.mirrored,
      opportunitiesChanged: mirrored.opportunity.changed.length,
      pipelinesMirrored: mirrored.pipeline.mirrored,
      pipelinesChanged: mirrored.pipeline.changed.length,
      appointmentsMirrored: mirrored.appointment.mirrored,
      appointmentsChanged: mirrored.appointment.changed.length,
      contactsDerived: derived.contacts,
      opportunitiesDerived: derived.opportunities,
      pipelinesDerived: derived.pipelines,
      appointmentsDerived: derived.appointments,
      historyAppended: derived.historyAppended,
      stageMeaningsDecided,
    };
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(ghlConnections)
      .set({ status: "error", lastError: message, lastRunId: run.id })
      .where(eq(ghlConnections.id, conn.id));
    await updateRun(run.id, "failed", {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
      brandIds: [conn.brandId],
    }).catch((e) => console.error("[crm-service][ghl] failed to close run:", e));
    throw err;
  }
}

export interface SyncPassResult {
  connections: number;
  results: ConnectionSyncResult[];
  failures: { connectionId: string; error: string }[];
}

/**
 * Run a pass over every active connection (or one, when `connectionId` is
 * given). Per-connection failures are recorded on the connection row AND
 * returned — never swallowed — so one broken connection does not stop the others.
 *
 * A disconnected brand has no row, and a paused one is skipped: either way the
 * syncing stops.
 */
export async function runSyncPass(connectionId?: string): Promise<SyncPassResult> {
  const where = connectionId
    ? eq(ghlConnections.id, connectionId)
    : inArray(ghlConnections.status, ["active", "error"]);

  const connections = await db.select().from(ghlConnections).where(where);

  const results: ConnectionSyncResult[] = [];
  const failures: { connectionId: string; error: string }[] = [];

  for (const conn of connections) {
    if (conn.status === "paused") continue;
    try {
      results.push(await syncConnection(conn));
    } catch (err) {
      console.error(`[crm-service][ghl] sync failed for connection ${conn.id}:`, err);
      failures.push({ connectionId: conn.id, error: (err as Error).message });
    }
  }

  return { connections: connections.length, results, failures };
}

/**
 * Rebuild silver from BRONZE alone — no GoHighLevel call, no credential.
 *
 * This is the "wipe the derived layers and reproduce them" path: everything
 * already mirrored is re-derived exactly as the sync would have derived it.
 */
export async function rebuildFromBronze(
  conn: GhlConnection,
): Promise<DerivedCounts & { stageMeaningsDecided: number }> {
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "gohighlevel.rebuild",
  });

  const identity = {
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    runId: run.id,
    brandIds: [conn.brandId],
  };

  try {
    const derived = await deriveSilver(conn);
    const stageMeaningsDecided = await decideStageMeanings(conn, run.id);
    await updateRun(run.id, "completed", identity);
    return { ...derived, stageMeaningsDecided };
  } catch (err) {
    await updateRun(run.id, "failed", identity).catch((e) =>
      console.error("[crm-service][ghl] failed to close run:", e),
    );
    throw err;
  }
}
