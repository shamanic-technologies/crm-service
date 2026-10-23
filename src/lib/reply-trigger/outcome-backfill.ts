/**
 * COST-BACKFILL-1023-CRM (owner 2026-10-23: « chaque service peut rétro-engineerer pour estimer tous les coûts du passé
 * pour être à 100 % now »): the positive replies our reply watch judged BEFORE the forward declaration shipped
 * (COST-ACCOUNTING-1023-P1, ./outcome.ts) are declared on the runs that judged them, as if declared on time.
 *
 * - Candidates = our own rows: a burst Jev JUDGED over the reply kinds (`judgment.positive` present, status ok) and
 *   let through (not `skipped`: P(positive) >= 0.5, the verdict the forward path declares on), no outcome state yet.
 * - The judging run is read from runs-service, never guessed: before the judge child run existed, a detection pass
 *   opened its run LAZILY on the burst's own Jev call (`matrix.live` / `matrix.sync` for WhatsApp, LinkedIn;
 *   `reply-trigger.detect-gmail` for Gmail), so that run starts within seconds after the row's `detected_at`.
 *   Exactly ONE such run of the row's org that spent (subtree cost > 0) in [detected_at - 2 s, detected_at + 15 s] =
 *   the judge; none or several = `unmatched` (recorded, never declared).
 * - `wroteBefore` = the account wrote in the thread before the burst, read from our own mirror (Matrix bronze /
 *   Gmail store), the rule the thread readers apply going forward.
 * - The matched row is handed to the ONE declaration loop (`declareDuePositiveReplies`) with
 *   `outcome_occurred_at = 'run_started_at'`: runs-service counts it at the run's start (COST-BACKFILL-1023-RUNS).
 * Idempotent: a row with any outcome state is never a candidate again, and runs-service answers a replayed
 * declaration `already_recorded`.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixRawEvents, peopleMessageTexts, replyTriggerReports, type ReplyTriggerReport } from "../../db/schema.js";
import { listOrgRuns, type ListedRun } from "../runs-client.js";
import { OUTCOME_STATUS } from "./outcome.js";

export const BACKFILL_OCCURRED_AT = "run_started_at";
export const UNMATCHED = "unmatched";
/** The pass run is opened by the burst's own Jev call, right after the row is first written. */
export const JUDGE_RUN_WINDOW = { beforeMs: 2_000, afterMs: 15_000 } as const;
/** The detection passes that judged reply bursts before the `reply-trigger.judge` child run existed. */
export const JUDGING_TASKS: Record<string, string[]> = {
  matrix: ["matrix.live", "matrix.sync"],
  gmail: ["reply-trigger.detect-gmail"],
};
const LOG = "[crm-service][reply-outcome-backfill]";

/** PURE: the run that judged one burst, or why none can be named. */
export function pickJudgeRun(
  row: { source: string; detectedAt: Date },
  runs: Array<Pick<ListedRun, "id" | "serviceName" | "taskName" | "startedAt" | "totalCostInUsdCents">>,
): { runId: string } | { unmatched: "no_judging_run" | "several_judging_runs" } {
  const tasks = JUDGING_TASKS[row.source] ?? [];
  const from = row.detectedAt.getTime() - JUDGE_RUN_WINDOW.beforeMs;
  const to = row.detectedAt.getTime() + JUDGE_RUN_WINDOW.afterMs;
  const hits = runs.filter((r) => {
    const at = Date.parse(r.startedAt);
    return r.serviceName === "crm-service" && tasks.includes(r.taskName) && at >= from && at <= to && Number(r.totalCostInUsdCents ?? 0) > 0;
  });
  if (hits.length === 0) return { unmatched: "no_judging_run" };
  if (hits.length > 1) return { unmatched: "several_judging_runs" };
  return { runId: hits[0].id };
}

/** Did the account write in this thread before the burst? Read from our own mirror. */
async function wroteBeforeBurst(r: ReplyTriggerReport): Promise<boolean> {
  if (r.source === "gmail") {
    if (!r.scopeId || !r.address) return false;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(peopleMessageTexts)
      .where(
        and(
          eq(peopleMessageTexts.scopeId, r.scopeId),
          eq(peopleMessageTexts.source, "gmail"),
          eq(peopleMessageTexts.address, r.address),
          eq(peopleMessageTexts.direction, "outbound"),
          lt(peopleMessageTexts.at, r.firstMessageAt),
        ),
      );
    return (row?.n ?? 0) > 0;
  }
  if (!r.connectionId || !r.roomId) return false;
  const [conn] = await db.select({ mxid: matrixConnections.matrixUserId }).from(matrixConnections).where(eq(matrixConnections.id, r.connectionId));
  if (!conn) return false;
  // A message the account sent (one of our sends or typed by hand), never an edit, a notice or an empty media line.
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matrixRawEvents)
    .where(
      and(
        eq(matrixRawEvents.roomId, r.roomId),
        eq(matrixRawEvents.sender, conn.mxid),
        eq(matrixRawEvents.eventType, "m.room.message"),
        lt(matrixRawEvents.originServerTs, r.firstMessageAt),
        sql`coalesce(${matrixRawEvents.payload}->'content'->>'msgtype', '') <> 'm.notice'`,
        sql`coalesce(${matrixRawEvents.payload}->'content'->'m.relates_to'->>'rel_type', '') <> 'm.replace'`,
        sql`length(trim(coalesce(${matrixRawEvents.payload}->'content'->>'body', ''))) > 0`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

export interface BackfillPass {
  dryRun: boolean;
  candidates: number;
  matched: number;
  unmatched: Record<string, number>;
  rows: Array<{ id: string; source: string; detectedAt: string; judgeRunId: string | null; wroteBefore: boolean | null; unmatched?: string }>;
}

/**
 * Hand every past positive reply to the declaration loop, on the run that judged it. `dryRun` writes nothing.
 * A runs-service read failure throws (nothing half-written for that row: each row is one UPDATE).
 */
export async function backfillPositiveReplies(opts: { dryRun?: boolean; now?: number } = {}): Promise<BackfillPass> {
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const rows = await db
    .select()
    .from(replyTriggerReports)
    .where(
      and(
        // Judged positive = the verdict let it through (any later delivery state); a judged non-positive one is `skipped`.
        sql`${replyTriggerReports.status} <> 'skipped'`,
        isNull(replyTriggerReports.outcomeStatus),
        isNull(replyTriggerReports.judgeRunId),
        sql`${replyTriggerReports.judgment}->>'status' = 'ok'`,
        sql`${replyTriggerReports.judgment} ? 'positive'`,
      ),
    )
    .orderBy(replyTriggerReports.detectedAt);
  const pass: BackfillPass = { dryRun, candidates: rows.length, matched: 0, unmatched: {}, rows: [] };

  for (const r of rows) {
    const runs = await listOrgRuns(r.orgId, {
      serviceName: "crm-service",
      startedAfter: new Date(r.detectedAt.getTime() - JUDGE_RUN_WINDOW.beforeMs).toISOString(),
      startedBefore: new Date(r.detectedAt.getTime() + JUDGE_RUN_WINDOW.afterMs).toISOString(),
    });
    const pick = pickJudgeRun(r, runs);
    if ("unmatched" in pick) {
      console.error(`${LOG} reply ${r.id} (${r.source}, detected ${r.detectedAt.toISOString()}): ${pick.unmatched}, NOT declared`);
      pass.unmatched[pick.unmatched] = (pass.unmatched[pick.unmatched] ?? 0) + 1;
      pass.rows.push({ id: r.id, source: r.source, detectedAt: r.detectedAt.toISOString(), judgeRunId: null, wroteBefore: null, unmatched: pick.unmatched });
      if (!dryRun) {
        await db
          .update(replyTriggerReports)
          .set({ outcomeStatus: UNMATCHED, outcomeReason: pick.unmatched })
          .where(and(eq(replyTriggerReports.id, r.id), isNull(replyTriggerReports.outcomeStatus)));
      }
      continue;
    }
    const wroteBefore = await wroteBeforeBurst(r);
    pass.matched += 1;
    pass.rows.push({ id: r.id, source: r.source, detectedAt: r.detectedAt.toISOString(), judgeRunId: pick.runId, wroteBefore });
    if (!dryRun) {
      await db
        .update(replyTriggerReports)
        .set({
          judgeRunId: pick.runId,
          wroteBefore,
          outcomeStatus: OUTCOME_STATUS.PENDING,
          outcomeNextAt: new Date(now),
          outcomeOccurredAt: BACKFILL_OCCURRED_AT,
        })
        .where(and(eq(replyTriggerReports.id, r.id), isNull(replyTriggerReports.outcomeStatus)));
    }
  }
  console.log(`${LOG} pass: ${JSON.stringify({ ...pass, rows: undefined })}`);
  return pass;
}
