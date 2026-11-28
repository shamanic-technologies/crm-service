/**
 * Google connections on the connector intake (GMAIL-SYNC-STALL-1128): every Gmail mailbox, Google Calendar and Search
 * Console connection google-service holds, with google-service's OWN verdict (its read cadence, its habit rule), served
 * as-is beside our mirrors on Monitoring > Connected tools. 2026-11-27 every Gmail grant was revoked at Google and the
 * mirror stayed frozen 23 h with nothing red anywhere.
 *
 * Read from google-service `GET /internal/connector-intake?days=` (cross-org). Its routes demand an identity + a run:
 * filed under the staff org (the calendar feed's identity), one run per read. Answers are shared for
 * `GOOGLE_INTAKE_FRESH_MS` (60 s) per window, one read in flight at a time. A failed read is NEVER an empty list: the
 * caller gets `{ok: false, error}` and the intake serves it red (`source_unreadable`).
 */
import { z } from "zod";
import { feedIdentity } from "./calendar/feed.js";
import { createRun, updateRun } from "./runs-client.js";

export const GOOGLE_INTAKE_FRESH_MS = Number(process.env.GOOGLE_INTAKE_FRESH_MS) || 60_000;
const TIMEOUT_MS = 20_000;

const connectionSchema = z.object({
  source: z.string().min(1),
  connectionId: z.string().min(1),
  orgId: z.string().min(1),
  brandId: z.string().nullable(),
  account: z.string().nullable(),
  syncStatus: z.string(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  status: z.enum(["ok", "red", "paused"]),
  reasons: z.array(z.object({ code: z.string(), text: z.string() })),
  newestRecordDay: z.string().nullable(),
  quietDays: z.number().nullable(),
  usualLongestQuietDays: z.number().nullable(),
  activeDaysInHistory: z.number(),
  byDay: z.array(z.object({ day: z.string(), records: z.number() })),
});
const answerSchema = z.object({ connections: z.array(connectionSchema) });

export type GoogleConnection = z.infer<typeof connectionSchema>;
export type GoogleIntake = { ok: true; connections: GoogleConnection[] } | { ok: false; error: string };

/** The raw read: identity + run, fetch, validate. Throws on anything but a well-formed answer. */
export async function fetchGoogleIntake(days: number): Promise<GoogleConnection[]> {
  const url = process.env.GOOGLE_SERVICE_URL;
  const key = process.env.GOOGLE_SERVICE_API_KEY;
  if (!url || !key) throw new Error("GOOGLE_SERVICE_URL and GOOGLE_SERVICE_API_KEY are not set");
  const identity = await feedIdentity();
  const run = await createRun({ orgId: identity.orgId, userId: identity.userId, serviceName: "crm-service", taskName: "ops.google-connector-intake" });
  let ok = false;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/internal/connector-intake?days=${days}`, {
      headers: { "x-api-key": key, "x-org-id": identity.orgId, "x-user-id": identity.userId, "x-run-id": run.id },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google-service GET /internal/connector-intake answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const parsed = answerSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`google-service connector intake answered an unexpected shape: ${parsed.error.message.slice(0, 300)}`);
    ok = true;
    return parsed.data.connections;
  } finally {
    await updateRun(run.id, ok ? "completed" : "failed", identity).catch((err) =>
      console.error(`[crm-service][google-intake] closing run ${run.id} failed:`, err),
    );
  }
}

const cache = new Map<number, { at: number; connections: GoogleConnection[] }>();
const inFlight = new Map<number, Promise<GoogleIntake>>();

/** google-service's Google connections for the window; a failure is returned (logged), never thrown nor emptied. */
export async function readGoogleIntake(days: number, fetcher: (days: number) => Promise<GoogleConnection[]> = fetchGoogleIntake): Promise<GoogleIntake> {
  const hit = cache.get(days);
  if (hit && Date.now() - hit.at < GOOGLE_INTAKE_FRESH_MS) return { ok: true, connections: hit.connections };
  const running = inFlight.get(days);
  if (running) return running;
  const p = (async (): Promise<GoogleIntake> => {
    try {
      const connections = await fetcher(days);
      cache.set(days, { at: Date.now(), connections });
      return { ok: true, connections };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[crm-service][google-intake] google-service connector intake unreadable: ${error}`);
      return { ok: false, error };
    } finally {
      inFlight.delete(days);
    }
  })();
  inFlight.set(days, p);
  return p;
}

/** Tests only. */
export function resetGoogleIntakeCache(): void {
  cache.clear();
  inFlight.clear();
}
