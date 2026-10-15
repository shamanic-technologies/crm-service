/**
 * The owner's Telegram ping when someone STARTS a conversation with us through
 * the AI Copilot or our API / MCP server (owner 2026-10-12: "envoie-moi aussi
 * des notifs Telegram à chaque conversation d'un user avec notre AI chat et
 * notre API / MCP"). One ping per conversation start, never one per message.
 *
 * What one conversation is:
 *  - Copilot: one chat-service session. It starts at its first user message,
 *    and again when the user writes after 30 minutes of silence in it.
 *  - API / MCP: a burst of calls by one person on one channel, gaps under 30
 *    minutes (the same session the Unibox thread shows, `sessionsOf`).
 *
 * Rules (fleet-wide):
 *  - never the owner's own actions: a staff address, or any user id ever seen
 *    with a staff address, pings nothing;
 *  - never fails or slows what it reports: the push routes answer first and run
 *    this in the background; every failure is logged loudly, never thrown;
 *  - never twice: the start is recorded (`conversation_pings`) under an
 *    advisory lock per conversation BEFORE the send, so a retried push, two
 *    batches at once or a restart cannot ping again. A send that fails is
 *    marked `failed`, not retried (at most once).
 */

import { randomUUID } from "node:crypto";
import { and, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiCalls, conversationPings, copilotMessages, personIds, type ApiCall } from "../db/schema.js";
import { copilotDestination, type CopilotDestination } from "./copilot/messages.js";
import { describeRequest, describeResponse, type ApiCallChannel } from "./api-calls/calls.js";
import { emailKey, normalizeEmail } from "./people/identity.js";
import { siblingGet, type SiblingIdentity } from "./people/siblings.js";
import { brandNamesFor } from "./people/timeline.js";
import { isStaffEmail, sendOwnerTelegram } from "./owner-telegram.js";

/** Silence longer than this ends a conversation (same gap as the API sessions). */
export const CONVERSATION_GAP_MS = 30 * 60 * 1000;
/** Where the Unibox lives. */
export const DASHBOARD_ORIGIN = "https://dashboard.distribute.you";
const FIRST_TEXT_MAX = 280;

export type PingChannel = "chat" | ApiCallChannel;

const CHANNEL_LABEL: Record<PingChannel, string> = { chat: "AI chat", api: "API", mcp: "MCP" };

export interface StartCandidate {
  source: "copilot" | "api";
  channel: PingChannel;
  conversationKey: string;
  /** The message id / call id. */
  startRef: string;
  email: string;
  at: Date;
}

// ─── pure ───────────────────────────────────────────────────────────────────

export const copilotConversationKey = (sessionId: string) => `copilot:${sessionId}`;
export const apiConversationKey = (channel: ApiCallChannel, email: string) => `api:${channel}:${email}`;

/** PURE: true when any of these addresses is staff (a person ever him pings nothing). */
export function anyStaff(emails: (string | null | undefined)[]): boolean {
  return emails.some((e) => isStaffEmail(e));
}

const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

export interface PingContent {
  channel: PingChannel;
  email: string;
  name: string | null;
  orgName: string | null;
  brandNames: string[];
  /** The first message (chat) or the plain-words first call (API / MCP). */
  first: string;
  threadUrl: string | null;
}

/**
 * PURE: the message. Plain text, one fact per line:
 *
 *   New conversation on AI chat
 *   Who: Jane Doe (jane@acme.com)
 *   Org: Acme
 *   First message: "Can you find me 50 dentists in Lyon?"
 *   Thread: https://dashboard.distribute.you/v2/orgs/…/unibox?person=…
 */
export function composePingText(c: PingContent): string {
  const lines = [`New conversation on ${CHANNEL_LABEL[c.channel]}`];
  lines.push(`Who: ${c.name ? `${c.name} (${c.email})` : c.email}`);
  if (c.orgName) lines.push(`Org: ${c.orgName}`);
  if (c.brandNames.length > 0) lines.push(`Brand${c.brandNames.length > 1 ? "s" : ""}: ${c.brandNames.join(", ")}`);
  lines.push(c.channel === "chat" ? `First message: "${clip(c.first, FIRST_TEXT_MAX)}"` : `First call: ${clip(c.first, FIRST_TEXT_MAX)}`);
  if (c.threadUrl) lines.push(`Thread: ${c.threadUrl}`);
  return lines.join("\n");
}

/** PURE: the person's thread in the staff Unibox. */
export function uniboxThreadUrl(clerkOrgId: string, brandId: string, personId: string): string {
  return `${DASHBOARD_ORIGIN}/v2/orgs/${encodeURIComponent(clerkOrgId)}/brands/${encodeURIComponent(brandId)}/unibox?person=${encodeURIComponent(personId)}`;
}

// ─── claiming the start (dedupe) ────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** True when the conversation already had activity in the 30 minutes before `c`. */
async function hadEarlierActivity(tx: Tx, c: StartCandidate): Promise<boolean> {
  const from = new Date(c.at.getTime() - CONVERSATION_GAP_MS);
  if (c.source === "copilot") {
    const sessionId = c.conversationKey.slice("copilot:".length);
    const [row] = await tx
      .select({ id: copilotMessages.id })
      .from(copilotMessages)
      .where(
        and(
          eq(copilotMessages.sessionId, sessionId),
          gte(copilotMessages.sentAt, from),
          lt(copilotMessages.sentAt, c.at),
          ne(copilotMessages.messageId, c.startRef),
        ),
      )
      .limit(1);
    return !!row;
  }
  const [row] = await tx
    .select({ id: apiCalls.id })
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.email, c.email),
        eq(apiCalls.channel, c.channel),
        gte(apiCalls.calledAt, from),
        lt(apiCalls.calledAt, c.at),
        ne(apiCalls.callId, c.startRef),
      ),
    )
    .limit(1);
  return !!row;
}

/** True when a start of this conversation was already announced within 30 minutes either side. */
async function pingedNearby(tx: Tx, c: StartCandidate): Promise<boolean> {
  const [row] = await tx
    .select({ id: conversationPings.id })
    .from(conversationPings)
    .where(
      and(
        eq(conversationPings.conversationKey, c.conversationKey),
        gt(conversationPings.startedAt, new Date(c.at.getTime() - CONVERSATION_GAP_MS)),
        lt(conversationPings.startedAt, new Date(c.at.getTime() + CONVERSATION_GAP_MS)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Records which candidates START a conversation, one advisory lock per
 * conversation so two pushes deciding at once see each other. Candidates must
 * already be stored. Returns the claimed starts (the ones to announce).
 */
export async function claimStarts(candidates: StartCandidate[]): Promise<{ id: string; candidate: StartCandidate }[]> {
  const byKey = new Map<string, StartCandidate[]>();
  for (const c of candidates) byKey.set(c.conversationKey, [...(byKey.get(c.conversationKey) ?? []), c]);
  const claimed: { id: string; candidate: StartCandidate }[] = [];
  for (const [key, group] of byKey) {
    const sorted = [...group].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.startRef < b.startRef ? -1 : 1));
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`conversation-ping:${key}`}))`);
      for (const c of sorted) {
        if (await pingedNearby(tx, c)) continue;
        if (await hadEarlierActivity(tx, c)) continue;
        const [row] = await tx
          .insert(conversationPings)
          .values({
            source: c.source,
            channel: c.channel,
            conversationKey: c.conversationKey,
            startRef: c.startRef,
            email: c.email,
            startedAt: c.at,
          })
          .onConflictDoNothing({ target: [conversationPings.source, conversationPings.startRef] })
          .returning({ id: conversationPings.id });
        if (row) claimed.push({ id: row.id, candidate: c });
      }
    });
  }
  return claimed;
}

// ─── staff ──────────────────────────────────────────────────────────────────

/**
 * True when this user id was EVER seen with a staff address, on the Copilot or
 * the API (a session of a person ever him), or the address itself is staff.
 */
export async function isStaffActor(email: string, userId: string): Promise<boolean> {
  if (isStaffEmail(email)) return true;
  const [chat, api] = await Promise.all([
    db.selectDistinct({ email: copilotMessages.email }).from(copilotMessages).where(eq(copilotMessages.chatUserId, userId)),
    db.selectDistinct({ email: apiCalls.email }).from(apiCalls).where(eq(apiCalls.callerUserId, userId)),
  ]);
  return anyStaff([...chat, ...api].map((r) => r.email));
}

// ─── who they are (client-service), the thread link ─────────────────────────

const LOOKUP_TTL_MS = 60 * 60 * 1000;
const orgCache = new Map<string, { at: number; org: { externalId: string | null; name: string | null } | null }>();

export async function readOrg(orgId: string, identity: SiblingIdentity): Promise<{ externalId: string | null; name: string | null } | null> {
  const hit = orgCache.get(orgId);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.org;
  const r = await siblingGet("client", `/internal/orgs/${encodeURIComponent(orgId)}`, identity);
  if (r.status === 404) {
    orgCache.set(orgId, { at: Date.now(), org: null });
    return null;
  }
  if (r.status !== 200) throw new Error(`client-service GET /internal/orgs/${orgId} returned ${r.status}`);
  const body = r.body as { externalId?: string | null; name?: string | null };
  const org = { externalId: body.externalId ?? null, name: body.name?.trim() || null };
  orgCache.set(orgId, { at: Date.now(), org });
  return org;
}

async function readUserName(userId: string, identity: SiblingIdentity): Promise<string | null> {
  const r = await siblingGet("client", `/internal/users/${encodeURIComponent(userId)}`, identity);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`client-service GET /internal/users/${userId} returned ${r.status}`);
  const u = (r.body as { user?: { firstName?: string | null; lastName?: string | null } }).user;
  const name = [u?.firstName, u?.lastName].map((x) => x?.trim()).filter(Boolean).join(" ");
  return name || null;
}

/**
 * The person's opaque id in the staff Unibox, so the link opens their thread.
 * A brand-new chatter has none until the next people build (cron): the id is
 * minted here exactly as the build would mint it (`person_ids` is the build's
 * own memory, keyed on the identity key), so the build adopts it and the link
 * keeps working; a later merge keeps it working through `person_id_aliases`.
 */
async function personIdFor(dest: CopilotDestination, email: string): Promise<string> {
  const key = emailKey(email);
  await db
    .insert(personIds)
    .values({ orgId: dest.orgId, brandId: dest.brandId, identityKey: key, personId: randomUUID() })
    .onConflictDoNothing({ target: [personIds.orgId, personIds.brandId, personIds.identityKey] });
  const [row] = await db
    .select({ personId: personIds.personId })
    .from(personIds)
    .where(and(eq(personIds.orgId, dest.orgId), eq(personIds.brandId, dest.brandId), eq(personIds.identityKey, key)))
    .limit(1);
  return row.personId;
}

/** Each lookup on its own: one that fails drops its line from the message, logged, never the ping. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[crm-service] conversation ping: ${what} unreadable:`, (err as Error).message);
    return null;
  }
}

async function threadUrlFor(dest: CopilotDestination, email: string, identity: SiblingIdentity): Promise<string | null> {
  const staffOrg = await attempt("staff org Clerk id", () => readOrg(dest.orgId, identity));
  if (!staffOrg?.externalId) {
    console.error(`[crm-service] conversation ping: no Clerk id for the staff org ${dest.orgId}: sent without a thread link`);
    return null;
  }
  const personId = await attempt("person id", () => personIdFor(dest, email));
  return personId ? uniboxThreadUrl(staffOrg.externalId, dest.brandId, personId) : null;
}

async function deliver(pingId: string, text: string): Promise<void> {
  const result = await sendOwnerTelegram(text);
  await db
    .update(conversationPings)
    .set({
      status: result.status,
      telegramMessageId: result.status === "sent" ? result.messageId : null,
      error: result.status === "sent" ? null : result.error,
      text,
      updatedAt: new Date(),
    })
    .where(eq(conversationPings.id, pingId));
  if (result.status === "sent") console.log(`[crm-service] conversation ping ${pingId} sent (telegram message ${result.messageId})`);
}

// ─── entry points (called by the push routes, never awaited) ────────────────

export interface CopilotPushed {
  orgId: string;
  userId: string;
  email: string;
  displayName?: string | null;
  sessionId: string;
  messages: { messageId: string; role: "user" | "assistant"; text: string; at: string }[];
}

/** After a Copilot turn is stored: ping when it starts a conversation. Never throws. */
export async function announceCopilotStarts(turn: CopilotPushed, newMessageIds: string[], runId: string): Promise<void> {
  try {
    const dest = copilotDestination();
    const email = normalizeEmail(turn.email);
    if (!dest || !email) return;
    const fresh = new Set(newMessageIds);
    const candidates: StartCandidate[] = turn.messages
      .filter((m) => m.role === "user" && fresh.has(m.messageId) && m.text.trim())
      .map((m) => ({
        source: "copilot",
        channel: "chat",
        conversationKey: copilotConversationKey(turn.sessionId),
        startRef: m.messageId,
        email,
        at: new Date(m.at),
      }));
    if (candidates.length === 0) return;
    if (await isStaffActor(email, turn.userId)) return;
    const claimed = await claimStarts(candidates);
    if (claimed.length === 0) return;
    const identity: SiblingIdentity = { orgId: dest.orgId, userId: turn.userId, runId, brandId: dest.brandId };
    const [org, userName, threadUrl] = await Promise.all([
      attempt("chatting org", () => readOrg(turn.orgId, identity)),
      turn.displayName?.trim() ? Promise.resolve(turn.displayName.trim()) : attempt("chatting user", () => readUserName(turn.userId, identity)),
      threadUrlFor(dest, email, identity),
    ]);
    const textOf = new Map(turn.messages.map((m) => [m.messageId, m.text]));
    for (const { id, candidate } of claimed) {
      const text = composePingText({
        channel: "chat",
        email,
        name: userName,
        orgName: org?.name ?? null,
        brandNames: [],
        first: textOf.get(candidate.startRef) ?? "",
        threadUrl,
      });
      await deliver(id, text);
    }
  } catch (err) {
    console.error(`[crm-service] conversation ping for Copilot session ${turn.sessionId} failed:`, err);
  }
}

/** After a batch of API / MCP calls is stored: ping each conversation it starts. Never throws. */
export async function announceApiCallStarts(newCallIds: string[], runId: string): Promise<void> {
  if (newCallIds.length === 0) return;
  try {
    const dest = copilotDestination();
    if (!dest) return;
    const rows = await db.select().from(apiCalls).where(inArray(apiCalls.callId, newCallIds));
    // Staff first, per caller: none of theirs ever counts.
    const staffByUser = new Map<string, boolean>();
    const kept: ApiCall[] = [];
    for (const r of rows) {
      const k = `${r.callerUserId}|${r.email}`;
      if (!staffByUser.has(k)) staffByUser.set(k, await isStaffActor(r.email, r.callerUserId));
      if (!staffByUser.get(k)) kept.push(r);
    }
    const byRef = new Map(kept.map((r) => [r.callId, r]));
    const claimed = await claimStarts(
      kept.map((r) => ({
        source: "api" as const,
        channel: r.channel as ApiCallChannel,
        conversationKey: apiConversationKey(r.channel as ApiCallChannel, r.email),
        startRef: r.callId,
        email: r.email,
        at: r.calledAt,
      })),
    );
    for (const { id, candidate } of claimed) {
      const call = byRef.get(candidate.startRef)!;
      try {
        const identity: SiblingIdentity = { orgId: dest.orgId, userId: call.callerUserId, runId, brandId: dest.brandId };
        const brandIds = (call.brandIds as string[]) ?? [];
        const [org, userName, brandNames, threadUrl] = await Promise.all([
          call.callerOrgId ? attempt("calling org", () => readOrg(call.callerOrgId!, identity)) : Promise.resolve(null),
          call.displayName?.trim() ? Promise.resolve(call.displayName.trim()) : attempt("calling user", () => readUserName(call.callerUserId, identity)),
          brandIds.length > 0 ? brandNamesFor(brandIds, identity) : Promise.resolve(new Map<string, string>()),
          threadUrlFor(dest, call.email, identity),
        ]);
        const tool = call.channel === "mcp" && call.mcpTool ? `tool ${call.mcpTool}: ` : "";
        const text = composePingText({
          channel: call.channel as ApiCallChannel,
          email: call.email,
          name: userName,
          orgName: org?.name ?? null,
          brandNames: brandIds.map((b) => brandNames.get(b) ?? b.slice(0, 8)),
          first: `${tool}${describeRequest(call, brandNames)}. ${describeResponse(call)}`,
          threadUrl,
        });
        await deliver(id, text);
      } catch (err) {
        console.error(`[crm-service] conversation ping ${id} (API call ${candidate.startRef}) failed:`, err);
      }
    }
  } catch (err) {
    console.error(`[crm-service] conversation pings for ${newCallIds.length} API calls failed:`, err);
  }
}
