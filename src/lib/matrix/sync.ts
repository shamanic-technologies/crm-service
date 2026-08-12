/**
 * The Matrix ingestion pass: bronze → silver → gold, for one connection.
 *
 * Layering, mirroring the CSV path:
 *  - BRONZE  mirror every in-scope event verbatim (`matrix_raw_events`), and
 *            advance the `/sync` cursor in the SAME transaction as the events it
 *            covers — a crash mid-sync re-reads the batch instead of silently
 *            dropping messages.
 *  - SILVER  rebuild the contact + conversation for each touched room by reading
 *            BRONZE back (never the sync page), deterministically, zero LLM.
 *  - GOLD    read the thread with one chat-service call, but ONLY when the
 *            conversation's watermark moved past the stored one.
 *
 * Because silver and gold are both rebuilt FROM bronze, truncating the leads
 * table and re-running reproduces it.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixLeads,
  matrixRawEvents,
  type MatrixConnection,
  type NewMatrixRawEvent,
} from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { sync, type MatrixEvent } from "./client.js";
import {
  aggregateMessages,
  ingestionFloor,
  renderThread,
  shouldMirror,
  resolveCounterpart,
  splitName,
} from "./events.js";
import { readThread, THREAD_WINDOW } from "./leads.js";

/** Hard ceiling on /sync pages drained in one pass — a cron re-runs every 5 min. */
const MAX_PAGES = Number(process.env.MATRIX_SYNC_MAX_PAGES) || 20;

export interface ConnectionSyncResult {
  connectionId: string;
  channel: string;
  runId: string;
  pages: number;
  eventsIngested: number;
  roomsTouched: number;
  conversationsRebuilt: number;
  leadsComputed: number;
  leadsSkippedUnchanged: number;
}

/** Every event of a room in one sync page (state + timeline, deduped). */
function collectRoomEvents(room: {
  timeline?: { events?: MatrixEvent[] };
  state?: { events?: MatrixEvent[] };
}): MatrixEvent[] {
  const seen = new Set<string>();
  const out: MatrixEvent[] = [];
  for (const ev of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])]) {
    if (!ev || typeof ev.event_id !== "string" || seen.has(ev.event_id)) continue;
    seen.add(ev.event_id);
    out.push(ev);
  }
  return out;
}

/**
 * BRONZE — drain `/sync` for one connection, mirroring in-scope events and
 * advancing the cursor transactionally.
 *
 * Room routing is state-event work, not guesswork: a room belongs to this
 * connection only when it has a member in the connection's bridge ghost
 * namespace. One access token carries every bridge's rooms, so each connection
 * keeps its own cursor and ignores the other channels' rooms.
 */
async function ingestBronze(
  conn: MatrixConnection,
): Promise<{ pages: number; eventsIngested: number; rooms: Set<string> }> {
  const floor = ingestionFloor();
  const rooms = new Set<string>();
  let cursor = conn.sinceToken;
  let pages = 0;
  let eventsIngested = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await sync(cursor);
    pages += 1;

    const joined = response.rooms?.join ?? {};
    const toInsert: NewMatrixRawEvent[] = [];
    const pageRooms: string[] = [];

    for (const [roomId, room] of Object.entries(joined)) {
      const events = collectRoomEvents(room);
      const counterpart = resolveCounterpart(events, conn.matrixUserId, conn.counterpartPrefix);
      if (!counterpart) continue; // another bridge's room — not this connection's

      pageRooms.push(roomId);
      for (const ev of events) {
        if (!shouldMirror(ev, floor)) continue; // ingestion floor — see CLAUDE.md
        toInsert.push({
          orgId: conn.orgId,
          brandId: conn.brandId,
          connectionId: conn.id,
          eventId: ev.event_id,
          roomId,
          sender: ev.sender,
          eventType: ev.type,
          stateKey: ev.state_key ?? null,
          originServerTs: new Date(ev.origin_server_ts),
          payload: ev as unknown as Record<string, unknown>,
        });
      }
    }

    const nextBatch = response.next_batch;

    // The cursor advances with the events it covers, in ONE transaction.
    await db.transaction(async (tx) => {
      for (let i = 0; i < toInsert.length; i += 500) {
        await tx
          .insert(matrixRawEvents)
          .values(toInsert.slice(i, i + 500))
          // event_id is globally unique — this is what makes a re-run insert nothing.
          .onConflictDoNothing({ target: matrixRawEvents.eventId });
      }
      await tx
        .update(matrixConnections)
        .set({ sinceToken: nextBatch, lastSyncedAt: new Date() })
        .where(eq(matrixConnections.id, conn.id));
    });

    eventsIngested += toInsert.length;
    for (const r of pageRooms) rooms.add(r);

    const noProgress = nextBatch === cursor;
    cursor = nextBatch;
    // Stop when the homeserver has nothing more for us.
    if (noProgress || Object.keys(joined).length === 0) break;
  }

  return { pages, eventsIngested, rooms };
}

/**
 * SILVER — rebuild the contact + conversation for one room, reading BRONZE back.
 *
 * Deterministic and idempotent: same bronze, same silver. Returns null when the
 * room carries no message yet (member state only), or when the counterpart can
 * no longer be resolved.
 */
async function rebuildRoom(
  conn: MatrixConnection,
  roomId: string,
): Promise<{ conversationId: string } | null> {
  const rows = await db
    .select()
    .from(matrixRawEvents)
    .where(and(eq(matrixRawEvents.connectionId, conn.id), eq(matrixRawEvents.roomId, roomId)))
    .orderBy(asc(matrixRawEvents.originServerTs), asc(matrixRawEvents.eventId));

  const events = rows.map((r) => r.payload as unknown as MatrixEvent);
  const counterpart = resolveCounterpart(events, conn.matrixUserId, conn.counterpartPrefix);
  if (!counterpart) return null;

  const aggregate = aggregateMessages(events, conn.matrixUserId);
  if (!aggregate) return null;

  const names = splitName(counterpart.displayName);
  const now = new Date();

  // Contact — natural key (org, brand, channel, channel_handle). A WhatsApp DM
  // has no email, which is exactly why this second key exists.
  const [contact] = await db
    .insert(contacts)
    .values({
      orgId: conn.orgId,
      brandId: conn.brandId,
      primaryEmail: null,
      phoneE164: counterpart.phoneE164,
      fullName: names.fullName,
      firstName: names.firstName,
      lastName: names.lastName,
      rawAttributes: {},
      consentStatus: "unknown",
      unsubscribed: false,
      source: "matrix",
      channel: conn.channel,
      channelHandle: counterpart.mxid,
      sourceConnectionId: conn.id,
      lastRebuiltAt: now,
    })
    .onConflictDoUpdate({
      target: [contacts.orgId, contacts.brandId, contacts.channel, contacts.channelHandle],
      set: {
        phoneE164: counterpart.phoneE164,
        fullName: names.fullName,
        firstName: names.firstName,
        lastName: names.lastName,
        sourceConnectionId: conn.id,
        lastRebuiltAt: now,
      },
    })
    .returning({ id: contacts.id });

  const [conversation] = await db
    .insert(conversations)
    .values({
      orgId: conn.orgId,
      brandId: conn.brandId,
      connectionId: conn.id,
      contactId: contact.id,
      channel: conn.channel,
      roomId,
      firstMessageAt: aggregate.firstMessageAt,
      lastMessageAt: aggregate.lastMessageAt,
      messageCount: aggregate.messageCount,
      inboundCount: aggregate.inboundCount,
      outboundCount: aggregate.outboundCount,
      lastEventId: aggregate.lastEventId,
      lastRebuiltAt: now,
    })
    .onConflictDoUpdate({
      target: [conversations.contactId, conversations.channel],
      set: {
        connectionId: conn.id,
        roomId,
        firstMessageAt: aggregate.firstMessageAt,
        lastMessageAt: aggregate.lastMessageAt,
        messageCount: aggregate.messageCount,
        inboundCount: aggregate.inboundCount,
        outboundCount: aggregate.outboundCount,
        lastEventId: aggregate.lastEventId,
        lastRebuiltAt: now,
      },
    })
    .returning({ id: conversations.id });

  return { conversationId: conversation.id };
}

/**
 * GOLD — recompute the lead for a conversation, but ONLY when its watermark
 * moved past the one the stored lead was computed through. That comparison is
 * what keeps the LLM bill near zero: an unchanged thread costs nothing on every
 * 5-minute tick.
 */
async function computeLead(
  conn: MatrixConnection,
  conversationId: string,
  runId: string,
): Promise<"computed" | "unchanged"> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conversation) throw new Error(`[crm-service][matrix] conversation ${conversationId} vanished`);

  const [existing] = await db
    .select()
    .from(matrixLeads)
    .where(eq(matrixLeads.conversationId, conversationId));
  if (existing && existing.computedThroughEventId === conversation.lastEventId) {
    return "unchanged";
  }

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, conversation.contactId));
  if (!contact) throw new Error(`[crm-service][matrix] contact ${conversation.contactId} vanished`);

  const rows = await db
    .select()
    .from(matrixRawEvents)
    .where(
      and(
        eq(matrixRawEvents.connectionId, conn.id),
        eq(matrixRawEvents.roomId, conversation.roomId),
      ),
    )
    .orderBy(asc(matrixRawEvents.originServerTs), asc(matrixRawEvents.eventId));

  const lines = renderThread(
    rows.map((r) => r.payload as unknown as MatrixEvent),
    conn.matrixUserId,
    THREAD_WINDOW,
  );

  const reading = await readThread(
    {
      channel: conversation.channel,
      contactName: contact.fullName,
      contactHandle: contact.channelHandle ?? "",
      lines,
    },
    {
      orgId: conn.orgId,
      // Persisted at connection-create time — the cron has no inbound identity.
      userId: conn.createdByUserId,
      runId,
      brandIds: [conn.brandId],
    },
  );

  await db
    .insert(matrixLeads)
    .values({
      orgId: conn.orgId,
      brandId: conn.brandId,
      conversationId,
      contactId: conversation.contactId,
      status: reading.status,
      nextStep: reading.nextStep,
      estimatedValueUsd: reading.estimatedValueUsd,
      summary: reading.summary,
      computedThroughEventId: conversation.lastEventId,
      model: reading.model,
      runId,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: matrixLeads.conversationId,
      set: {
        status: reading.status,
        nextStep: reading.nextStep,
        estimatedValueUsd: reading.estimatedValueUsd,
        summary: reading.summary,
        computedThroughEventId: conversation.lastEventId,
        model: reading.model,
        runId,
        computedAt: new Date(),
      },
    });

  return "computed";
}

/**
 * One full pass for one connection, under its OWN org run.
 *
 * The spend belongs to the org that owns the connection, so the run is an ORG
 * run built from the connection row's org + creator — not a platform run. The
 * cron carries no inbound identity; the connection row IS the carrier.
 *
 * Fails loud: any error marks the connection `error` with the message, fails the
 * run, and rethrows to the caller.
 */
export async function syncConnection(conn: MatrixConnection): Promise<ConnectionSyncResult> {
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "matrix.sync",
  });

  try {
    const bronze = await ingestBronze(conn);

    let conversationsRebuilt = 0;
    let leadsComputed = 0;
    let leadsSkippedUnchanged = 0;

    for (const roomId of bronze.rooms) {
      const rebuilt = await rebuildRoom(conn, roomId);
      if (!rebuilt) continue;
      conversationsRebuilt += 1;
      const outcome = await computeLead(conn, rebuilt.conversationId, run.id);
      if (outcome === "computed") leadsComputed += 1;
      else leadsSkippedUnchanged += 1;
    }

    await db
      .update(matrixConnections)
      .set({ status: "active", lastError: null, lastRunId: run.id })
      .where(eq(matrixConnections.id, conn.id));
    await updateRun(run.id, "completed", {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
      brandIds: [conn.brandId],
    });

    return {
      connectionId: conn.id,
      channel: conn.channel,
      runId: run.id,
      pages: bronze.pages,
      eventsIngested: bronze.eventsIngested,
      roomsTouched: bronze.rooms.size,
      conversationsRebuilt,
      leadsComputed,
      leadsSkippedUnchanged,
    };
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(matrixConnections)
      .set({ status: "error", lastError: message, lastRunId: run.id })
      .where(eq(matrixConnections.id, conn.id));
    await updateRun(run.id, "failed", {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
      brandIds: [conn.brandId],
    }).catch((e) => console.error("[crm-service][matrix] failed to close run:", e));
    throw err;
  }
}

export interface SyncPassResult {
  connections: number;
  results: ConnectionSyncResult[];
  failures: { connectionId: string; error: string }[];
}

/**
 * Run a sync pass over every active connection (or one, when `connectionId` is
 * given). Per-connection failures are recorded on the connection row AND
 * returned — never swallowed — so one broken bridge does not stop the others.
 */
export async function runSyncPass(connectionId?: string): Promise<SyncPassResult> {
  const where = connectionId
    ? eq(matrixConnections.id, connectionId)
    : inArray(matrixConnections.status, ["active", "error"]);

  const connections = await db.select().from(matrixConnections).where(where);

  const results: ConnectionSyncResult[] = [];
  const failures: { connectionId: string; error: string }[] = [];

  for (const conn of connections) {
    if (conn.status === "paused") continue;
    try {
      results.push(await syncConnection(conn));
    } catch (err) {
      console.error(`[crm-service][matrix] sync failed for connection ${conn.id}:`, err);
      failures.push({ connectionId: conn.id, error: (err as Error).message });
    }
  }

  return { connections: connections.length, results, failures };
}

/**
 * Rebuild silver + gold for a connection from BRONZE alone — no /sync call.
 *
 * This is the "truncate the leads table and re-run" path: every room already
 * mirrored in bronze is re-aggregated and re-read, reproducing the gold layer.
 */
export async function rebuildFromBronze(conn: MatrixConnection): Promise<ConnectionSyncResult> {
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "matrix.rebuild",
  });

  try {
    const roomRows = await db
      .selectDistinct({ roomId: matrixRawEvents.roomId })
      .from(matrixRawEvents)
      .where(eq(matrixRawEvents.connectionId, conn.id));

    let conversationsRebuilt = 0;
    let leadsComputed = 0;
    let leadsSkippedUnchanged = 0;

    for (const { roomId } of roomRows) {
      const rebuilt = await rebuildRoom(conn, roomId);
      if (!rebuilt) continue;
      conversationsRebuilt += 1;
      const outcome = await computeLead(conn, rebuilt.conversationId, run.id);
      if (outcome === "computed") leadsComputed += 1;
      else leadsSkippedUnchanged += 1;
    }

    await updateRun(run.id, "completed", {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
      brandIds: [conn.brandId],
    });

    return {
      connectionId: conn.id,
      channel: conn.channel,
      runId: run.id,
      pages: 0,
      eventsIngested: 0,
      roomsTouched: roomRows.length,
      conversationsRebuilt,
      leadsComputed,
      leadsSkippedUnchanged,
    };
  } catch (err) {
    await updateRun(run.id, "failed", {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
      brandIds: [conn.brandId],
    }).catch((e) => console.error("[crm-service][matrix] failed to close run:", e));
    throw err;
  }
}
