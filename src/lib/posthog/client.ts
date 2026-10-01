/**
 * PostHog Cloud client — READ ONLY.
 *
 * There is no write path in this module, by design: the brand's analytics are
 * read, never edited. Every read goes through PostHog's query API
 * (`POST /api/projects/{id}/query/` with a HogQL SELECT) — a POST, but a pure
 * read: it needs only the `query:read` scope of a personal API key and changes
 * nothing in the project. Do not add a write.
 *
 * Only IDENTIFIED people are read: a person PostHog knows an email for
 * (`properties.email`). Anonymous visitors are out of scope and are filtered
 * inside PostHog's own query, so they never reach this service.
 *
 * Pagination is keyset, never OFFSET: PostHog refuses OFFSET on queries made
 * with a personal API key (measured 2026-10-01: 400 "OFFSET is not supported on
 * queries made with a personal API key").
 */

export const POSTHOG_REGIONS = ["us", "eu"] as const;
export type PosthogRegion = (typeof POSTHOG_REGIONS)[number];

/** The host is derived from the region, never taken from a caller. */
export const POSTHOG_HOSTS: Record<PosthogRegion, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

const REQUEST_TIMEOUT_MS = Number(process.env.POSTHOG_TIMEOUT_MS) || 60_000;
export const POSTHOG_PAGE_SIZE = Number(process.env.POSTHOG_PAGE_SIZE) || 5000;
/** Hard ceiling on pages drained per kind in one pass — the cron re-runs. */
export const POSTHOG_MAX_PAGES = Number(process.env.POSTHOG_MAX_PAGES) || 40;

/** A non-2xx answer from PostHog, carrying PostHog's own status and words. */
export class PosthogError extends Error {
  readonly status: number;
  readonly vendorMessage: string;
  constructor(status: number, vendorMessage: string) {
    super(`PostHog query returned ${status}: ${vendorMessage}`);
    this.name = "PosthogError";
    this.status = status;
    this.vendorMessage = vendorMessage;
  }
}

/** PostHog reports errors as `{ type, code, detail }`. */
function readVendorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown; error?: unknown };
    const raw = parsed.detail ?? parsed.message ?? parsed.error;
    if (typeof raw === "string" && raw.trim()) return raw;
  } catch {
    // Not JSON — the raw body is still PostHog's own words.
  }
  return body.trim() || "(no message)";
}

export interface PosthogTarget {
  region: PosthogRegion;
  projectId: string;
  apiKey: string;
}

/** Run one HogQL SELECT; rows come back as objects keyed on the column names. */
export async function hogql(target: PosthogTarget, query: string): Promise<Record<string, unknown>[]> {
  const url = `${POSTHOG_HOSTS[target.region]}/api/projects/${encodeURIComponent(target.projectId)}/query/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new PosthogError(res.status, readVendorMessage(text));
    const body = JSON.parse(text) as { columns?: string[]; results?: unknown[][] };
    if (!Array.isArray(body.columns) || !Array.isArray(body.results)) {
      throw new Error(`[crm-service][posthog] query answered without columns/results: ${text.slice(0, 200)}`);
    }
    const columns = body.columns;
    return body.results.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][posthog] query aborted after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A HogQL string literal. */
export const lit = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** A HogQL DateTime literal from a JS Date (UTC, millisecond precision). */
export const ts = (d: Date) => `toDateTime64(${lit(d.toISOString().replace("T", " ").replace("Z", ""))}, 3, 'UTC')`;

const IDENTIFIED_PERSON = "notEmpty(toString(person.properties.email))";

/**
 * Prove the key reads THIS project with the scope the sync needs, in one call:
 * the count of identified persons (it is also PostHog's own count, served back
 * for reconciliation). A key without `query:read`, a wrong project or a wrong
 * region is refused by PostHog itself, in its own words.
 */
export async function countIdentifiedPersons(target: PosthogTarget): Promise<number> {
  const rows = await hogql(target, "SELECT count() AS n FROM persons WHERE notEmpty(toString(properties.email))");
  return Number(rows[0]?.n ?? 0);
}

async function* keysetPages(
  target: PosthogTarget,
  build: (after: Record<string, unknown> | null) => string,
): AsyncGenerator<Record<string, unknown>[]> {
  let after: Record<string, unknown> | null = null;
  for (let page = 0; page < POSTHOG_MAX_PAGES; page++) {
    const rows = await hogql(target, build(after));
    if (rows.length > 0) yield rows;
    if (rows.length < POSTHOG_PAGE_SIZE) return;
    after = rows[rows.length - 1];
  }
}

/** Every identified person: id, email, name fields, creation date. */
export function listIdentifiedPersons(target: PosthogTarget) {
  return keysetPages(
    target,
    (after) => `
      SELECT toString(id) AS id, toString(properties.email) AS email,
             toString(properties.name) AS name, toString(properties.first_name) AS first_name,
             toString(properties.last_name) AS last_name, created_at
      FROM persons
      WHERE notEmpty(toString(properties.email))
        ${after ? `AND toString(id) > ${lit(String(after.id))}` : ""}
      ORDER BY id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
}

/**
 * Visits (sessions with at least one pageview) of identified people that were
 * ACTIVE since `since`. A session is aggregated over ALL its pageviews, not only
 * those inside the window, so a session straddling the window boundary is never
 * mirrored half-read (PostHog caps a session at 24 h, hence the 1-day lookback).
 */
export function listVisits(target: PosthogTarget, since: Date) {
  return keysetPages(
    target,
    (after) => `
      SELECT toString($session_id) AS session_id, toString(person_id) AS person_id,
             min(timestamp) AS started_at, max(timestamp) AS ended_at,
             argMin(toString(properties.$current_url), timestamp) AS entry_url,
             argMin(toString(properties.$pathname), timestamp) AS entry_path,
             count() AS pageviews,
             groupUniqArray(20)(toString(properties.$pathname)) AS paths,
             argMin(toString(properties.$referrer), timestamp) AS referrer
      FROM events
      WHERE event = '$pageview' AND ${IDENTIFIED_PERSON} AND notEmpty(toString($session_id))
        AND timestamp >= ${ts(since)} - INTERVAL 1 DAY
        AND $session_id IN (SELECT $session_id FROM events WHERE event = '$pageview' AND timestamp >= ${ts(since)})
      GROUP BY session_id, person_id
      ${after ? `HAVING (started_at, session_id, person_id) > (${ts(new Date(String(after.started_at)))}, ${lit(String(after.session_id))}, ${lit(String(after.person_id))})` : ""}
      ORDER BY started_at, session_id, person_id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
}

/**
 * Key events of identified people since `since`: every CUSTOM event (one the
 * brand named itself). PostHog's own `$`-prefixed events (pageview, autocapture,
 * pageleave…) are not key events; pageviews arrive as visits.
 */
export function listKeyEvents(target: PosthogTarget, since: Date) {
  return keysetPages(
    target,
    (after) => `
      SELECT toString(uuid) AS id, event, timestamp, toString(person_id) AS person_id,
             toString(properties.$current_url) AS url, toString(properties.$pathname) AS path,
             toString($session_id) AS session_id
      FROM events
      WHERE event NOT LIKE '$%' AND ${IDENTIFIED_PERSON} AND timestamp >= ${ts(since)}
        ${after ? `AND (timestamp, toString(uuid)) > (${ts(new Date(String(after.timestamp)))}, ${lit(String(after.id))})` : ""}
      ORDER BY timestamp, id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
}
