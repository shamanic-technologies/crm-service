/**
 * The fact emission, off the request thread (MON-PAGE-SPEED-1114).
 *
 * crm-service is ONE Node process: every page read (Outcomes, the Unibox timeline, the people list) waits
 * behind whatever synchronous work the process runs. A CPU profile of prod (2026-11-14, 60 s) put the fact
 * emission at ~24 % of the thread by its own frames, plus most of the driver's row parsing and the garbage
 * collection it causes: distribute.you's emission re-reads ~50k live facts and re-derives every candidate of
 * 41k people (15-38 s), back to back whenever any of its inputs moved, to state 1-2 new facts. `/health`
 * answered in p90 1.1 s, max 2.4 s; every Unibox / Outcomes read paid that wait.
 *
 * This module runs `emitScopeFacts` in a worker thread: its own event loop, its own heap and GC, its own DB
 * pool. The emission is the same function, unchanged; its locks are Postgres advisory locks (FEED_LOCK, the
 * brand feed lock), so they hold across threads exactly as across requests. The one-at-a-time coalescing per
 * scope stays in the caller (fact-emitter.ts).
 *
 * Run from source (tsx / vitest: `.ts` modules) the emission stays inline: a worker cannot load TypeScript.
 * `FACT_EMIT_WORKER=off` keeps it inline in prod too (emergency off switch).
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { emitScopeFacts, type FactEmissionSummary } from "./facts.js";

type EmitScope = { id: string; orgId: string; brandId: string };
type Request = { id: number; scope: EmitScope };
type Reply = { id: number; ok: true; summary: FactEmissionSummary } | { id: number; ok: false; error: string; stack?: string };

/** True when this module was loaded from compiled JS (the worker re-loads this very file). */
const COMPILED = import.meta.url.endsWith(".js");

export function emissionRunsInWorker(): boolean {
  return COMPILED && process.env.FACT_EMIT_WORKER !== "off";
}

// ─── worker side ─────────────────────────────────────────────────────────────

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (req: Request) => {
    emitScopeFacts(req.scope).then(
      (summary) => port.postMessage({ id: req.id, ok: true, summary } satisfies Reply),
      (err: Error) => port.postMessage({ id: req.id, ok: false, error: err?.message ?? String(err), stack: err?.stack } satisfies Reply),
    );
  });
}

// ─── main side ───────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (s: FactEmissionSummary) => void; reject: (e: Error) => void }>();

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL(import.meta.url), {
    // Its own heap: the emission's reads are big (the main thread runs with --max-old-space-size=1280).
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
  });
  w.on("message", (reply: Reply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.summary);
    else {
      const err = new Error(reply.error);
      if (reply.stack) err.stack = reply.stack;
      p.reject(err);
    }
  });
  // A crashed worker fails every emission it held (loud, the emitter logs it) and is started again on the next one.
  w.on("error", (err) => {
    console.error("[crm-service][facts] emission worker crashed:", err);
    if (worker === w) worker = null;
    failAll(new Error(`fact emission worker crashed: ${err.message}`));
  });
  w.on("exit", (code) => {
    if (worker === w) worker = null;
    if (pending.size) failAll(new Error(`fact emission worker exited (code ${code})`));
  });
  // Never keeps the process alive on its own (shutdown, tests).
  w.unref();
  worker = w;
  return w;
}

/** `emitScopeFacts`, run in the emission worker when compiled, inline otherwise. Same answer, same errors (by message). */
export function emitScopeFactsOffThread(scope: EmitScope): Promise<FactEmissionSummary> {
  if (!emissionRunsInWorker()) return emitScopeFacts(scope);
  const w = getWorker();
  const id = ++nextId;
  return new Promise<FactEmissionSummary>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, scope: { id: scope.id, orgId: scope.orgId, brandId: scope.brandId } } satisfies Request);
  });
}
