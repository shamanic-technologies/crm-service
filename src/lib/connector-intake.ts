/**
 * Connector intake for the dashboard v2 Monitoring hub (GHL-MIRROR-FROZEN-1028): per mirror connection (GoHighLevel,
 * PostHog, Stripe, auth provider), how many records the VENDOR dates on each UTC day, read from bronze, and whether
 * the connection went unusually quiet (rule: `connector-intake-core.ts`). Read-only, fleet-wide, recomputed from the
 * dated bronze rows on every read (nothing else to store). Sends nothing: red on the Monitoring hub is the alert.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandNames } from "./trigger-health.js";
import { assessIntake, dailySeries, HISTORY_DAYS, MIN_ACTIVE_DAYS, MIN_QUIET_DAYS, SYNC_LATE_AFTER_MS, type IntakeAssessment } from "./connector-intake-core.js";

/**
 * Each source: its connection table, its bronze table, and per bronze kind the payload key holding the vendor's own
 * creation date (ISO text, or epoch seconds / milliseconds). A kind not listed (pipelines, calendars, forms: setup,
 * not activity) counts for nothing.
 */
const SOURCES: { source: string; connections: string; raw: string; account: string; dateKey: Record<string, string> }[] = [
  {
    source: "gohighlevel",
    connections: "ghl_connections",
    raw: "ghl_raw_records",
    account: "c.location_id",
    dateKey: { contact: "dateAdded", opportunity: "createdAt", appointment: "dateAdded", form_submission: "createdAt" },
  },
  {
    source: "posthog",
    connections: "posthog_connections",
    raw: "posthog_raw_records",
    account: "c.project_id::text",
    dateKey: { visit: "started_at", event: "timestamp", person: "created_at" },
  },
  {
    source: "stripe",
    connections: "stripe_connections",
    raw: "stripe_raw_records",
    account: "COALESCE(c.account_name, c.account_id, c.credential_provider)",
    dateKey: { charge: "created", refund: "created", customer: "created" },
  },
  {
    source: "auth",
    connections: "auth_connections",
    raw: "auth_raw_records",
    account: "c.provider",
    dateKey: { user: "created_at", membership: "created_at" },
  },
];

export interface ConnectorIntake {
  generatedAt: string;
  days: number;
  rule: { historyDays: number; minActiveDays: number; minQuietDays: number; syncLateAfterMinutes: number };
  status: "ok" | "red";
  connections: ({
    source: string;
    connectionId: string;
    orgId: string;
    brandId: string;
    brandName: string | null;
    account: string | null;
    syncStatus: string;
    lastSyncedAt: string | null;
    lastError: string | null;
    byDay: { day: string; records: number }[];
  } & IntakeAssessment)[];
}

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

/** The UTC day of a vendor date held in jsonb: epoch number (s or ms) or ISO-like text; anything else = null. */
const DAY_OF = (v: string) => `CASE
  WHEN jsonb_typeof(${v}) = 'number' THEN (to_timestamp(CASE WHEN (${v})::text::numeric > 1e11 THEN (${v})::text::numeric / 1000 ELSE (${v})::text::numeric END) AT TIME ZONE 'UTC')::date
  WHEN jsonb_typeof(${v}) = 'string' AND (${v} #>> '{}') ~ '^\\d{4}-\\d{2}-\\d{2}' THEN left(${v} #>> '{}', 10)::date
END`;

export async function readConnectorIntake(days: number, now: number = Date.now()): Promise<ConnectorIntake> {
  const since = new Date(now - (HISTORY_DAYS + days + 1) * 86_400_000).toISOString().slice(0, 10);
  const connections: ConnectorIntake["connections"] = [];
  for (const s of SOURCES) {
    const conns = await rows<{ id: string; org_id: string; brand_id: string; account: string | null; status: string; last_synced_at: Date | null; last_error: string | null }>(sql`
      SELECT c.id::text AS id, c.org_id::text AS org_id, c.brand_id::text AS brand_id, ${sql.raw(s.account)} AS account,
        c.status, c.last_synced_at, c.last_error
      FROM ${sql.raw(s.connections)} c ORDER BY c.created_at, c.id`);
    if (conns.length === 0) continue;
    const keyCase = `CASE r.kind ${Object.entries(s.dateKey).map(([k, f]) => `WHEN '${k}' THEN '${f}'`).join(" ")} END`;
    const counts = await rows<{ connection_id: string; day: string; records: number }>(sql`
      SELECT connection_id, to_char(day, 'YYYY-MM-DD') AS day, count(*)::int AS records FROM (
        SELECT r.connection_id::text AS connection_id, ${sql.raw(DAY_OF(`(r.payload -> (${keyCase}))`))} AS day
        FROM ${sql.raw(s.raw)} r WHERE r.kind IN (${sql.join(Object.keys(s.dateKey).map((k) => sql`${k}`), sql`, `)})
      ) x WHERE day IS NOT NULL AND day >= ${since}::date GROUP BY 1, 2`);
    const byConn = new Map<string, Map<string, number>>();
    for (const c of counts) {
      if (!byConn.has(c.connection_id)) byConn.set(c.connection_id, new Map());
      byConn.get(c.connection_id)!.set(c.day, c.records);
    }
    const names = await brandNames(conns.map((c) => c.brand_id));
    for (const c of conns) {
      const perDay = byConn.get(c.id) ?? new Map<string, number>();
      const lastSyncedAt = c.last_synced_at ? new Date(c.last_synced_at) : null;
      connections.push({
        // An auth provider is named by itself (clerk), like the people source.
        source: s.source === "auth" ? (c.account ?? s.source) : s.source,
        connectionId: c.id,
        orgId: c.org_id,
        brandId: c.brand_id,
        brandName: names.get(c.brand_id) ?? null,
        account: c.account,
        syncStatus: c.status,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
        lastError: c.last_error,
        ...assessIntake({ activeDays: [...perDay.keys()], syncStatus: c.status, lastSyncedAt, lastError: c.last_error, now }),
        byDay: dailySeries(perDay, days, now),
      });
    }
  }
  return {
    generatedAt: new Date(now).toISOString(),
    days,
    rule: { historyDays: HISTORY_DAYS, minActiveDays: MIN_ACTIVE_DAYS, minQuietDays: MIN_QUIET_DAYS, syncLateAfterMinutes: SYNC_LATE_AFTER_MS / 60_000 },
    status: connections.some((c) => c.status === "red") ? "red" : "ok",
    connections,
  };
}
