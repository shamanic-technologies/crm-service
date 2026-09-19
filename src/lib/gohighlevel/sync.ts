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
  ghlConnections,
  ghlOpportunities,
  ghlPipelines,
  ghlRawRecords,
  type GhlConnection,
  type NewGhlRawRecord,
} from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { listContacts, listOpportunities, listPipelines } from "./client.js";
import { resolveGhlToken } from "./credentials.js";
import {
  canonicalHash,
  deriveContact,
  deriveOpportunity,
  derivePipeline,
  GHL_SOURCE,
  type DerivedPipeline,
  type GhlRecordKind,
} from "./records.js";

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
  contactsDerived: number;
  opportunitiesDerived: number;
  pipelinesDerived: number;
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
        // The full record stays verbatim in bronze; silver carries identity only.
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
          unsubscribed: contact.unsubscribed,
          sourceConnectionId: conn.id,
          lastRebuiltAt: now,
        },
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

  const contactRows = await db
    .select({ id: contacts.id, externalId: contacts.externalId })
    .from(contacts)
    .where(and(eq(contacts.sourceConnectionId, conn.id), eq(contacts.source, GHL_SOURCE)));
  const contactByExternalId = new Map<string, string>();
  for (const row of contactRows) {
    if (row.externalId) contactByExternalId.set(row.externalId, row.id);
  }

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
async function deriveSilver(
  conn: GhlConnection,
  changed?: Record<GhlRecordKind, string[]>,
): Promise<{ contacts: number; opportunities: number; pipelines: number }> {
  const pipelines = await derivePipelines(conn, changed?.pipeline);
  const contactCount = await deriveContacts(conn, changed?.contact);

  const pipelinesMoved = changed ? changed.pipeline.length > 0 : true;
  const opportunityIds = changed && !pipelinesMoved ? changed.opportunity : undefined;
  const opportunities = await deriveOpportunities(conn, opportunityIds);

  return { contacts: contactCount, opportunities, pipelines };
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
    });

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
      contactsDerived: derived.contacts,
      opportunitiesDerived: derived.opportunities,
      pipelinesDerived: derived.pipelines,
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
): Promise<{ contacts: number; opportunities: number; pipelines: number }> {
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
    await updateRun(run.id, "completed", identity);
    return derived;
  } catch (err) {
    await updateRun(run.id, "failed", identity).catch((e) =>
      console.error("[crm-service][ghl] failed to close run:", e),
    );
    throw err;
  }
}
