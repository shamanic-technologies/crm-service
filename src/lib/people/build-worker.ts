/**
 * The people build, off the request thread (CRM-BUILD-WORKER-1126).
 *
 * crm-service is ONE Node process: every route waits behind whatever synchronous work the process runs. On
 * 2026-11-26 its logs went silent for 4 to 18 minutes at a time (12:27 to 12:44, 14:58 to 15:12, 15:27 to
 * 15:37 UTC): no timer line, no request served. Each silence started after one scope's build and ended with the
 * build of distribute.you's own scope (~44k people) logging its summary: that build clusters, judges and rewrites
 * every person in memory, on the main thread. Meanwhile instantly-service's send gate asked
 * `POST /internal/people/stated-not-to-brand` (a read answering in ms), timed out 3 times in ~35 s, and the
 * follow-up it gated failed (9 failed follow-ups in 24 h, each lead pushed back a week).
 *
 * This module runs `buildScopePeople` in a worker thread, the fact emission's pattern
 * (fact-emission-worker.ts): its own event loop, heap, GC and DB pool. The build is the same function,
 * unchanged; everything it produces is in Postgres (rows, scope status, runs), nothing in process memory, so a
 * build in the worker is the same as a build inline. The one-at-a-time coalescing per scope stays in the caller
 * (`runScopeBuild`).
 *
 * Run from source (tsx / vitest: `.ts` modules) the build stays inline: a worker cannot load TypeScript.
 * `PEOPLE_BUILD_WORKER=off` keeps it inline in prod too (emergency off switch).
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { buildScopePeople, type BuildSummary } from "./build.js";
import type { PeopleScope } from "../../db/schema.js";

type Request = { id: number; scope: PeopleScope; runId: string };
type Reply = { id: number; ok: true; summary: BuildSummary } | { id: number; ok: false; error: string; stack?: string };

/** True when this module was loaded from compiled JS (the worker re-loads this very file). */
const COMPILED = import.meta.url.endsWith(".js");

export function buildRunsInWorker(): boolean {
  return COMPILED && process.env.PEOPLE_BUILD_WORKER !== "off";
}

// ─── worker side ─────────────────────────────────────────────────────────────

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (req: Request) => {
    buildScopePeople(req.scope, req.runId).then(
      (summary) => port.postMessage({ id: req.id, ok: true, summary } satisfies Reply),
      (err: Error) => port.postMessage({ id: req.id, ok: false, error: err?.message ?? String(err), stack: err?.stack } satisfies Reply),
    );
  });
}

// ─── main side ───────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (s: BuildSummary) => void; reject: (e: Error) => void }>();

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL(import.meta.url), {
    // Never the parent's flags (--import ./dist/instrument.js, --max-old-space-size).
    execArgv: [],
    // Its own heap: a 44k-person scope holds every presence and cluster in memory at once.
    resourceLimits: { maxOldGenerationSizeMb: 1536 },
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
  // A crashed worker fails every build it held (loud: runScopeBuild marks the scope in error) and starts again on the next one.
  w.on("error", (err) => {
    console.error("[crm-service] people build worker crashed:", err);
    if (worker === w) worker = null;
    failAll(new Error(`people build worker crashed: ${err.message}`));
  });
  w.on("exit", (code) => {
    if (worker === w) worker = null;
    if (pending.size) failAll(new Error(`people build worker exited (code ${code})`));
  });
  // Never keeps the process alive on its own (shutdown, tests).
  w.unref();
  worker = w;
  return w;
}

/** `buildScopePeople`, run in the build worker when compiled, inline otherwise. Same answer, same errors (by message). */
export function buildScopePeopleOffThread(scope: PeopleScope, runId: string): Promise<BuildSummary> {
  if (!buildRunsInWorker()) return buildScopePeople(scope, runId);
  const w = getWorker();
  const id = ++nextId;
  return new Promise<BuildSummary>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, scope, runId } satisfies Request);
  });
}
