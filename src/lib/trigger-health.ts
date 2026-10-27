/**
 * Trigger reports for the dashboard v2 Monitoring hub (WA-GREETING-OFFER-1027): every occurrence crm-service
 * reports to campaign-service's trigger door (a form fill, a number given, a positive reply, an account event)
 * is a row with a status. A row NOT SENT (failed, or still pending / handing off) past `STUCK_AFTER_MS` is
 * STUCK: nobody got the message it was meant to start. 5 days of `offer_unknown` on "WhatsApp number given"
 * (2026-10-22 → 10-27, 7 numbers, 0 greetings) went unseen: this read is what turns it red.
 *
 * Read-only, fleet-wide, from the report rows themselves (each is dated: the daily series is recomputed from
 * them, nothing else to store). Sends nothing: red on the Monitoring hub is the alert (owner rule).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/** A row younger than this is still in flight (the loops retry every minute). */
export const STUCK_AFTER_MS = 15 * 60_000;
const STUCK_LIST_LIMIT = 100;

/** Statuses meaning the occurrence reached campaign-service (or the Copilot). */
const SENT = ["reported", "handed_off"];
/** Statuses meaning nothing was to be sent, by rule (history, a calendar form, not positive, withheld...). */
const SKIPPED = ["skipped"];

export interface TriggerHealth {
  generatedAt: string;
  days: number;
  stuckAfterMinutes: number;
  /** red = at least one stuck report, over every trigger. */
  status: "ok" | "red";
  triggers: {
    trigger: string;
    table: string;
    status: "ok" | "red";
    stuck: number;
    stuckByReason: { reason: string | null; count: number; oldestAt: string; latestAt: string }[];
    stuckReports: { reportId: string; orgId: string | null; brandId: string | null; status: string; reason: string | null; lastError: string | null; attempts: number; detectedAt: string }[];
    byDay: { day: string; sent: number; skipped: number; notSent: number }[];
  }[];
}

const SOURCES = [
  { trigger: "form_submitted", table: "form_trigger_reports", at: "detected_at", scoped: true },
  { trigger: "whatsapp_number_given", table: "phone_given_reports", at: "detected_at", scoped: true },
  { trigger: "positive_reply_received", table: "reply_trigger_reports", at: "detected_at", scoped: true },
  { trigger: "account_event", table: "credit_event_reports", at: "created_at", scoped: false },
] as const;

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];
const list = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

export async function readTriggerHealth(days: number, now: number = Date.now()): Promise<TriggerHealth> {
  // Bound as ISO text + cast: postgres.js refuses a Date in a raw sql`` parameter.
  const stuckBefore = new Date(now - STUCK_AFTER_MS).toISOString();
  const since = new Date(now - days * 86_400_000).toISOString();
  const triggers: TriggerHealth["triggers"] = [];
  for (const s of SOURCES) {
    const t = sql.raw(s.table);
    const at = sql.raw(s.at);
    const scope = s.scoped ? sql.raw("org_id::text AS org_id, brand_id::text AS brand_id") : sql.raw("NULL::text AS org_id, NULL::text AS brand_id");
    const stuckWhere = sql`status NOT IN (${list([...SENT, ...SKIPPED])}) AND ${at} < ${stuckBefore}::timestamptz`;
    const byReason = await rows<{ reason: string | null; count: number; oldest: Date; latest: Date }>(sql`
      SELECT reason, count(*)::int AS count, min(${at}) AS oldest, max(${at}) AS latest
      FROM ${t} WHERE ${stuckWhere} GROUP BY reason ORDER BY count(*) DESC, reason`);
    const stuckList = await rows<{ id: string; org_id: string | null; brand_id: string | null; status: string; reason: string | null; last_error: string | null; attempts: number; at: Date }>(sql`
      SELECT id::text AS id, ${scope}, status, reason, last_error, attempts, ${at} AS at
      FROM ${t} WHERE ${stuckWhere} ORDER BY ${at} DESC, id LIMIT ${STUCK_LIST_LIMIT}`);
    const daily = await rows<{ day: string; sent: number; skipped: number; not_sent: number }>(sql`
      SELECT to_char(date_trunc('day', ${at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE status IN (${list(SENT)}))::int AS sent,
        count(*) FILTER (WHERE status IN (${list(SKIPPED)}))::int AS skipped,
        count(*) FILTER (WHERE status NOT IN (${list([...SENT, ...SKIPPED])}))::int AS not_sent
      FROM ${t} WHERE ${at} >= ${since}::timestamptz GROUP BY 1 ORDER BY 1`);
    const stuck = byReason.reduce((n, r) => n + r.count, 0);
    triggers.push({
      trigger: s.trigger,
      table: s.table,
      status: stuck > 0 ? "red" : "ok",
      stuck,
      stuckByReason: byReason.map((r) => ({ reason: r.reason, count: r.count, oldestAt: new Date(r.oldest).toISOString(), latestAt: new Date(r.latest).toISOString() })),
      stuckReports: stuckList.map((r) => ({
        reportId: r.id,
        orgId: r.org_id,
        brandId: r.brand_id,
        status: r.status,
        reason: r.reason,
        lastError: r.last_error,
        attempts: r.attempts,
        detectedAt: new Date(r.at).toISOString(),
      })),
      byDay: daily.map((d) => ({ day: d.day, sent: d.sent, skipped: d.skipped, notSent: d.not_sent })),
    });
  }
  return {
    generatedAt: new Date(now).toISOString(),
    days,
    stuckAfterMinutes: STUCK_AFTER_MS / 60_000,
    status: triggers.some((t) => t.status === "red") ? "red" : "ok",
    triggers,
  };
}
