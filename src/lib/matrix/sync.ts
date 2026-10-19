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
 *            conversation's watermark moved past the stored one, AND only
 *            once Jev judged the conversation about the brand
 *            (people/relevance.ts): a personal thread is never read.
 *
 * Because silver and gold are both rebuilt FROM bronze, truncating the leads
 * table and re-running reproduces it.
 */

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixGhostPhones,
  matrixGroupMembers,
  matrixGroups,
  matrixLinks,
  matrixLeads,
  matrixRawEvents,
  type MatrixConnection,
  type NewMatrixRawEvent,
} from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { platformAccessToken, sync, type MatrixEvent } from "./client.js";
import {
  aggregateMessages,
  groupMembers,
  ingestionFloor,
  isGroupRoom,
  renderThread,
  roomName,
  shouldMirror,
  resolveCounterpart,
  splitName,
} from "./events.js";
import { readThread, THREAD_WINDOW } from "./leads.js";
import { readAccountUsers } from "../people/account-users.js";
import { announceAssistantMatrixMessages } from "../assistant-pings.js";
import { overlayVoiceTranscripts } from "./voice-notes.js";
import { deliverDueReplies, detectReplies, type ReplyDetection } from "../reply-trigger/watch.js";
import {
  hidesConversation,
  judgeAndRecord,
  matrixLoader,
  matrixPlans,
  personViewsOfConversations,
  matrixMarkers,
  readBrandContext,
  type JudgePassSummary,
} from "../people/relevance.js";

/**
 * One mirror at a time per connection: the live watch and the 5-min pass share
 * the `/sync` cursor. The pass waits for a live tick in flight; the live watch
 * skips a connection the pass holds.
 */
const connectionLocks = new Map<string, Promise<unknown>>();

async function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  while (connectionLocks.has(connectionId)) await connectionLocks.get(connectionId)!.catch(() => undefined);
  const p = fn();
  connectionLocks.set(connectionId, p);
  try {
    return await p;
  } finally {
    connectionLocks.delete(connectionId);
  }
}

/** Rooms each connection already mirrors, read once per process then kept up to date by the ingest. */
const knownRoomsCache = new Map<string, Set<string>>();

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
  /** Conversations Jev judged not about the brand, or holding nothing a person wrote: never read by the lead model. */
  leadsSkippedNotBusiness: number;
  /** Conversations with no verdict yet (Jev or brand-service failed): read once judged. */
  leadsDeferredUnjudged: number;
  relevance: JudgePassSummary;
  /** Answers in threads our campaigns opened (lib/reply-trigger/); null = the watch failed this pass (logged). */
  replies: ReplyDetection | null;
}

/**
 * Jev judges, BEFORE the paid lead reading, whether each conversation is about
 * the brand (people/relevance.ts, recorded per conversation, re-judged only
 * when it moved). Candidates are the conversations rebuilt now plus every one
 * of the connection whose lead is behind its watermark, so a conversation left
 * unjudged by a failure is picked up on the next pass.
 */
async function gateLeadReading(
  conn: MatrixConnection,
  rebuilt: string[],
  runId: string,
): Promise<{ cleared: string[]; notBusiness: number; deferred: number; relevance: JudgePassSummary }> {
  const behind = (await db.execute(sql`
    SELECT v.id FROM conversations v
    LEFT JOIN matrix_leads l ON l.conversation_id = v.id
    WHERE v.connection_id = ${conn.id}
      AND (l.id IS NULL OR l.computed_through_event_id <> v.last_event_id)
  `)) as unknown as { id: string }[];
  const ids = [...new Set([...rebuilt, ...behind.map((b) => b.id)])];
  const empty: JudgePassSummary = { status: "ok", reused: 0, judged: 0, noContent: 0, pending: 0, model: null, error: null };
  if (ids.length === 0) return { cleared: [], notBusiness: 0, deferred: 0, relevance: empty };
  const identity = { orgId: conn.orgId, userId: conn.createdByUserId, runId, brandId: conn.brandId };
  let context;
  let users;
  try {
    // Gmail is not read here: only the Matrix accounts' users (people/account-users.ts).
    [context, users] = await Promise.all([readBrandContext(identity), readAccountUsers(identity, false)]);
  } catch (err) {
    const error = `brand / user context: ${(err as Error).message}`.slice(0, 1000);
    console.error(`[crm-service][matrix] relevance gate skipped connection=${conn.id}: ${error}`);
    return { cleared: [], notBusiness: 0, deferred: ids.length, relevance: { ...empty, status: "failed", pending: ids.length, error } };
  }
  const markers = await matrixMarkers(ids);
  const plans = matrixPlans(ids, markers, context, users);
  const views = await personViewsOfConversations(conn.orgId, conn.brandId, plans.map((p) => p.plan));
  const { verdicts, summary } = await judgeAndRecord(identity, context, plans, matrixLoader(users, views));
  if (summary.error) console.error(`[crm-service][matrix] relevance judgments connection=${conn.id}: ${summary.error}`);
  const cleared: string[] = [];
  let notBusiness = 0;
  let deferred = 0;
  for (const p of plans) {
    const v = verdicts.get(p.key);
    if (!v) deferred++;
    else if (hidesConversation(v)) notBusiness++;
    else cleared.push(p.plan);
  }
  return { cleared, notBusiness, deferred, relevance: summary };
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

  // A self-serve connection syncs as its brand's own dedicated account; a
  // hand-registered one as the platform account. Two kinds of row, not a fallback.
  const token = conn.accessToken ?? platformAccessToken();

  // Rooms this connection already mirrors. An INCREMENTAL /sync page carries a
  // room's new messages without its member state, so routing on the page alone
  // dropped every message of a known room that arrived without a membership
  // change (a message we sent, 2026-10-12, and incoming DMs alike). A room
  // routed once stays this connection's; its counterpart is re-read from bronze.
  // Read once per process (the live watch calls this every few seconds), then grown below.
  let knownRooms = knownRoomsCache.get(conn.id);
  if (!knownRooms) {
    knownRooms = new Set(
      (
        await db
          .selectDistinct({ roomId: matrixRawEvents.roomId })
          .from(matrixRawEvents)
          .where(eq(matrixRawEvents.connectionId, conn.id))
      ).map((r) => r.roomId),
    );
    knownRoomsCache.set(conn.id, knownRooms);
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await sync(cursor, token);
    pages += 1;

    const joined = response.rooms?.join ?? {};
    const toInsert: NewMatrixRawEvent[] = [];
    const pageRooms: string[] = [];

    for (const [roomId, room] of Object.entries(joined)) {
      const events = collectRoomEvents(room);
      const counterpart = resolveCounterpart(events, conn.matrixUserId, conn.counterpartPrefix);
      // Neither routed by this page's members nor known: another bridge's room.
      if (!counterpart && !knownRooms.has(roomId)) continue;
      knownRooms.add(roomId);

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

/** The phone the bridge resolved to this ghost on a send, if any. */
async function ghostPhone(mxid: string): Promise<string | null> {
  const [row] = await db
    .select({ phone: matrixGhostPhones.phone })
    .from(matrixGhostPhones)
    .where(eq(matrixGhostPhones.ghostMxid, mxid));
  return row?.phone ?? null;
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
  if (isGroupRoom(events, conn.matrixUserId, conn.counterpartPrefix)) {
    await rebuildGroup(conn, roomId);
    return null;
  }
  const counterpart = resolveCounterpart(events, conn.matrixUserId, conn.counterpartPrefix);
  if (!counterpart) return null;

  const aggregate = aggregateMessages(events, conn.matrixUserId);
  if (!aggregate) return null;

  const names = splitName(counterpart.displayName);
  const now = new Date();
  // WhatsApp names most counterparts by an opaque LID ghost, which encodes no
  // phone. A send that resolved a phone to this ghost recorded the pairing (the
  // bridge's own answer): read it back so the contact carries its number.
  const phoneE164 = counterpart.phoneE164 ?? (await ghostPhone(counterpart.mxid));

  // Contact — natural key (org, brand, connection, channel, channel_handle). A
  // WhatsApp DM has no email, which is exactly why this key exists; the
  // connection is in it because a brand links several accounts per channel.
  const [contact] = await db
    .insert(contacts)
    .values({
      orgId: conn.orgId,
      brandId: conn.brandId,
      primaryEmail: null,
      phoneE164,
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
      target: [contacts.orgId, contacts.brandId, contacts.sourceConnectionId, contacts.channel, contacts.channelHandle],
      set: {
        phoneE164,
        fullName: names.fullName,
        firstName: names.firstName,
        lastName: names.lastName,
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

  // A room is ONE conversation. A row of this room on another contact is what an
  // earlier counterpart rule left behind (the latest ghost won, 2026-10-12): two
  // rows would emit every message twice and split the thread between two people.
  await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.connectionId, conn.id),
        eq(conversations.roomId, roomId),
        ne(conversations.id, conversation.id),
      ),
    );

  return { conversationId: conversation.id };
}

/** Digits of the brand's own linked accounts on this channel: their ghosts are never members. */
async function ownLoginDigits(conn: MatrixConnection): Promise<Set<string>> {
  const links = await db
    .select({ remoteLoginId: matrixLinks.remoteLoginId })
    .from(matrixLinks)
    .where(and(eq(matrixLinks.orgId, conn.orgId), eq(matrixLinks.brandId, conn.brandId), eq(matrixLinks.channel, conn.channel)));
  return new Set(links.map((l) => (l.remoteLoginId ?? "").replace(/^\+/, "")).filter((d) => /^\d{6,20}$/.test(d)));
}

/**
 * SILVER for a GROUP room (RELATIONSHIP-TAGS-1014): the group, and one contact
 * per member ghost (same natural key as a DM counterpart, so a member the brand
 * also talks to in a DM is the SAME contact row). The room is no conversation:
 * any conversation row an earlier rule made of it (its first-joined member) is
 * dropped. Reads the room's events across the brand: a group two linked
 * accounts share is one room whose events either may have mirrored.
 */
async function rebuildGroup(caller: MatrixConnection, roomId: string): Promise<void> {
  // The connection that first built the group keeps it (its members' contact
  // rows hang on it), so two accounts in one group never flip it between them.
  const [existing] = await db
    .select({ connectionId: matrixGroups.connectionId })
    .from(matrixGroups)
    .where(and(eq(matrixGroups.orgId, caller.orgId), eq(matrixGroups.brandId, caller.brandId), eq(matrixGroups.roomId, roomId)));
  const [owner] =
    existing && existing.connectionId !== caller.id
      ? await db.select().from(matrixConnections).where(eq(matrixConnections.id, existing.connectionId))
      : [caller];
  const conn = owner ?? caller;
  const rows = await db
    .select({ payload: matrixRawEvents.payload })
    .from(matrixRawEvents)
    .where(and(eq(matrixRawEvents.orgId, conn.orgId), eq(matrixRawEvents.brandId, conn.brandId), eq(matrixRawEvents.roomId, roomId)))
    .orderBy(asc(matrixRawEvents.originServerTs), asc(matrixRawEvents.eventId));
  const events = rows.map((r) => r.payload as unknown as MatrixEvent);
  const own = await ownLoginDigits(conn);
  const members = groupMembers(events, conn.matrixUserId, conn.counterpartPrefix).filter(
    (m) => !own.has(m.mxid.slice(conn.counterpartPrefix.length).split(":")[0] ?? ""),
  );
  const messageCount = events.filter((e) => e.type === "m.room.message").length;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .delete(conversations)
      .where(and(eq(conversations.orgId, conn.orgId), eq(conversations.brandId, conn.brandId), eq(conversations.roomId, roomId)));
    const [group] = await tx
      .insert(matrixGroups)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        connectionId: conn.id,
        channel: conn.channel,
        roomId,
        name: roomName(events),
        memberCount: members.filter((m) => m.membership === "join" || m.membership === "invite").length,
        messageCount,
        lastRebuiltAt: now,
      })
      .onConflictDoUpdate({
        target: [matrixGroups.orgId, matrixGroups.brandId, matrixGroups.roomId],
        set: {
          connectionId: conn.id,
          channel: conn.channel,
          name: roomName(events),
          memberCount: members.filter((m) => m.membership === "join" || m.membership === "invite").length,
          messageCount,
          lastRebuiltAt: now,
        },
      })
      .returning({ id: matrixGroups.id });
    if (members.length === 0) {
      await tx.delete(matrixGroupMembers).where(eq(matrixGroupMembers.groupId, group.id));
      return;
    }

    // The phone a send resolved to a LID ghost (the bridge's own answer).
    const ghostPhones = new Map<string, string>();
    const mxids = members.map((m) => m.mxid);
    for (let i = 0; i < mxids.length; i += 1000) {
      const found = await tx
        .select({ ghost: matrixGhostPhones.ghostMxid, phone: matrixGhostPhones.phone })
        .from(matrixGhostPhones)
        .where(inArray(matrixGhostPhones.ghostMxid, mxids.slice(i, i + 1000)));
      for (const f of found) ghostPhones.set(f.ghost, f.phone);
    }

    const contactIdOf = new Map<string, string>();
    for (let i = 0; i < members.length; i += 500) {
      const batch = members.slice(i, i + 500);
      const inserted = await tx
        .insert(contacts)
        .values(
          batch.map((m) => {
            const names = splitName(m.displayName);
            return {
              orgId: conn.orgId,
              brandId: conn.brandId,
              primaryEmail: null,
              phoneE164: m.phoneE164 ?? ghostPhones.get(m.mxid) ?? null,
              fullName: names.fullName,
              firstName: names.firstName,
              lastName: names.lastName,
              rawAttributes: {},
              consentStatus: "unknown" as const,
              unsubscribed: false,
              source: "matrix",
              channel: conn.channel,
              channelHandle: m.mxid,
              sourceConnectionId: conn.id,
              lastRebuiltAt: now,
            };
          }),
        )
        .onConflictDoUpdate({
          target: [contacts.orgId, contacts.brandId, contacts.sourceConnectionId, contacts.channel, contacts.channelHandle],
          // A DM rebuild owns the counterpart's name; a group only fills what is missing.
          set: {
            phoneE164: sql`COALESCE(${contacts.phoneE164}, excluded.phone_e164)`,
            fullName: sql`COALESCE(${contacts.fullName}, excluded.full_name)`,
            firstName: sql`COALESCE(${contacts.firstName}, excluded.first_name)`,
            lastName: sql`COALESCE(${contacts.lastName}, excluded.last_name)`,
            lastRebuiltAt: now,
          },
        })
        .returning({ id: contacts.id, handle: contacts.channelHandle });
      for (const r of inserted) if (r.handle) contactIdOf.set(r.handle, r.id);
    }

    await tx.delete(matrixGroupMembers).where(eq(matrixGroupMembers.groupId, group.id));
    for (let i = 0; i < members.length; i += 500) {
      await tx.insert(matrixGroupMembers).values(
        members.slice(i, i + 500).map((m) => ({
          orgId: conn.orgId,
          brandId: conn.brandId,
          groupId: group.id,
          roomId,
          contactId: contactIdOf.get(m.mxid)!,
          ghostMxid: m.mxid,
          membership: m.membership,
          joinedAt: m.joinedAt,
          authoredCount: m.authoredCount,
          firstAuthoredAt: m.firstAuthoredAt,
          lastAuthoredAt: m.lastAuthoredAt,
        })),
      );
    }
  });
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
    await overlayVoiceTranscripts(rows.map((r) => r.payload as unknown as MatrixEvent)),
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
  return withConnectionLock(conn.id, async () => {
    // Re-read: the live watch may have moved the cursor while this pass waited.
    const [fresh] = await db.select().from(matrixConnections).where(eq(matrixConnections.id, conn.id));
    return syncConnectionLocked(fresh ?? conn);
  });
}

async function syncConnectionLocked(conn: MatrixConnection): Promise<ConnectionSyncResult> {
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "matrix.sync",
  });

  try {
    const bronze = await ingestBronze(conn);

    const rebuiltIds: string[] = [];
    for (const roomId of bronze.rooms) {
      const rebuilt = await rebuildRoom(conn, roomId);
      if (rebuilt) rebuiltIds.push(rebuilt.conversationId);
    }
    const conversationsRebuilt = rebuiltIds.length;
    const gate = await gateLeadReading(conn, rebuiltIds, run.id);
    let leadsComputed = 0;
    let leadsSkippedUnchanged = 0;
    for (const conversationId of gate.cleared) {
      const outcome = await computeLead(conn, conversationId, run.id);
      if (outcome === "computed") leadsComputed += 1;
      else leadsSkippedUnchanged += 1;
    }

    // The owner's Telegram ping per message with our assistant (SOPHIE-TG-PING-1018): never awaited, never throws.
    void announceAssistantMatrixMessages(conn);

    // After bronze + silver: the timeline already serves what we are about to report.
    let replies: ReplyDetection | null = null;
    try {
      replies = await detectReplies(conn, async () => run.id);
      // A voice note's ping waited for its words (SOPHIE-VOICE-1019).
      if (replies.voiceNotesTranscribed) void announceAssistantMatrixMessages(conn);
    } catch (err) {
      // The mirror itself is fine; the next pass re-reads every campaign thread that moved.
      console.error(`[crm-service][reply-trigger] detection failed for connection ${conn.id}:`, err);
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
      leadsSkippedNotBusiness: gate.notBusiness,
      leadsDeferredUnjudged: gate.deferred,
      relevance: gate.relevance,
      replies,
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

  // Report the answers this pass found (and retry the due ones) to campaign-service.
  if (process.env.REPLY_TRIGGER_DELIVERY !== "off") {
    try {
      await deliverDueReplies();
    } catch (err) {
      console.error("[crm-service][reply-trigger] delivery failed:", err);
    }
  }

  return { connections: connections.length, results, failures };
}

// ─── the live watch ─────────────────────────────────────────────────────────

/** How often the live watch mirrors every connection (REPLY-ANY-LEAD-1015: a lead's message is answered in seconds). */
export const MATRIX_LIVE_INTERVAL_MS = Number(process.env.MATRIX_LIVE_INTERVAL_MS) || 10_000;

/**
 * The live half of the mirror, for one connection: bronze, silver of the rooms
 * that moved, and the reply watch on those rooms. No lead reading (paid, done by
 * the 5-min pass on every conversation whose lead is behind) and no run unless
 * something needs one (a Jev call, a rep phone read): a quiet tick opens nothing.
 * Returns the bursts it recorded as pending.
 */
export async function liveSyncConnection(conn: MatrixConnection): Promise<number> {
  if (connectionLocks.has(conn.id)) return 0; // the 5-min pass holds it
  return withConnectionLock(conn.id, async () => {
    const [current] = await db.select().from(matrixConnections).where(eq(matrixConnections.id, conn.id));
    if (!current || current.status === "paused") return 0;
    const bronze = await ingestBronze(current);
    if (bronze.eventsIngested === 0) return 0;
    for (const roomId of bronze.rooms) await rebuildRoom(current, roomId);
    // The owner's Telegram ping per message with our assistant (SOPHIE-TG-PING-1018): never awaited, never throws.
    void announceAssistantMatrixMessages(current);

    const ids = { orgId: current.orgId, userId: current.createdByUserId, brandIds: [current.brandId] };
    let runId: Promise<string> | null = null;
    const lazyRun = () =>
      (runId ??= createRun({ ...ids, serviceName: SERVICE_NAME, taskName: "matrix.live" }).then((r) => r.id));
    try {
      const replies = await detectReplies(current, lazyRun, Date.now(), { rooms: [...bronze.rooms] });
      // A voice note's ping waited for its words (SOPHIE-VOICE-1019).
      if (replies.voiceNotesTranscribed) void announceAssistantMatrixMessages(current);
      if (runId) await updateRun(await runId, "completed", { ...ids, runId: await runId });
      return replies.detected;
    } catch (err) {
      if (runId) await updateRun(await runId, "failed", { ...ids, runId: await runId }).catch(() => undefined);
      throw err;
    }
  });
}

let liveRunning = false;

/** One live tick over every active connection; then reports what it found. Never two at once. */
export async function runLiveTick(): Promise<void> {
  if (liveRunning) return;
  liveRunning = true;
  try {
    const connections = await db
      .select()
      .from(matrixConnections)
      .where(inArray(matrixConnections.status, ["active", "error"]));
    let detected = 0;
    for (const conn of connections) {
      try {
        detected += await liveSyncConnection(conn);
      } catch (err) {
        // The 5-min pass records a broken connection on its row; the live watch only logs.
        console.error(`[crm-service][matrix-live] connection ${conn.id}: ${(err as Error).message}`);
      }
    }
    if (detected > 0 && process.env.REPLY_TRIGGER_DELIVERY !== "off") await deliverDueReplies();
  } finally {
    liveRunning = false;
  }
}

/** In-process, every MATRIX_LIVE_INTERVAL_MS, first tick 60s after boot. */
export function startMatrixLiveWatch(): void {
  if (process.env.MATRIX_LIVE_WATCH === "off") return;
  const tick = () => runLiveTick().catch((e) => console.error("[crm-service][matrix-live] tick failed:", e));
  setTimeout(() => {
    tick();
    setInterval(tick, MATRIX_LIVE_INTERVAL_MS).unref();
  }, 60_000).unref();
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

    const rebuiltIds: string[] = [];
    for (const { roomId } of roomRows) {
      const rebuilt = await rebuildRoom(conn, roomId);
      if (rebuilt) rebuiltIds.push(rebuilt.conversationId);
    }
    const conversationsRebuilt = rebuiltIds.length;
    const gate = await gateLeadReading(conn, rebuiltIds, run.id);
    let leadsComputed = 0;
    let leadsSkippedUnchanged = 0;
    for (const conversationId of gate.cleared) {
      const outcome = await computeLead(conn, conversationId, run.id);
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
      leadsSkippedNotBusiness: gate.notBusiness,
      leadsDeferredUnjudged: gate.deferred,
      relevance: gate.relevance,
      replies: null,
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
