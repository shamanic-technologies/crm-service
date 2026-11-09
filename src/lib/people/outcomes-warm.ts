/**
 * DASH-SPEED-1110 — keeps every people scope's Outcomes answer stored and recent, so a dashboard
 * page opening a brand nobody looked at lately (or right after a deploy) is served at once instead
 * of waiting 5-30 s for lead-service's buckets and the counts (outcomes.ts).
 *
 * Every `OUTCOMES_WARM_INTERVAL_MS` (5 min; first pass 90 s after boot, never awaited before
 * listen), each scope whose stored answer is older than `outcomesWarmAfterMs()` (20 min) or missing
 * is recomputed on ONE org run of its own (the scope's creator), one scope at a time. A scope a tab
 * is reading is refreshed by its reads and skipped here. `OUTCOMES_WARM=off` stops it.
 * One failing scope does not stop the others; its old answer stays served until it is too old.
 */
import { db } from "../../db/index.js";
import { peopleScopes } from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { outcomesAge, outcomesWarmAfterMs, refreshOutcomes } from "./outcomes.js";

const LOG = "[crm-service][outcomes-warm]";

export interface WarmResult {
  scopeId: string;
  brandId: string;
  refreshed: boolean;
  ms?: number;
  error?: string;
}

let running = false;

/** One pass over every scope. Null when a pass already runs. */
export async function runOutcomesWarmPass(): Promise<WarmResult[] | null> {
  if (running) return null;
  running = true;
  try {
    const scopes = await db
      .select({ id: peopleScopes.id, orgId: peopleScopes.orgId, brandId: peopleScopes.brandId, createdByUserId: peopleScopes.createdByUserId })
      .from(peopleScopes);
    const out: WarmResult[] = [];
    for (const scope of scopes) {
      const age = await outcomesAge(scope.orgId, scope.brandId);
      if (age !== undefined && age < outcomesWarmAfterMs()) {
        out.push({ scopeId: scope.id, brandId: scope.brandId, refreshed: false });
        continue;
      }
      const startedAt = Date.now();
      const identity = { orgId: scope.orgId, userId: scope.createdByUserId };
      try {
        const run = await createRun({ ...identity, brandIds: [scope.brandId], serviceName: "crm-service", taskName: "people.outcomes.warm" });
        try {
          await refreshOutcomes({ ...identity, runId: run.id, brandId: scope.brandId });
          await updateRun(run.id, "completed", identity);
        } catch (err) {
          await updateRun(run.id, "failed", identity).catch((e) => console.error(`${LOG} failed to close run ${run.id}:`, e));
          throw err;
        }
        out.push({ scopeId: scope.id, brandId: scope.brandId, refreshed: true, ms: Date.now() - startedAt });
      } catch (err) {
        console.error(`${LOG} scope=${scope.id} brand=${scope.brandId} failed:`, (err as Error).message);
        out.push({ scopeId: scope.id, brandId: scope.brandId, refreshed: false, error: (err as Error).message });
      }
    }
    const refreshed = out.filter((r) => r.refreshed);
    if (refreshed.length || out.some((r) => r.error)) {
      console.log(`${LOG} pass refreshed=${refreshed.length} failed=${out.filter((r) => r.error).length} scopes=${out.length}`);
    }
    return out;
  } finally {
    running = false;
  }
}

const INTERVAL_MS = () => Number(process.env.OUTCOMES_WARM_INTERVAL_MS) || 5 * 60_000;

/** Every 5 min (first pass 90 s after boot); `OUTCOMES_WARM=off` stops it. */
export function startOutcomesWarm(): void {
  if (process.env.OUTCOMES_WARM === "off") {
    console.log(`${LOG} off (OUTCOMES_WARM=off)`);
    return;
  }
  const tick = () => {
    runOutcomesWarmPass().catch((err) => console.error(`${LOG} pass crashed:`, err));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS()).unref();
  }, 90_000).unref();
}
