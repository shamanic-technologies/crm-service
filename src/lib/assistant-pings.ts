/**
 * THE OWNER'S TELEGRAM PING FOR EVERY MESSAGE WITH OUR ASSISTANT
 * (SOPHIE-TG-PING-1018, owner 2026-10-18: « Quand il y a une communication entre
 * Sophie et un user, dans un sens ou dans l'autre, tu peux me notifier sur
 * Telegram please? »). One ping per MESSAGE, both directions: the person writing
 * to the assistant, and the assistant answering.
 *
 * Who the assistant is, read from data, never a name in code: the staff Unibox
 * scope (`COPILOT_UNIBOX_ORG_ID` + `COPILOT_UNIBOX_BRAND_ID`, the same scope the
 * conversation-start pings call "a conversation with us"):
 *  - the web Copilot (chat-service pushes each turn, `copilot/messages.ts`);
 *  - every linked messaging account of that scope with automation ON
 *    (`matrix_links.automation_allowed`): a message in one of its one-to-one
 *    threads. Its name = the account's persona name (SOPHIE-WA-1016).
 *
 * Fleet rules, as the conversation-start pings:
 *  - never the owner's own actions: a staff address, a user id ever seen with
 *    one, a number of the brand's own team (its linked numbers, the sales rep,
 *    the org's members), and a message TYPED BY HAND on the assistant's account
 *    (a person of ours writing, not the assistant: every assistant message goes
 *    out through the one WhatsApp send path, `whatsapp_sends`);
 *  - never fails or slows what it reports: called after the push answered /
 *    after the mirror wrote, never awaited by them, never throws;
 *  - never twice: one `assistant_message_pings` row per message (UNIQUE),
 *    written BEFORE the send. At most once: a failed send is marked, not retried.
 *  - never history: a linked account's messages mirrored before the watch first
 *    looked at it (`matrix_connections.assistant_ping_since`) are never pinged.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  assistantMessagePings,
  matrixConnections,
  matrixLinks,
  people,
  type MatrixConnection,
} from "../db/schema.js";
import { COPILOT_SENDER_NAME, copilotDestination, type CopilotDestination } from "./copilot/messages.js";
import { isStaffActor, mintPersonId, readOrg, readUserName, uniboxThreadUrl } from "./conversation-pings.js";
import type { MatrixEvent } from "./matrix/client.js";
import { editTarget, humanText, phoneFromMxid } from "./matrix/events.js";
import { isVoiceNote, withVoiceTranscripts } from "./matrix/voice-notes.js";
import { normalizeEmail } from "./people/identity.js";
import type { SiblingIdentity } from "./people/siblings.js";
import { ownTeamMatch, readOwnTeam } from "./reply-trigger/own-team.js";
import { createRun, updateRun } from "./runs-client.js";
import { isStaffEmail, sendOwnerTelegram } from "./owner-telegram.js";

const SERVICE_NAME = "crm-service";
const MESSAGE_MAX = 500;
/** A mirrored message older than this is never pinged (the scan stays bounded). */
export const ASSISTANT_PING_LOOKBACK_MS = 24 * 3_600_000;
/** How long a voice note's ping waits for its transcript before it is decided without words. */
export const VOICE_NOTE_PING_WAIT_MS = 10 * 60_000;

export const ASSISTANT_PING_SKIPS = {
  staff: "staff",
  handTyped: "hand_typed",
  notConversation: "not_conversation",
  noText: "no_text",
} as const;

const CHANNEL_LABEL: Record<string, string> = {
  chat: "web chat",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  telegram: "Telegram",
  discord: "Discord",
};

// ─── pure ───────────────────────────────────────────────────────────────────

const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

export interface AssistantPingContent {
  channel: string;
  direction: "inbound" | "outbound";
  assistantName: string;
  /** The person's name, when known. */
  name: string | null;
  phone: string | null;
  email: string | null;
  orgName: string | null;
  text: string;
  threadUrl: string | null;
}

/**
 * PURE: the message. Plain text, one fact per line:
 *
 *   Jane Doe → Sophie (WhatsApp)
 *   Who: Jane Doe, +33612345678, jane@acme.com
 *   Message: "How much is it?"
 *   Thread: https://dashboard.distribute.you/v2/orgs/…/unibox?person=…
 */
export function composeAssistantPingText(c: AssistantPingContent): string {
  const person = c.name ?? c.phone ?? c.email ?? "Someone";
  const [from, to] = c.direction === "inbound" ? [person, c.assistantName] : [c.assistantName, person];
  const lines = [`${from} → ${to} (${CHANNEL_LABEL[c.channel] ?? c.channel})`];
  const who = [c.name, c.phone, c.email].filter((x): x is string => !!x);
  if (who.length > 0) lines.push(`Who: ${who.join(", ")}`);
  if (c.orgName) lines.push(`Org: ${c.orgName}`);
  lines.push(`Message: "${clip(c.text, MESSAGE_MAX)}"`);
  if (c.threadUrl) lines.push(`Thread: ${c.threadUrl}`);
  return lines.join("\n");
}

export interface OurSend {
  eventId: string | null;
  text: string;
}

/**
 * PURE: what one mirrored event of the assistant's account is. Outbound = sent
 * as the account; it is the ASSISTANT only when it is one of our sends (its
 * event id, or its text while the send's event id is not recorded yet), else a
 * person of ours typed it by hand on the account.
 *
 * An edit is no new message, EXCEPT when the message it rewrites (same sender)
 * carried no words: WhatsApp delivers a message the bridge could not decrypt as
 * a notice, then the real words as an edit of it (`foldEdits`). `replaced` = the
 * rewritten event when mirrored, else null.
 */
export function classifyAssistantEvent(
  e: MatrixEvent,
  accountMxid: string,
  ours: OurSend[],
  replaced: MatrixEvent | null = null,
): { direction: "inbound" | "outbound"; text: string } | { skip: string } {
  const isEdit = editTarget(e) !== null;
  const revealsWords = isEdit && !!replaced && replaced.sender === e.sender && !humanText(replaced.content);
  const text = !isEdit
    ? humanText(e.content)
    : revealsWords
      ? humanText(e.content?.["m.new_content"] as Record<string, unknown> | undefined)
      : "";
  if (!text) return { skip: ASSISTANT_PING_SKIPS.noText };
  if (e.sender !== accountMxid) return { direction: "inbound", text };
  const ourIds = new Set(ours.map((s) => s.eventId).filter((x): x is string => !!x));
  const ourTexts = new Set(ours.map((s) => s.text.trim()).filter((t) => t.length > 0));
  if (ourIds.has(e.event_id) || ourTexts.has(text.trim())) return { direction: "outbound", text };
  return { skip: ASSISTANT_PING_SKIPS.handTyped };
}

// ─── shared ─────────────────────────────────────────────────────────────────

/** Each lookup on its own: one that fails drops its line from the message, logged, never the ping. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[crm-service] assistant ping: ${what} unreadable:`, (err as Error).message);
    return null;
  }
}

interface Claim {
  source: "copilot" | "matrix";
  messageRef: string;
  channel: string;
  direction: "inbound" | "outbound";
  connectionId?: string | null;
  messageAt: Date;
  status?: "pending" | "skipped";
  reason?: string | null;
}

/** Records the message; true when THIS call recorded it (the only one that may send). */
async function claim(c: Claim): Promise<string | null> {
  const [row] = await db
    .insert(assistantMessagePings)
    .values({
      source: c.source,
      messageRef: c.messageRef,
      channel: c.channel,
      direction: c.direction,
      connectionId: c.connectionId ?? null,
      messageAt: c.messageAt,
      status: c.status ?? "pending",
      reason: c.reason ?? null,
    })
    .onConflictDoNothing({ target: [assistantMessagePings.source, assistantMessagePings.messageRef] })
    .returning({ id: assistantMessagePings.id });
  return row?.id ?? null;
}

async function deliver(pingId: string, text: string): Promise<void> {
  const result = await sendOwnerTelegram(text);
  await db
    .update(assistantMessagePings)
    .set({
      status: result.status,
      telegramMessageId: result.status === "sent" ? result.messageId : null,
      error: result.status === "sent" ? null : result.error,
      text,
      updatedAt: new Date(),
    })
    .where(eq(assistantMessagePings.id, pingId));
  if (result.status === "sent") console.log(`[crm-service] assistant ping ${pingId} sent (telegram message ${result.messageId})`);
}

async function threadUrlFor(dest: CopilotDestination, identityKey: string, personId: string | null, identity: SiblingIdentity): Promise<string | null> {
  const staffOrg = await attempt("staff org Clerk id", () => readOrg(dest.orgId, identity));
  if (!staffOrg?.externalId) {
    console.error(`[crm-service] assistant ping: no Clerk id for the staff org ${dest.orgId}: sent without a thread link`);
    return null;
  }
  const id = personId ?? (await attempt("person id", () => mintPersonId(dest, identityKey)));
  return id ? uniboxThreadUrl(staffOrg.externalId, dest.brandId, id) : null;
}

/** The assistant accounts of the staff scope: linked, automation on. Keyed on their connection. */
async function assistantAccounts(dest: CopilotDestination): Promise<Map<string, { personaName: string | null }>> {
  const rows = await db
    .select({ connectionId: matrixLinks.connectionId, personaName: matrixLinks.personaName })
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.orgId, dest.orgId),
        eq(matrixLinks.brandId, dest.brandId),
        eq(matrixLinks.status, "linked"),
        eq(matrixLinks.automationAllowed, true),
      ),
    );
  const out = new Map<string, { personaName: string | null }>();
  for (const r of rows) if (r.connectionId) out.set(r.connectionId, { personaName: r.personaName?.trim() || null });
  return out;
}

/** The web Copilot's name: the persona the scope's assistant accounts share, else "AI Copilot". */
async function copilotName(dest: CopilotDestination): Promise<string> {
  const names = new Set([...(await assistantAccounts(dest)).values()].map((a) => a.personaName).filter((n): n is string => !!n));
  return names.size === 1 ? [...names][0] : COPILOT_SENDER_NAME;
}

// ─── the web Copilot (called by the push route, never awaited) ──────────────

export interface CopilotPushed {
  orgId: string;
  userId: string;
  email: string;
  displayName?: string | null;
  sessionId: string;
  messages: { messageId: string; role: "user" | "assistant"; text: string; at: string }[];
}

/** After a Copilot turn is stored: one ping per NEW message, both roles. Never throws. */
export async function announceCopilotMessages(turn: CopilotPushed, newMessageIds: string[], runId: string): Promise<void> {
  try {
    const dest = copilotDestination();
    const email = normalizeEmail(turn.email);
    if (!dest || !email) return;
    const fresh = new Set(newMessageIds);
    const messages = turn.messages.filter((m) => fresh.has(m.messageId) && m.text.trim());
    if (messages.length === 0) return;
    const staff = await isStaffActor(email, turn.userId);
    const claimed: { id: string; message: CopilotPushed["messages"][number] }[] = [];
    for (const m of messages) {
      const id = await claim({
        source: "copilot",
        messageRef: m.messageId,
        channel: "chat",
        direction: m.role === "user" ? "inbound" : "outbound",
        messageAt: new Date(m.at),
        ...(staff ? { status: "skipped" as const, reason: ASSISTANT_PING_SKIPS.staff } : {}),
      });
      if (id && !staff) claimed.push({ id, message: m });
    }
    if (claimed.length === 0) return;
    const identity: SiblingIdentity = { orgId: dest.orgId, userId: turn.userId, runId, brandId: dest.brandId };
    const [org, userName, threadUrl, assistantName] = await Promise.all([
      attempt("chatting org", () => readOrg(turn.orgId, identity)),
      turn.displayName?.trim() ? Promise.resolve(turn.displayName.trim()) : attempt("chatting user", () => readUserName(turn.userId, identity)),
      threadUrlFor(dest, `email:${email}`, null, identity),
      attempt("assistant name", () => copilotName(dest)),
    ]);
    const ordered = [...claimed].sort((a, b) => Date.parse(a.message.at) - Date.parse(b.message.at));
    for (const { id, message } of ordered) {
      await deliver(
        id,
        composeAssistantPingText({
          channel: "chat",
          direction: message.role === "user" ? "inbound" : "outbound",
          assistantName: assistantName ?? COPILOT_SENDER_NAME,
          name: userName,
          phone: null,
          email,
          orgName: org?.name ?? null,
          text: message.text,
          threadUrl,
        }),
      );
    }
  } catch (err) {
    console.error(`[crm-service] assistant pings for Copilot session ${turn.sessionId} failed:`, err);
  }
}

// ─── the assistant's linked accounts (called after the mirror, never awaited) ─

interface Candidate {
  event_id: string;
  room_id: string;
  sender: string;
  origin_server_ts: Date | string;
  payload: MatrixEvent;
  /** The event this one edits (`m.replace`), when mirrored on the connection. */
  replaced: MatrixEvent | null;
  /** Its transcript when it is a transcribed voice note (SOPHIE-VOICE-1019). */
  voice_status: string | null;
  voice_text: string | null;
}

interface ThreadRow {
  conversation_id: string;
  contact_id: string;
  channel_handle: string | null;
  phone_e164: string | null;
  full_name: string | null;
  primary_email: string | null;
}

/** The connection's watch start, set the first time it is looked at. */
async function watchSince(conn: MatrixConnection): Promise<Date> {
  const [set] = await db
    .update(matrixConnections)
    .set({ assistantPingSince: new Date() })
    .where(and(eq(matrixConnections.id, conn.id), sql`${matrixConnections.assistantPingSince} IS NULL`))
    .returning({ since: matrixConnections.assistantPingSince });
  if (set?.since) return set.since;
  const [row] = await db
    .select({ since: matrixConnections.assistantPingSince })
    .from(matrixConnections)
    .where(eq(matrixConnections.id, conn.id));
  return row.since!;
}

/**
 * After the mirror wrote a connection's new events: when the connection is one
 * of the assistant's accounts, one ping per new message of its one-to-one
 * threads. A message it cannot decide yet (the own team unreadable) is left
 * unrecorded and decided on the next pass. Never throws.
 */
export async function announceAssistantMatrixMessages(conn: MatrixConnection, now = Date.now()): Promise<number> {
  try {
    const dest = copilotDestination();
    if (!dest || conn.orgId !== dest.orgId || conn.brandId !== dest.brandId) return 0;
    const account = (await assistantAccounts(dest)).get(conn.id);
    if (!account) return 0;
    const since = await watchSince(conn);
    const floor = new Date(Math.max(since.getTime(), now - ASSISTANT_PING_LOOKBACK_MS));
    const candidates = (await db.execute(sql`
      SELECT e.event_id, e.room_id, e.sender, e.origin_server_ts, e.payload, r.payload AS replaced,
             t.status AS voice_status, t.text AS voice_text
      FROM matrix_raw_events e
      LEFT JOIN voice_note_transcripts t ON t.event_id = e.event_id
      LEFT JOIN matrix_raw_events r
        ON r.event_id = e.payload->'content'->'m.relates_to'->>'event_id'
        AND r.connection_id = e.connection_id
        AND e.payload->'content'->'m.relates_to'->>'rel_type' = 'm.replace'
      WHERE e.connection_id = ${conn.id}
        AND e.event_type = 'm.room.message'
        AND e.ingested_at >= ${since.toISOString()}
        AND e.origin_server_ts >= ${floor.toISOString()}
        AND NOT EXISTS (
          SELECT 1 FROM assistant_message_pings p WHERE p.source = 'matrix' AND p.message_ref = e.event_id
        )
      ORDER BY e.origin_server_ts, e.event_id
      LIMIT 200
    `)) as unknown as Candidate[];
    if (candidates.length === 0) return 0;

    const rooms = [...new Set(candidates.map((c) => c.room_id))];
    const threads = (await db.execute(sql`
      SELECT v.id AS conversation_id, v.room_id, c.id AS contact_id, c.channel_handle, c.phone_e164, c.full_name, c.primary_email
      FROM conversations v JOIN contacts c ON c.id = v.contact_id
      WHERE v.connection_id = ${conn.id} AND v.room_id IN (${sql.join(rooms.map((r) => sql`${r}`), sql`, `)})
    `)) as unknown as (ThreadRow & { room_id: string })[];
    const threadOf = new Map(threads.map((t) => [t.room_id, t]));
    const ours = (await db.execute(sql`
      SELECT event_id, text FROM whatsapp_sends
      WHERE org_id = ${conn.orgId} AND brand_id = ${conn.brandId}
        AND (connection_id = ${conn.id} OR status = 'sending')
        AND created_at >= ${new Date(floor.getTime() - 3_600_000).toISOString()}
    `)) as unknown as { event_id: string | null; text: string }[];
    const ourSends = ours.map((s) => ({ eventId: s.event_id, text: s.text }));

    const ids = { orgId: conn.orgId, userId: conn.createdByUserId, brandIds: [conn.brandId] };
    let runId: string | null = null;
    const identity = async (): Promise<SiblingIdentity> => {
      runId ??= (await createRun({ ...ids, serviceName: SERVICE_NAME, taskName: "assistant.pings" })).id;
      return { orgId: conn.orgId, userId: conn.createdByUserId, runId, brandId: conn.brandId };
    };
    let ownTeam: Awaited<ReturnType<typeof readOwnTeam>> | null = null;
    let pinged = 0;
    try {
      for (const c of candidates) {
        const at = new Date(c.origin_server_ts);
        const base = { source: "matrix" as const, messageRef: c.event_id, channel: conn.channel, connectionId: conn.id, messageAt: at };
        const thread = threadOf.get(c.room_id);
        // A voice note pings what was SAID (SOPHIE-VOICE-1019): left unrecorded until the reply watch
        // transcribed it (it re-runs this right after), pinged without words only past the wait.
        let payload = c.payload;
        if (isVoiceNote(payload.content) && c.sender !== conn.matrixUserId) {
          if (c.voice_status) payload = withVoiceTranscripts([payload], new Map([[c.event_id, { status: c.voice_status, text: c.voice_text }]]))[0];
          else if (now - at.getTime() < VOICE_NOTE_PING_WAIT_MS) continue;
        }
        const kind = classifyAssistantEvent(payload, conn.matrixUserId, ourSends, c.replaced);
        if (!thread || "skip" in kind) {
          const reason = !thread ? ASSISTANT_PING_SKIPS.notConversation : (kind as { skip: string }).skip;
          await claim({ ...base, direction: c.sender === conn.matrixUserId ? "outbound" : "inbound", status: "skipped", reason });
          continue;
        }

        const person = await personOfConversation(conn.orgId, conn.brandId, thread.conversation_id);
        const phone =
          thread.phone_e164 ?? (thread.channel_handle ? phoneFromMxid(thread.channel_handle, conn.counterpartPrefix) : null) ?? person?.phones[0] ?? null;
        const emails = [...(person?.emails ?? []), thread.primary_email].map((e) => normalizeEmail(e)).filter((e): e is string => !!e);
        ownTeam ??= await readOwnTeam(await identity());
        const staff = emails.some((e) => isStaffEmail(e)) || !!ownTeamMatch([phone, ...(person?.phones ?? [])], ownTeam);
        if (staff) {
          await claim({ ...base, direction: kind.direction, status: "skipped", reason: ASSISTANT_PING_SKIPS.staff });
          continue;
        }
        const pingId = await claim({ ...base, direction: kind.direction });
        if (!pingId) continue;
        const threadUrl = await threadUrlFor(dest, `matrix:${thread.contact_id}`, person?.personId ?? null, await identity());
        await deliver(
          pingId,
          composeAssistantPingText({
            channel: conn.channel,
            direction: kind.direction,
            assistantName: account.personaName ?? CHANNEL_LABEL[conn.channel] ?? conn.channel,
            name: person?.displayName ?? thread.full_name,
            phone,
            email: emails[0] ?? null,
            orgName: null,
            text: kind.text,
            threadUrl,
          }),
        );
        pinged += 1;
      }
      if (runId) await updateRun(runId, "completed", { ...ids, runId });
    } catch (err) {
      if (runId) await updateRun(runId, "failed", { ...ids, runId }).catch(() => undefined);
      throw err;
    }
    return pinged;
  } catch (err) {
    console.error(`[crm-service] assistant pings for connection ${conn.id} failed (retried next pass):`, err);
    return 0;
  }
}

/** The brand's merged person holding this mirrored conversation, or null when not built yet. */
async function personOfConversation(
  orgId: string,
  brandId: string,
  conversationId: string,
): Promise<{ personId: string | null; displayName: string | null; emails: string[]; phones: string[] } | null> {
  const [row] = await db
    .select({ personId: people.personId, displayName: people.displayName, emails: people.emails, phones: people.phones })
    .from(people)
    .where(
      and(
        eq(people.orgId, orgId),
        eq(people.brandId, brandId),
        sql`${people.presences} @> ${JSON.stringify([{ source: "matrix", detail: { conversationId } }])}::jsonb`,
      ),
    )
    .limit(1);
  return row ? { personId: row.personId, displayName: row.displayName, emails: row.emails as string[], phones: row.phones as string[] } : null;
}
