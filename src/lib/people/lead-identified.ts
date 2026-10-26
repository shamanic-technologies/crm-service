/**
 * COST-ACCOUNTING-1024 (owner 2026-10-24: « le lead found appartient à ton service… c'est un outcome que tu produis »,
 * then « ça me dérange que ton lead found ait le même nom que leur lead found »; doctrine: agent-config skill
 * `cost-accounting`): when crm-service's Jev judgment tags a conversation `professional_to_brand` (this human x
 * company is a lead of the brand), the run that paid for the judgment PRODUCES `lead_identified`. `lead_found` stays
 * the serve that hands a person to a pipe (lead-service's, or our serve-next): it consumes this occurrence.
 *
 * - Subject = OUR human x company relation (`subjectService: "crm-service"`, `subjectId` = the relation key served on
 *   `people.relations`), held here, never a lead-service id.
 * - Run = `conversation_verdicts.run_id`: the run every Jev call of that judgment rode (people.build or the Matrix
 *   sync gate). Its whole spend (relevance, tags, automated senders, groups) rides the leads it identified (identity
 *   resolution rides a `people.identity` support child, LEDGER-CRM-UNDECLARED-1027);
 *   a run that identified nobody produced none (rule: normal loss rides the kept units).
 * - One occurrence per CONVERSATION, first seen once: a later re-judgment of the same thread adds none (its run then
 *   produced none). One per RELATION: a second conversation of an already-identified relation is `duplicate_subject`.
 * - ONE path for the past and the future: every pass reads every relation holding a `professional_to_brand` tag whose
 *   basis is a judged conversation, joins its verdict, records what is new, and declares through runs-service's batch
 *   door with `occurredAt` = the verdict's `judged_at` (the run's own time, COST-BACKFILL-1023-RUNS), so a lead
 *   identified in October counts in October. A verdict re-judged since its first run kept only its LATEST run: the
 *   earlier runs that judged it are not recorded anywhere and stay "produced none".
 * - Only a CONVERSATION judgment is production here: a tag earned from the brand's own tools (CRM, Stripe, Clerk...)
 *   costs nothing, and group tags (group-tags.ts) are not declared yet.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { leadIdentifiedDeclarations } from "../../db/schema.js";
import { declareOutcomesBatch, invalidRunsOf, type BatchRunOutcomes } from "../runs-client.js";

export const LEAD_IDENTIFIED_OUTCOME = "lead_identified";
export const CRM_SUBJECT_SERVICE = "crm-service";
export const STATUS = { PENDING: "pending", DECLARED: "declared", DUPLICATE_SUBJECT: "duplicate_subject", REFUSED: "refused" } as const;
const MAX_RUNS = 500;
const MAX_OCCURRENCES = 1000;
const INTERVAL_MS = () => Number(process.env.LEAD_IDENTIFIED_INTERVAL_MS) || 5 * 60_000;
const LOG = "[crm-service][lead-identified]";

export interface PendingDeclaration {
  id: string;
  runId: string;
  relationKey: string;
  judgedAt: Date;
}

/** PURE: what one batch states at runs-service, one entry per run (its earliest judgment = when it counts). */
export function batchBody(rows: PendingDeclaration[]): BatchRunOutcomes[] {
  const byRun = new Map<string, { subjects: Set<string>; at: Date }>();
  for (const r of rows) {
    const run = byRun.get(r.runId) ?? byRun.set(r.runId, { subjects: new Set(), at: r.judgedAt }).get(r.runId)!;
    run.subjects.add(r.relationKey);
    if (r.judgedAt < run.at) run.at = r.judgedAt;
  }
  return [...byRun.entries()].map(([runId, { subjects, at }]) => ({
    runId,
    produced: [...subjects].sort().map((subjectId) => ({ outcomeKey: LEAD_IDENTIFIED_OUTCOME, subjectService: CRM_SUBJECT_SERVICE, subjectId })),
    occurredAt: at.toISOString(),
  }));
}

/** PURE: cut due rows into batches runs-service accepts (<= 500 runs, <= 1000 occurrences), a run never split. */
export function batchesOf(rows: PendingDeclaration[]): PendingDeclaration[][] {
  const byRun = new Map<string, PendingDeclaration[]>();
  for (const r of rows) (byRun.get(r.runId) ?? byRun.set(r.runId, []).get(r.runId)!).push(r);
  const out: PendingDeclaration[][] = [];
  let cur: PendingDeclaration[] = [];
  let runs = 0;
  for (const group of byRun.values()) {
    if (cur.length > 0 && (runs + 1 > MAX_RUNS || cur.length + group.length > MAX_OCCURRENCES)) {
      out.push(cur);
      cur = [];
      runs = 0;
    }
    cur.push(...group);
    runs += 1;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Record every newly identified lead: a relation tagged `professional_to_brand` by a judged conversation whose
 * conversation was never recorded. The first conversation of a relation is `pending`, any other `duplicate_subject`.
 */
export async function recordNewIdentifications(): Promise<{ recorded: number; duplicates: number }> {
  const res = await db.execute<{ recorded: number; duplicates: number }>(sql`
    WITH judged AS (
      SELECT DISTINCT p.org_id, p.brand_id, rel->>'relationKey' AS relation_key, b->>'ref' AS conversation_key
      FROM people p
      CROSS JOIN LATERAL jsonb_array_elements(p.relations) rel
      CROSS JOIN LATERAL jsonb_array_elements(rel->'tags') t
      CROSS JOIN LATERAL jsonb_array_elements(t->'basis') b
      WHERE t->>'tag' = 'professional_to_brand' AND b->>'kind' = 'conversation'
    ), fresh AS (
      SELECT j.org_id, j.brand_id, j.relation_key, j.conversation_key, v.run_id, v.judged_at,
             row_number() OVER (PARTITION BY j.org_id, j.brand_id, j.relation_key ORDER BY v.judged_at, j.conversation_key) AS rank
      FROM judged j
      JOIN conversation_verdicts v
        ON v.org_id = j.org_id AND v.brand_id = j.brand_id AND v.conversation_key = j.conversation_key
      WHERE NOT EXISTS (
        SELECT 1 FROM lead_identified_declarations d
        WHERE d.org_id = j.org_id AND d.brand_id = j.brand_id AND d.conversation_key = j.conversation_key)
    ), ins AS (
      INSERT INTO lead_identified_declarations (org_id, brand_id, conversation_key, relation_key, run_id, judged_at, status, next_at)
      SELECT f.org_id, f.brand_id, f.conversation_key, f.relation_key, f.run_id, f.judged_at,
             CASE WHEN f.rank = 1 AND NOT EXISTS (
                    SELECT 1 FROM lead_identified_declarations d
                    WHERE d.org_id = f.org_id AND d.brand_id = f.brand_id AND d.relation_key = f.relation_key
                      AND d.status IN ('pending', 'declared'))
                  THEN 'pending' ELSE 'duplicate_subject' END,
             now()
      FROM fresh f
      ON CONFLICT (org_id, brand_id, conversation_key) DO NOTHING
      RETURNING status
    )
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS recorded,
           count(*) FILTER (WHERE status = 'duplicate_subject')::int AS duplicates
    FROM ins`);
  const row = (res as unknown as Array<{ recorded: number; duplicates: number }>)[0];
  return { recorded: row?.recorded ?? 0, duplicates: row?.duplicates ?? 0 };
}

export interface DeclarePass {
  due: number;
  declared: number;
  alreadyRecorded: number;
  refused: number;
  failed: number;
}

/** Declare every due identification at runs-service. A runs-service refusal of a run is kept (`refused`), loud. */
export async function declareDueIdentifications(now: number = Date.now()): Promise<DeclarePass> {
  const rows = await db
    .select({ id: leadIdentifiedDeclarations.id, runId: leadIdentifiedDeclarations.runId, relationKey: leadIdentifiedDeclarations.relationKey, judgedAt: leadIdentifiedDeclarations.judgedAt, attempts: leadIdentifiedDeclarations.attempts })
    .from(leadIdentifiedDeclarations)
    .where(and(eq(leadIdentifiedDeclarations.status, STATUS.PENDING), lte(leadIdentifiedDeclarations.nextAt, new Date(now))))
    .orderBy(asc(leadIdentifiedDeclarations.judgedAt))
    .limit(5000);
  const pass: DeclarePass = { due: rows.length, declared: 0, alreadyRecorded: 0, refused: 0, failed: 0 };
  for (let batch of batchesOf(rows)) {
    // A 422 names the invalid runs and writes nothing: refuse those, send the rest again.
    for (let tries = 0; batch.length > 0 && tries < 3; tries++) {
      try {
        const answer = await declareOutcomesBatch(batchBody(batch));
        await db
          .update(leadIdentifiedDeclarations)
          .set({ status: STATUS.DECLARED, declaredAt: new Date(now), lastError: null, nextAt: null, attempts: sql`${leadIdentifiedDeclarations.attempts} + 1` })
          .where(inArray(leadIdentifiedDeclarations.id, batch.map((r) => r.id)));
        pass.declared += answer.recordedCount;
        pass.alreadyRecorded += answer.alreadyRecordedCount;
        batch = [];
      } catch (err) {
        const invalid = invalidRunsOf(err);
        if (invalid) {
          const reasons = new Map(invalid.map((i) => [i.runId, `${i.reason}${i.message ? `: ${i.message}` : ""}`]));
          const refused = batch.filter((r) => reasons.has(r.runId));
          console.error(`${LOG} runs-service refused ${reasons.size} run(s): ${[...reasons].slice(0, 5).map(([r, why]) => `${r} (${why})`).join(", ")}`);
          for (const r of refused) {
            await db
              .update(leadIdentifiedDeclarations)
              .set({ status: STATUS.REFUSED, reason: reasons.get(r.runId)!.slice(0, 1000), nextAt: null, attempts: sql`${leadIdentifiedDeclarations.attempts} + 1` })
              .where(eq(leadIdentifiedDeclarations.id, r.id));
          }
          pass.refused += refused.length;
          batch = batch.filter((r) => !reasons.has(r.runId));
          continue;
        }
        const error = (err as Error).message.slice(0, 1000);
        console.error(`${LOG} declaring ${batch.length} identification(s) failed, retried later: ${error}`);
        await db
          .update(leadIdentifiedDeclarations)
          .set({ lastError: error, nextAt: new Date(now + 15 * 60_000), attempts: sql`${leadIdentifiedDeclarations.attempts} + 1` })
          .where(inArray(leadIdentifiedDeclarations.id, batch.map((r) => r.id)));
        pass.failed += batch.length;
        batch = [];
      }
    }
  }
  return pass;
}

/** One pass: record what is new, then declare it. */
export async function runLeadIdentifiedPass(): Promise<{ recorded: number; duplicates: number } & DeclarePass> {
  const found = await recordNewIdentifications();
  const pass = await declareDueIdentifications();
  if (found.recorded + found.duplicates + pass.due > 0) console.log(`${LOG} pass: ${JSON.stringify({ ...found, ...pass })}`);
  return { ...found, ...pass };
}

let running = false;

/** Every 5 min (first ~90 s after boot), one pass at a time. `LEAD_IDENTIFIED_DECLARATIONS=off` stops it. */
export function startLeadIdentifiedDeclarations(): void {
  if (process.env.LEAD_IDENTIFIED_DECLARATIONS === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runLeadIdentifiedPass()
      .catch((e) => console.error(`${LOG} pass failed:`, e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS()).unref();
  }, 90_000).unref();
}
