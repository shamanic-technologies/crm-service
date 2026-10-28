/**
 * The fact emitter (UNIBOX-FACT-LAG-1028, owner 2026-10-28: « Les paiements refusés doivent être dans
 * l'unibox tout simplement, comme toutes les tentatives de paiement d'ailleurs et autres actions du
 * dashboard et de l'onboarding!! »).
 *
 * Every record crm-service holds is stated on the people fact feed within about a minute, for every
 * scope, whatever its source. Before, facts were emitted only at the END of a whole people build: two
 * refused Stripe charges mirrored at 05:04:04 reached the feed at 05:08:43 (+ ~50 s to commit), because
 * the new Stripe customer was nobody until a build joined it (held), and the next build re-read every
 * source of 31k people before emitting.
 *
 * - `requestEmission(scope)`: one emission per scope at a time; a request while one runs is coalesced
 *   into ONE more run after it (it may have read too early), never queued twice.
 * - The watch (`startFactEmitter`): every `FACT_EMIT_INTERVAL_MS` (10 s, first pass 60 s after boot,
 *   one pass at a time; `FACT_EMIT=off` stops it) reads each scope's INPUTS MARK (the latest write to
 *   every table a fact is derived from, index-only) and emits the scopes whose mark moved. A people
 *   build still emits right after itself (through `requestEmission`), so anything the mark does not see
 *   (a vendor record deleted, a judgment stored) is stated at the next build, as before.
 *
 * The emission itself is a diff (facts.ts): a scope whose records moved without changing a fact writes
 * nothing.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleScopes, type PeopleScope } from "../../db/schema.js";
import { emitScopeFacts, type FactEmissionSummary } from "./facts.js";

export const FACT_EMIT_INTERVAL_MS = Number(process.env.FACT_EMIT_INTERVAL_MS) || 10_000;
const FIRST_PASS_DELAY_MS = 60_000;

type EmitScope = Pick<PeopleScope, "id" | "orgId" | "brandId">;

const running = new Map<string, Promise<FactEmissionSummary>>();
const queued = new Map<string, Promise<FactEmissionSummary>>();

function start(scope: EmitScope): Promise<FactEmissionSummary> {
  const run = emitScopeFacts(scope).finally(() => {
    if (running.get(scope.id) === run) running.delete(scope.id);
  });
  running.set(scope.id, run);
  return run;
}

/**
 * Emit the scope's facts now. One emission per scope at a time in this process; a request while one
 * runs resolves with the run that starts right after it (the running one may have read too early).
 */
export function requestEmission(scope: EmitScope): Promise<FactEmissionSummary> {
  const waiting = queued.get(scope.id);
  if (waiting) return waiting;
  const current = running.get(scope.id);
  if (!current) return start(scope);
  const next = current
    .catch(() => undefined)
    .then(() => {
      queued.delete(scope.id);
      return start(scope);
    });
  queued.set(scope.id, next);
  return next;
}

/**
 * The scope's INPUTS MARK: the latest write to every table a fact of the scope is derived from
 * (silver contacts and activities, Matrix events, the Gmail / cold-email store, CRM funnel records,
 * calendar meetings, credit events) + the last build + the contacts count (a deleted record). Same
 * mark = nothing new to state. Each part reads one index (migration 0068) or a small table.
 */
export async function inputsMark(scope: EmitScope): Promise<string> {
  const { orgId, brandId, id } = scope;
  const ob = sql`org_id = ${orgId} AND brand_id = ${brandId}`;
  const [row] = (await db.execute(sql`
    SELECT concat_ws('|',
      (SELECT last_built_at FROM people_scopes WHERE id = ${id}),
      (SELECT count(*) FROM contacts WHERE ${ob}),
      (SELECT max(last_rebuilt_at) FROM contacts WHERE ${ob}),
      (SELECT max(last_rebuilt_at) FROM posthog_activities WHERE ${ob}),
      (SELECT max(last_rebuilt_at) FROM stripe_transactions WHERE ${ob}),
      (SELECT max(ingested_at) FROM matrix_raw_events WHERE ${ob}),
      (SELECT max(last_rebuilt_at) FROM conversations WHERE ${ob}),
      (SELECT max(at) FROM people_message_texts WHERE scope_id = ${id}),
      (SELECT max(last_rebuilt_at) FROM ghl_appointments WHERE ${ob}),
      (SELECT max(last_rebuilt_at) FROM ghl_opportunities WHERE ${ob}),
      (SELECT max(last_rebuilt_at) FROM ghl_form_submissions WHERE ${ob}),
      (SELECT max(observed_at) FROM ghl_opportunity_history WHERE ${ob}),
      (SELECT max(mirrored_at) FROM calendar_events WHERE org_id = ${orgId}),
      (SELECT max(greatest(received_at, members_resolved_at)) FROM credit_events)
    ) AS mark
  `)) as unknown as { mark: string }[];
  return row.mark;
}

/** The last mark each scope was emitted at, in this process (a restart emits every scope once). */
const emittedAt = new Map<string, string>();

export interface FactEmitterPass {
  scopes: number;
  emitted: { scopeId: string; facts: number; withdrawn: number; ms: number }[];
  failed: { scopeId: string; error: string }[];
}

/** One pass: emit every scope whose inputs moved since its last emission. */
export async function factEmitterPass(): Promise<FactEmitterPass> {
  const scopes = await db.select({ id: peopleScopes.id, orgId: peopleScopes.orgId, brandId: peopleScopes.brandId }).from(peopleScopes);
  const out: FactEmitterPass = { scopes: scopes.length, emitted: [], failed: [] };
  for (const scope of scopes) {
    try {
      const mark = await inputsMark(scope);
      if (emittedAt.get(scope.id) === mark) continue;
      const startedAt = Date.now();
      const summary = await requestEmission(scope);
      // The mark read BEFORE the emission: a write during it moves the mark again, so the next pass emits.
      emittedAt.set(scope.id, mark);
      if (summary.emitted > 0 || summary.corrected + summary.withdrawnGone > 0) {
        out.emitted.push({ scopeId: scope.id, facts: summary.emitted, withdrawn: summary.corrected + summary.withdrawnGone, ms: Date.now() - startedAt });
      }
    } catch (err) {
      out.failed.push({ scopeId: scope.id, error: (err as Error).message });
    }
  }
  return out;
}

let passRunning = false;

export function startFactEmitter(): void {
  if (process.env.FACT_EMIT === "off") return;
  const tick = () => {
    if (passRunning) return;
    passRunning = true;
    factEmitterPass()
      .then((r) => {
        if (r.emitted.length) console.log(`[crm-service][facts] emitted ${JSON.stringify(r.emitted)}`);
        for (const f of r.failed) console.error(`[crm-service][facts] emission failed scope=${f.scopeId}: ${f.error}`);
      })
      .catch((e) => console.error("[crm-service][facts] pass failed:", e))
      .finally(() => {
        passRunning = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, FACT_EMIT_INTERVAL_MS).unref();
  }, FIRST_PASS_DELAY_MS).unref();
}
