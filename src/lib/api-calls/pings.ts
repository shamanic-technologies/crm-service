/**
 * The owner's Telegram line for EVERY external API / MCP call (TG-EVERY-CALL-1124, owner 2026-11-24, choice « B »:
 * « one Telegram message for every API or MCP call made by anyone »; replaces the once-per-conversation ping).
 *
 * External only, by construction: api-service pushes ONLY calls made with a client's own key, the MCP server's calls
 * for a client's assistant, and the keyless agent-signup calls (an AI agent opening an account). Our service-to-service
 * traffic, Windmill runs and the dashboard's browser calls never reach `POST /internal/api-calls`.
 *
 * Flow (`apiCallPingPass`, in-process loop every 5 s + one kick after each push, never on the request path):
 *  1. CLASSIFY: every `api_calls` row received after the watch start (`api_call_ping_watch`, set by the migration:
 *     never history) and in the last 24 h with no `api_call_pings` row gets one: `skipped / staff` (a staff address,
 *     kevin@pressbeat.io, or a user id ever seen with one: the owner's own actions never alert; 99 % of the calls) or
 *     `pending`. The `api_calls` table is the outbox: a crash after the push answered loses nothing.
 *  2. SEND within the chat's budget (`API_CALL_PING_BUDGET_PER_MINUTE`, default 6: the owner chat also gets the
 *     fleet's other pings, Telegram allows about 20 a minute per chat), counted on what this service sent in the last
 *     60 s (stored, so a restart keeps it). Few pending calls = one message each; more than the budget left = ONE
 *     grouped message listing every one of them (or a per-person summary with counts when the list is too long).
 *     Nothing is dropped: every call ends `sent` with the message it went out in.
 *  3. A failed send goes back to `pending` with a backoff (Telegram's own `retry after` respected); 24 h after the call
 *     it is `failed`, logged. Unconfigured bot = `unconfigured`, logged.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCallPings, apiCalls, peopleScopes, type ApiCall } from "../../db/schema.js";
import { copilotDestination, type CopilotDestination } from "../copilot/messages.js";
import { emailKey } from "../people/identity.js";
import type { SiblingIdentity } from "../people/siblings.js";
import { brandNamesFor } from "../people/timeline.js";
import { isStaffEmail, sendOwnerTelegram, type OwnerTelegramResult } from "../owner-telegram.js";
import { isStaffActor, mintPersonId, readOrg, readUserName, uniboxThreadUrl } from "../conversation-pings.js";
import { createPlatformRun, updatePlatformRun } from "../runs-client.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { describeRequest, describeResponse, type ApiCallChannel } from "./calls.js";
import { composeCallText, composeGroupedText, planSend, telegramRetryAfterSeconds, type CallLine } from "./ping-text.js";

export const API_CALL_PING_INTERVAL_MS = 5_000;
const WINDOW_MS = 60_000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const STUCK_SENDING_MS = 2 * 60 * 1000;
const CLASSIFY_LIMIT = 2_000;
const SEND_LIMIT = 1_000;

export function budgetPerMinute(): number {
  const n = Number(process.env.API_CALL_PING_BUDGET_PER_MINUTE ?? "6");
  return Number.isInteger(n) && n >= 1 ? n : 6;
}

let pausedUntil = 0;

const q = async <T>(query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as T[];

// ─── 1. classify ────────────────────────────────────────────────────────────

async function classify(now: Date): Promise<{ pending: number; staff: number }> {
  const rows = await q<{ call_id: string; email: string; caller_user_id: string | null; called_at: Date | string }>(sql`
    SELECT a.call_id, a.email, a.caller_user_id, a.called_at
    FROM api_calls a, api_call_ping_watch w
    WHERE w.id = 1
      AND a.received_at >= w.since
      AND a.received_at >= ${new Date(now.getTime() - LOOKBACK_MS).toISOString()}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM api_call_pings p WHERE p.call_id = a.call_id)
    ORDER BY a.received_at, a.call_id
    LIMIT ${CLASSIFY_LIMIT}`);
  if (rows.length === 0) return { pending: 0, staff: 0 };
  const staffBy = new Map<string, boolean>();
  const values = [];
  for (const r of rows) {
    const k = `${r.caller_user_id ?? ""}|${r.email}`;
    if (!staffBy.has(k)) staffBy.set(k, r.caller_user_id ? await isStaffActor(r.email, r.caller_user_id) : isStaffEmail(r.email));
    const staff = staffBy.get(k)!;
    values.push({
      callId: r.call_id,
      email: r.email,
      calledAt: new Date(r.called_at),
      status: staff ? "skipped" : "pending",
      reason: staff ? "staff" : null,
      nextAt: now,
    });
  }
  await db.insert(apiCallPings).values(values).onConflictDoNothing({ target: apiCallPings.callId });
  const staff = values.filter((v) => v.status === "skipped").length;
  return { pending: values.length - staff, staff };
}

// ─── 2. send ────────────────────────────────────────────────────────────────

async function messagesSentInWindow(now: Date): Promise<number> {
  const [r] = await q<{ n: number }>(sql`
    SELECT count(DISTINCT message_group)::int AS n FROM api_call_pings
    WHERE sent_at > ${new Date(now.getTime() - WINDOW_MS).toISOString()}::timestamptz AND message_group IS NOT NULL`);
  return r.n;
}

/** Claims the pending rows (status `sending`), oldest first; a row stuck `sending` (crash mid-send) is pending again. */
async function claimPending(now: Date): Promise<{ id: string; callId: string; attempts: number }[]> {
  await db
    .update(apiCallPings)
    .set({ status: "pending", updatedAt: now })
    .where(and(eq(apiCallPings.status, "sending"), lt(apiCallPings.updatedAt, new Date(now.getTime() - STUCK_SENDING_MS))));
  return q<{ id: string; callId: string; attempts: number }>(sql`
    UPDATE api_call_pings SET status = 'sending', updated_at = ${now.toISOString()}::timestamptz
    WHERE id IN (
      SELECT id FROM api_call_pings
      WHERE status = 'pending' AND next_at <= ${now.toISOString()}::timestamptz
      ORDER BY called_at, call_id
      LIMIT ${SEND_LIMIT}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, call_id AS "callId", attempts`);
}

async function countPending(now: Date): Promise<number> {
  const [r] = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM api_call_pings WHERE status = 'pending' AND next_at <= ${now.toISOString()}::timestamptz`);
  return r.n;
}

/** Each lookup on its own: one that fails drops its part of the line, logged, never the line. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[crm-service][api-call-pings] ${what} unreadable:`, (err as Error).message);
    return null;
  }
}

interface PassContext {
  dest: CopilotDestination;
  /** Who reads are filed under when the call has no user (the staff scope's creator). */
  fallbackUserId: string | null;
  runId: () => Promise<string>;
}

function identityFor(ctx: PassContext, call: ApiCall, runId: string): SiblingIdentity | null {
  const userId = call.callerUserId ?? ctx.fallbackUserId;
  return userId ? { orgId: ctx.dest.orgId, userId, runId, brandId: ctx.dest.brandId } : null;
}

async function lineFor(ctx: PassContext, call: ApiCall): Promise<CallLine> {
  const runId = await ctx.runId();
  const identity = identityFor(ctx, call, runId);
  const brandIds = (call.brandIds as string[]) ?? [];
  const [org, userName, brandNames] = await Promise.all([
    call.callerOrgId && identity ? attempt("calling org", () => readOrg(call.callerOrgId!, identity)) : Promise.resolve(null),
    call.displayName?.trim()
      ? Promise.resolve(call.displayName.trim())
      : call.callerUserId && identity
        ? attempt("calling user", () => readUserName(call.callerUserId!, identity))
        : Promise.resolve(null),
    brandIds.length > 0 && identity
      ? attempt("brand names", () => brandNamesFor(brandIds, identity))
      : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    callId: call.callId,
    channel: call.channel as ApiCallChannel,
    email: call.email,
    name: userName,
    orgName: org?.name ?? null,
    noAccount: call.callerUserId == null,
    mcpTool: call.channel === "mcp" ? call.mcpTool : null,
    did: describeRequest(call, brandNames ?? new Map()),
    status: call.status,
    result: describeResponse(call),
    at: call.calledAt,
  };
}

async function threadUrl(ctx: PassContext, email: string, call: ApiCall): Promise<string | null> {
  const identity = identityFor(ctx, call, await ctx.runId());
  if (!identity) return null;
  const staffOrg = await attempt("staff org Clerk id", () => readOrg(ctx.dest.orgId, identity));
  if (!staffOrg?.externalId) return null;
  const personId = await attempt("person id", () => mintPersonId(ctx.dest, emailKey(email)));
  return personId ? uniboxThreadUrl(staffOrg.externalId, ctx.dest.brandId, personId) : null;
}

/** Records the outcome of ONE Telegram message on every call it carried. */
async function settle(
  ids: { id: string; attempts: number; calledAt: Date }[],
  result: OwnerTelegramResult,
  mode: "line" | "grouped" | "summary",
  now: Date,
): Promise<void> {
  const all = ids.map((r) => r.id);
  if (result.status === "sent") {
    await db
      .update(apiCallPings)
      .set({ status: "sent", mode, messageGroup: randomUUID(), telegramMessageId: result.messageId, sentAt: now, error: null, updatedAt: now })
      .where(inArray(apiCallPings.id, all));
    return;
  }
  if (result.status === "unconfigured") {
    await db.update(apiCallPings).set({ status: "unconfigured", error: result.error, updatedAt: now }).where(inArray(apiCallPings.id, all));
    return;
  }
  const retryAfter = telegramRetryAfterSeconds(result.error);
  if (retryAfter) pausedUntil = Math.max(pausedUntil, Date.now() + retryAfter * 1000);
  for (const r of ids) {
    const attempts = r.attempts + 1;
    const expired = now.getTime() - r.calledAt.getTime() > LOOKBACK_MS;
    const backoff = Math.max((retryAfter ?? 0) * 1000, Math.min(10_000 * 2 ** (attempts - 1), 10 * 60_000));
    await db
      .update(apiCallPings)
      .set({ status: expired ? "failed" : "pending", attempts, nextAt: new Date(now.getTime() + backoff), error: result.error, updatedAt: now })
      .where(eq(apiCallPings.id, r.id));
    if (expired) console.error(`[crm-service][api-call-pings] call ${r.id} NEVER told to the owner after 24 h of retries: ${result.error}`);
  }
}

export interface ApiCallPingPassResult {
  classified: { pending: number; staff: number };
  messages: number;
  callsSent: number;
  waiting: number;
}

/** One pass: classify new calls, then send what the budget allows. Throws on a database failure (the loop logs it). */
export async function apiCallPingPass(opts: { now?: Date; budget?: number } = {}): Promise<ApiCallPingPassResult> {
  const now = opts.now ?? new Date();
  const budget = opts.budget ?? budgetPerMinute();
  const dest = copilotDestination();
  const out: ApiCallPingPassResult = { classified: { pending: 0, staff: 0 }, messages: 0, callsSent: 0, waiting: 0 };
  if (!dest) return out;
  out.classified = await classify(now);

  const pending = await countPending(now);
  const available = Date.now() < pausedUntil ? 0 : budget - (await messagesSentInWindow(now));
  const plan = planSend(pending, available);
  out.waiting = pending;
  if (plan === "none") return out;

  const claimed = await claimPending(now);
  if (claimed.length === 0) return out;
  const calls = await db.select().from(apiCalls).where(inArray(apiCalls.callId, claimed.map((c) => c.callId)));
  const callById = new Map(calls.map((c) => [c.callId, c]));

  const [scope] = await db
    .select({ userId: peopleScopes.createdByUserId })
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, dest.orgId), eq(peopleScopes.brandId, dest.brandId)));
  let run: Promise<string> | null = null;
  const ctx: PassContext = {
    dest,
    fallbackUserId: scope?.userId ?? null,
    runId: () => (run ??= createPlatformRun({ serviceName: SERVICE_NAME, taskName: "api-call-pings.send" }).then((r) => r.id)),
  };

  const rows = claimed.flatMap((c) => {
    const call = callById.get(c.callId);
    return call ? [{ ...c, call, calledAt: call.calledAt }] : [];
  });
  try {
    if (plan === "lines") {
      for (const r of rows) {
        const line = await lineFor(ctx, r.call);
        const text = composeCallText(line, await threadUrl(ctx, r.call.email, r.call));
        const result = await sendOwnerTelegram(text);
        await settle([r], result, "line", now);
        out.messages += 1;
        if (result.status === "sent") out.callsSent += 1;
        else break;
      }
    } else {
      const lines: CallLine[] = [];
      for (const r of rows) lines.push(await lineFor(ctx, r.call));
      const urls = new Map<string, string | null>();
      for (const r of rows) if (!urls.has(r.call.email)) urls.set(r.call.email, await threadUrl(ctx, r.call.email, r.call));
      const { text, mode } = composeGroupedText(lines, urls, budget);
      const result = await sendOwnerTelegram(text);
      await settle(rows, result, mode, now);
      out.messages += 1;
      if (result.status === "sent") out.callsSent += rows.length;
    }
  } finally {
    // Whatever this pass claimed and did not settle (a line loop stopped on a failure) goes back to pending.
    await db
      .update(apiCallPings)
      .set({ status: "pending", updatedAt: now })
      .where(and(inArray(apiCallPings.id, rows.map((r) => r.id).concat(claimed.map((c) => c.id))), eq(apiCallPings.status, "sending")));
    if (run) {
      const id = await (run as Promise<string>).catch(() => null);
      if (id) await updatePlatformRun(id, "completed", SERVICE_NAME).catch((e) => console.error(`[crm-service][api-call-pings] run ${id} not closed:`, e));
    }
  }
  out.waiting = Math.max(0, pending - out.callsSent);
  return out;
}

// ─── the loop ───────────────────────────────────────────────────────────────

let running: Promise<unknown> | null = null;
let again = false;

/** Runs a pass now (one at a time; a kick during a pass runs one more right after). Never throws. */
export function kickApiCallPings(): void {
  if (process.env.API_CALL_PINGS === "off") return;
  if (running) {
    again = true;
    return;
  }
  running = apiCallPingPass()
    .then((r) => {
      if (r.messages > 0 || r.classified.pending > 0) console.log(`[crm-service][api-call-pings] pass: ${JSON.stringify(r)}`);
    })
    .catch((e) => console.error("[crm-service][api-call-pings] pass failed:", e))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kickApiCallPings();
      }
    });
}

export function startApiCallPings(): void {
  if (process.env.API_CALL_PINGS === "off") return;
  setTimeout(() => {
    kickApiCallPings();
    setInterval(kickApiCallPings, API_CALL_PING_INTERVAL_MS).unref();
  }, 15_000).unref();
}
