/**
 * TG-DAILY-DIGEST-1127: ONE owner Telegram a day covering every external API / MCP call of the previous UTC day
 * (owner 2026-11-27: « Je suis trop de ce type de message », then « un message par day all users »).
 *
 *   API / MCP yesterday: 3 people, 11 calls
 *   v.erhard@b2bsignals.ai · b2bsignals.ai: 2 calls, connected only
 *   Thread: https://dashboard.distribute.you/...
 *
 * - Sent at DIGEST_HOUR_UTC (08:00) for day D-1, by an in-process loop (every 60 s, first tick 60 s after boot, one
 *   pass at a time; `API_CALL_DIGEST=off` stops it).
 * - Every non-staff call of the day is counted (`api_call_pings` rows not `skipped`), the ones pinged live too, so the
 *   digest is the day's whole picture. The calls that waited for it (`digest`) end `sent`, mode `digest`.
 * - Idempotent per day: `api_call_digests` row claimed `sending` BEFORE the send (atomic upsert), `sent` / `empty`
 *   after. A restart never sends a day twice nor skips one (a missed day is caught up for DIGEST_CATCH_UP_DAYS).
 * - A day with no external call = `empty`, no message. A failed send = `failed`, retried with a backoff.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCallDigests, apiCallPings, apiCalls, peopleScopes, type ApiCall } from "../../db/schema.js";
import { copilotDestination } from "../copilot/messages.js";
import { readOrg } from "../conversation-pings.js";
import { sendOwnerTelegram } from "../owner-telegram.js";
import { createPlatformRun, updatePlatformRun } from "../runs-client.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { describeRequest } from "./calls.js";
import { attempt, identityFor, threadUrl, type PassContext } from "./pings.js";
import { composeDigestText, digestDayLabel, digestDaysDue, type DigestCall } from "./ping-text.js";

export const API_CALL_DIGEST_INTERVAL_MS = 60_000;
const STUCK_SENDING_MS = 5 * 60 * 1000;

const q = async <T>(query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as T[];

export interface DigestDayResult {
  day: string;
  status: "sent" | "empty" | "failed" | "unconfigured";
  calls: number;
  people: number;
}

/** Days told, found empty, or held by a fresh claim / a failed send still in its backoff: not due this pass. */
async function daysNotDue(now: Date): Promise<Set<string>> {
  const rows = await q<{ day: string }>(sql`
    SELECT day::text AS day FROM api_call_digests
    WHERE status IN ('sent', 'empty', 'unconfigured')
       OR (status = 'failed' AND next_at > ${now.toISOString()}::timestamptz)
       OR (status = 'sending' AND updated_at >= ${new Date(now.getTime() - STUCK_SENDING_MS).toISOString()}::timestamptz)`);
  return new Set(rows.map((r) => r.day));
}

/** Atomic claim of one day: true when THIS pass owns its send. */
async function claimDay(day: string, now: Date): Promise<{ attempts: number } | null> {
  const iso = now.toISOString();
  const [row] = await q<{ attempts: number }>(sql`
    INSERT INTO api_call_digests (day, status, updated_at, next_at) VALUES (${day}::date, 'sending', ${iso}::timestamptz, ${iso}::timestamptz)
    ON CONFLICT (day) DO UPDATE SET status = 'sending', updated_at = ${iso}::timestamptz
    WHERE (api_call_digests.status = 'failed' AND api_call_digests.next_at <= ${iso}::timestamptz)
       OR (api_call_digests.status = 'sending' AND api_call_digests.updated_at < ${new Date(now.getTime() - STUCK_SENDING_MS).toISOString()}::timestamptz)
    RETURNING attempts`);
  return row ?? null;
}

async function callsOfDay(day: string): Promise<{ call: ApiCall; pingStatus: string }[]> {
  const rows = await db
    .select({ call: apiCalls, pingStatus: apiCallPings.status })
    .from(apiCallPings)
    .innerJoin(apiCalls, eq(apiCalls.callId, apiCallPings.callId))
    .where(
      and(
        sql`${apiCallPings.status} <> 'skipped'`,
        sql`${apiCallPings.calledAt} >= ${day}::date`,
        sql`${apiCallPings.calledAt} < (${day}::date + 1)`,
      ),
    );
  return rows;
}

async function tellDay(ctx: PassContext, day: string, attempts: number, now: Date): Promise<DigestDayResult> {
  const rows = await callsOfDay(day);
  const emails = new Set(rows.map((r) => r.call.email));
  const finish = async (set: Partial<typeof apiCallDigests.$inferInsert>) =>
    db.update(apiCallDigests).set({ ...set, calls: rows.length, people: emails.size, updatedAt: now }).where(eq(apiCallDigests.day, day));

  if (rows.length === 0) {
    await finish({ status: "empty", error: null });
    return { day, status: "empty", calls: 0, people: 0 };
  }

  const lines: DigestCall[] = [];
  const urls = new Map<string, string | null>();
  for (const { call } of rows) {
    const runId = await ctx.runId();
    const identity = identityFor(ctx, call, runId);
    const org = call.callerOrgId && identity ? await attempt("calling org", () => readOrg(call.callerOrgId!, identity)) : null;
    lines.push({
      email: call.email,
      orgName: org?.name ?? null,
      noAccount: call.callerUserId == null,
      did: describeRequest({ ...call, brandIds: [] }),
      status: call.status,
    });
    if (!urls.has(call.email)) urls.set(call.email, await threadUrl(ctx, call.email, call));
  }
  const text = composeDigestText(lines, urls, digestDayLabel(day, now))!;
  const result = await sendOwnerTelegram(text);

  if (result.status === "sent") {
    await finish({ status: "sent", telegramMessageId: result.messageId, sentAt: now, error: null });
    const waited = rows.filter((r) => r.pingStatus === "digest").map((r) => r.call.callId);
    if (waited.length > 0) {
      await db
        .update(apiCallPings)
        .set({ status: "sent", mode: "digest", messageGroup: randomUUID(), telegramMessageId: result.messageId, sentAt: now, updatedAt: now })
        .where(and(inArray(apiCallPings.callId, waited), eq(apiCallPings.status, "digest")));
    }
    return { day, status: "sent", calls: rows.length, people: emails.size };
  }
  if (result.status === "unconfigured") {
    await finish({ status: "unconfigured", error: result.error });
    return { day, status: "unconfigured", calls: rows.length, people: emails.size };
  }
  const next = attempts + 1;
  await finish({ status: "failed", attempts: next, nextAt: new Date(now.getTime() + Math.min(60_000 * 2 ** next, 60 * 60_000)), error: result.error });
  console.error(`[crm-service][api-call-digest] digest of ${day} NOT sent (attempt ${next}): ${result.error}`);
  return { day, status: "failed", calls: rows.length, people: emails.size };
}

/** One pass: tell every due day. Throws on a database failure (the loop logs it). */
export async function apiCallDigestPass(opts: { now?: Date } = {}): Promise<DigestDayResult[]> {
  const now = opts.now ?? new Date();
  const dest = copilotDestination();
  if (!dest) return [];
  const [watch] = await q<{ since: string | null }>(sql`SELECT digest_since::text AS since FROM api_call_ping_watch WHERE id = 1`);
  const due = digestDaysDue(now, watch?.since ?? null, await daysNotDue(now));
  if (due.length === 0) return [];

  const [scope] = await db
    .select({ userId: peopleScopes.createdByUserId })
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, dest.orgId), eq(peopleScopes.brandId, dest.brandId)));
  let run: Promise<string> | null = null;
  const ctx: PassContext = {
    dest,
    fallbackUserId: scope?.userId ?? null,
    runId: () => (run ??= createPlatformRun({ serviceName: SERVICE_NAME, taskName: "api-call-digest.send" }).then((r) => r.id)),
  };

  const out: DigestDayResult[] = [];
  try {
    for (const day of due) {
      const claim = await claimDay(day, now);
      if (!claim) continue;
      out.push(await tellDay(ctx, day, claim.attempts, now));
    }
  } finally {
    if (run) {
      const id = await (run as Promise<string>).catch(() => null);
      if (id) await updatePlatformRun(id, "completed", SERVICE_NAME).catch((e) => console.error(`[crm-service][api-call-digest] run ${id} not closed:`, e));
    }
  }
  return out;
}

let running = false;

function tick(): void {
  if (running) return;
  running = true;
  apiCallDigestPass()
    .then((r) => {
      if (r.length > 0) console.log(`[crm-service][api-call-digest] pass: ${JSON.stringify(r)}`);
    })
    .catch((e) => console.error("[crm-service][api-call-digest] pass failed:", e))
    .finally(() => {
      running = false;
    });
}

export function startApiCallDigest(): void {
  if (process.env.API_CALL_DIGEST === "off") return;
  setTimeout(() => {
    tick();
    setInterval(tick, API_CALL_DIGEST_INTERVAL_MS).unref();
  }, 60_000).unref();
}
