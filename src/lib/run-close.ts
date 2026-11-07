/**
 * POSTHOG-RUNCLOSE-1107: closing a run is OUR bookkeeping, never the client's connection.
 *
 * Observed 2026-11-07 15:17 UTC: a PostHog read succeeded and wrote `active`, then `PATCH /v1/runs/<id>` timed out
 * (runs-service slow under a staff cost re-price), the sync's catch overwrote the connection to `error` with the raw
 * runs-service message, and the pass-level platform run close crashed the pass. The client read "Needs attention"
 * beside "Last read 15:17".
 *
 * So a run close (org run or platform run) goes through here: retried in-process, and when runs-service still does not
 * answer, logged LOUD with the run id + context and retried once more later (a run is never left open forever because of
 * one timeout). It never throws: the caller's real work already succeeded or failed on its own.
 *
 * And `connectionErrorText` is the ONLY text a sync writes into a client-read `last_error`: plain words about THEIR
 * connection, never our plumbing (service names, run ids, timeouts of our own calls).
 */
import { RunsServiceError, updatePlatformRun, updateRun, type IdentityHeaders } from "./runs-client.js";

type RunStatus = "completed" | "failed";

/** Delays between in-process attempts (ms), then one late retry. Env-tunable so tests run in milliseconds. */
function retryDelays(): number[] {
  const raw = process.env.RUN_CLOSE_RETRY_DELAYS_MS;
  if (raw) return raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return [2_000, 5_000];
}
function lateRetryMs(): number {
  const raw = Number(process.env.RUN_CLOSE_LATE_RETRY_MS);
  return Number.isFinite(raw) && raw >= 0 && process.env.RUN_CLOSE_LATE_RETRY_MS ? raw : 120_000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeWithRetries(close: () => Promise<unknown>, label: string): Promise<boolean> {
  const delays = retryDelays();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await close();
      if (attempt > 0) console.log(`[crm-service][run-close] ${label}: closed on attempt ${attempt + 1}`);
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  console.error(
    `[crm-service][run-close] ${label}: runs-service did not take the close after ${delays.length + 1} attempts, retrying in ${lateRetryMs()}ms:`,
    lastErr,
  );
  const timer = setTimeout(() => {
    close().then(
      () => console.log(`[crm-service][run-close] ${label}: closed on the late retry`),
      (err) => console.error(`[crm-service][run-close] ${label}: late retry failed too, run left open:`, err),
    );
  }, lateRetryMs());
  timer.unref?.();
  return false;
}

/**
 * Close an org run. Never throws; false = still open after the in-process attempts (a late retry is scheduled).
 * `context` names what the run was about (e.g. `posthog connection <id>`), so the loud log is actionable.
 */
export function closeRun(runId: string, status: RunStatus, identity: IdentityHeaders, context: string): Promise<boolean> {
  return closeWithRetries(() => updateRun(runId, status, identity), `${context} run ${runId} -> ${status}`);
}

/** Close a platform run (the pass-level run of an internal trigger). Never throws, same contract as `closeRun`. */
export function closePlatformRun(runId: string, status: RunStatus, serviceName: string, context: string): Promise<boolean> {
  return closeWithRetries(() => updatePlatformRun(runId, status, serviceName), `${context} platform run ${runId} -> ${status}`);
}

/** Run tracking (runs-service) failed under the work: bookkeeping on our side, never a fact about the client's connection. */
export function isRunTrackingFailure(err: unknown): boolean {
  return err instanceof RunsServiceError;
}

/**
 * The text a client reads as the reason their `<vendor>` connection needs attention. Plain words about THEIR
 * connection: the vendor's own refusal when the vendor answered, a missing key when none is saved, otherwise a short
 * "we could not read it, we retry" (the raw cause is logged by the caller, never shown).
 */
export function connectionErrorText(vendor: string, err: unknown): string {
  const e = err as { name?: string; message?: string; status?: unknown; vendorMessage?: unknown; kind?: unknown };
  const message = typeof e?.message === "string" ? e.message : "";
  if ((e?.name === "CredentialError" && e.kind === "missing") || /^no .+ credential stored for brand/.test(message)) {
    return `No ${vendor} key is saved for this brand. Connect ${vendor} again.`;
  }
  if (typeof e?.status === "number" && typeof e?.vendorMessage === "string") {
    const words = e.vendorMessage.trim();
    if (e.status === 401 || e.status === 403) return `${vendor} refused the key: ${words}`;
    if (e.status === 404) return `${vendor} could not find this account or project: ${words}`;
    if (e.status === 429) return `${vendor} asked us to slow down: ${words}`;
    return `${vendor} answered an error (${e.status}): ${words}`;
  }
  return `We could not read your ${vendor} data on the last try. The next read tries again on its own.`;
}
