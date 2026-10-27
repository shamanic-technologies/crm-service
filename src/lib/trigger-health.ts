/**
 * Trigger reports for the dashboard v2 Monitoring hub (WA-GREETING-OFFER-1027): every occurrence crm-service
 * reports to campaign-service's trigger door (a form fill, a number given, a positive reply, an account event)
 * is a row with a status. A row NOT SENT (failed, or still pending / handing off) past `STUCK_AFTER_MS` is
 * STUCK: nobody got the message it was meant to start. 5 days of `offer_unknown` on "WhatsApp number given"
 * (2026-10-22 → 10-27, 7 numbers, 0 greetings) went unseen: this read is what turns it red.
 *
 * A reply handed to the email path is SENT (`handed_off`, with what the email path answered: `handOffs`). A LEGACY
 * `skipped / cold_email_path` Gmail row (decided on the recipient alone, no answer from the email path, before
 * EMAIL-REPLY-ORPHAN-1027) is a DROPPED reply until re-checked: stuck, red, never a quiet skip.
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
    stuckReports: {
      reportId: string;
      orgId: string | null;
      brandId: string | null;
      /** brand-service's name; null when the brand has none or it could not be read (logged). */
      brandName: string | null;
      /** WHO the report is about, as the report recorded them (a Gmail reply: its address). */
      person: { name: string | null; email: string | null; phone: string | null };
      status: string;
      reason: string | null;
      lastError: string | null;
      attempts: number;
      detectedAt: string;
    }[];
    byDay: { day: string; sent: number; skipped: number; notSent: number; handedOff: number }[];
    /** Replies handed to another service that acts on them (the email path), newest first, with its answer. */
    handOffs: {
      reportId: string;
      brandId: string | null;
      person: { name: string | null; email: string | null; phone: string | null };
      detectedAt: string;
      to: string;
      answer: unknown;
    }[];
  }[];
}

/**
 * `who` = the SQL naming the person on each table (name, email, phone). `dropped` = a skip that in fact dropped a
 * person's message (stuck at any age); `handOff` = a hand-off to the service that acts on it (counted as sent).
 */
const SOURCES: { trigger: string; table: string; at: string; scoped: boolean; who: string; dropped?: string; handOff?: string }[] = [
  { trigger: "form_submitted", table: "form_trigger_reports", at: "detected_at", scoped: true, who: "full_name AS p_name, email AS p_email, phone AS p_phone" },
  { trigger: "whatsapp_number_given", table: "phone_given_reports", at: "detected_at", scoped: true, who: "full_name AS p_name, email AS p_email, phone AS p_phone" },
  {
    trigger: "positive_reply_received",
    table: "reply_trigger_reports",
    at: "detected_at",
    scoped: true,
    who: "full_name AS p_name, COALESCE(email, address) AS p_email, phone AS p_phone",
    dropped: "source = 'gmail' AND status = 'skipped' AND reason = 'cold_email_path' AND email_path_answer IS NULL",
    handOff: "source = 'gmail' AND status = 'handed_off' AND reason = 'cold_email_path'",
  },
  { trigger: "account_event", table: "credit_event_reports", at: "created_at", scoped: false, who: "NULL::text AS p_name, email AS p_email, NULL::text AS p_phone" },
];

const BRAND_NAME_TTL_MS = 60 * 60_000;
const brandNameCache = new Map<string, { name: string | null; at: number }>();

/** brand-service's name per brand (key-only internal read), cached 1 h. Display only: unreadable = null, logged. */
async function brandNames(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const base = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const hit = brandNameCache.get(id);
      if (hit && Date.now() - hit.at < BRAND_NAME_TTL_MS) return out.set(id, hit.name);
      if (!base || !key) return out.set(id, null);
      try {
        const res = await fetch(`${base}/internal/brands/${encodeURIComponent(id)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`brand-service answered ${res.status}`);
        const name = ((await res.json()) as { brand?: { name?: string | null } }).brand?.name ?? null;
        brandNameCache.set(id, { name, at: Date.now() });
        out.set(id, name);
      } catch (err) {
        console.warn(`[crm-service][trigger-health] brand ${id} name unreadable: ${(err as Error).message}`);
        out.set(id, null);
      }
    }),
  );
  return out;
}

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
    const unsent = sql`(status NOT IN (${list([...SENT, ...SKIPPED])}) AND ${at} < ${stuckBefore}::timestamptz)`;
    const stuckWhere = s.dropped ? sql`(${unsent} OR (${sql.raw(s.dropped)}))` : unsent;
    const handOffWhere = s.handOff ? sql.raw(s.handOff) : sql.raw("false");
    const byReason = await rows<{ reason: string | null; count: number; oldest: Date; latest: Date }>(sql`
      SELECT reason, count(*)::int AS count, min(${at}) AS oldest, max(${at}) AS latest
      FROM ${t} WHERE ${stuckWhere} GROUP BY reason ORDER BY count(*) DESC, reason`);
    const stuckList = await rows<{ id: string; org_id: string | null; brand_id: string | null; p_name: string | null; p_email: string | null; p_phone: string | null; status: string; reason: string | null; last_error: string | null; attempts: number; at: Date }>(sql`
      SELECT id::text AS id, ${scope}, ${sql.raw(s.who)}, status, reason, last_error, attempts, ${at} AS at
      FROM ${t} WHERE ${stuckWhere} ORDER BY ${at} DESC, id LIMIT ${STUCK_LIST_LIMIT}`);
    const daily = await rows<{ day: string; sent: number; skipped: number; not_sent: number; handed_off: number }>(sql`
      SELECT to_char(date_trunc('day', ${at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE status IN (${list(SENT)}))::int AS sent,
        count(*) FILTER (WHERE status IN (${list(SKIPPED)}) AND NOT ${stuckWhere})::int AS skipped,
        count(*) FILTER (WHERE status NOT IN (${list([...SENT, ...SKIPPED])}) OR ${stuckWhere})::int AS not_sent,
        count(*) FILTER (WHERE ${handOffWhere})::int AS handed_off
      FROM ${t} WHERE ${at} >= ${since}::timestamptz GROUP BY 1 ORDER BY 1`);
    const handOffs = s.handOff
      ? await rows<{ id: string; brand_id: string | null; p_name: string | null; p_email: string | null; p_phone: string | null; at: Date; recipient: string | null; answer: unknown }>(sql`
          SELECT id::text AS id, ${scope}, ${sql.raw(s.who)}, ${at} AS at,
            messages->0->'to'->>0 AS recipient, email_path_answer AS answer
          FROM ${t} WHERE ${handOffWhere} AND ${at} >= ${since}::timestamptz ORDER BY ${at} DESC, id LIMIT ${STUCK_LIST_LIMIT}`)
      : [];
    const stuck = byReason.reduce((n, r) => n + r.count, 0);
    const names = await brandNames(stuckList.map((r) => r.brand_id).filter((b): b is string => !!b));
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
        brandName: r.brand_id ? (names.get(r.brand_id) ?? null) : null,
        person: { name: r.p_name, email: r.p_email, phone: r.p_phone },
        status: r.status,
        reason: r.reason,
        lastError: r.last_error,
        attempts: r.attempts,
        detectedAt: new Date(r.at).toISOString(),
      })),
      byDay: daily.map((d) => ({ day: d.day, sent: d.sent, skipped: d.skipped, notSent: d.not_sent, handedOff: d.handed_off })),
      handOffs: handOffs.map((h) => ({
        reportId: h.id,
        brandId: h.brand_id,
        person: { name: h.p_name, email: h.p_email, phone: h.p_phone },
        detectedAt: new Date(h.at).toISOString(),
        to: h.recipient ?? "",
        answer: h.answer,
      })),
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
