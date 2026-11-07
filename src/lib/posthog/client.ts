/**
 * PostHog Cloud client — READ ONLY.
 *
 * There is no write path in this module, by design: the brand's analytics are
 * read, never edited. Every read goes through PostHog's query API
 * (`POST /api/projects/{id}/query/` with a HogQL SELECT) — a POST, but a pure
 * read: it needs only the `query:read` scope of a personal API key and changes
 * nothing in the project. Do not add a write.
 *
 * Only IDENTIFIED people are read: a person PostHog was told who they are —
 * `is_identified` (the brand called `identify`) or an email it holds — plus a
 * person carrying, as a distinct id, the user id of one of the brand's
 * connected auth providers (a server-side capture keyed on the Clerk user id
 * never sets `is_identified`). Anonymous visitors are out of scope: a window read
 * returns every row (cheaper than any persons filter, see PersonScope) and the
 * caller keeps only the persons it holds; an anonymous row is never stored.
 *
 * A person carrying a PHONE property counts too (WA-GIVEN-TRIGGER-1015): a
 * visitor who typed their WhatsApp number before any account exists is known by
 * that number alone (distribute.you's /get-started sets `phone` on the person).
 *
 * So does a person carrying a NAME or the WEBSITE they typed (ONBOARDING-IN-UNIBOX-1015,
 * owner 2026-10-15): a visitor walking a product's signup steps is a person of the
 * brand from the first page where they say who they are, account or not. A person
 * PostHog knows by none of these (email, phone, name, website, identify) stays an
 * anonymous visit and never reaches this service.
 *
 * Why not "has an email" alone (the rule until 2026-10-11): measured on
 * distribute.you's own project, 151 persons, 136 carrying a Clerk user id, only
 * 56 with an email property — 80 signed-up users were never mirrored.
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

/**
 * POSTHOG-429-1107: PostHog refused the read because the PROJECT's hourly budget of data read by API queries is used
 * up (429 `api_queries_budget_exceeded`, or the request rate limit). A temporary state, never a broken connection:
 * `retryAt` is when PostHog says the budget is back (its `Retry-After` header, else "Expected available in N seconds",
 * else one minute). Until then no read of this project leaves this process (`hogql` refuses before any fetch).
 */
export class PosthogThrottled extends PosthogError {
  readonly retryAt: Date;
  constructor(vendorMessage: string, retryAt: Date) {
    super(429, vendorMessage);
    this.name = "PosthogThrottled";
    this.retryAt = retryAt;
  }
}

/** PURE: when PostHog says the budget is back, from its `Retry-After` header or its own words; one minute when it says nothing. */
export function retryAtOf(retryAfterHeader: string | null, vendorMessage: string, now: number): Date {
  const header = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(header) && header >= 0) return new Date(now + header * 1000);
  const said = /available in (\d+) seconds?/i.exec(vendorMessage);
  if (said) return new Date(now + Number(said[1]) * 1000);
  return new Date(now + 60_000);
}

/** In-process gate per project: until when no read may be sent (a 429 seen by the full pass also stops the fast mirror). */
const gates = new Map<string, number>();
/** Every read's cost as PostHog reported it (`X-PostHog-Query-Bytes-Read`), per project, for the last hour. */
const spent = new Map<string, { at: number; bytes: number }[]>();
const projectKey = (t: Pick<PosthogTarget, "region" | "projectId">) => `${t.region}:${t.projectId}`;
const HOUR_MS = 60 * 60 * 1000;

/** Until when PostHog refuses reads of this project (null = reads allowed). */
export function throttledUntil(target: Pick<PosthogTarget, "region" | "projectId">, now = Date.now()): Date | null {
  const until = gates.get(projectKey(target));
  return until && until > now ? new Date(until) : null;
}

/** Hold every read of this project until `until` (a stored throttle read back at the start of a pass). */
export function holdReads(target: Pick<PosthogTarget, "region" | "projectId">, until: Date): void {
  const key = projectKey(target);
  gates.set(key, Math.max(gates.get(key) ?? 0, until.getTime()));
}

/** Bytes our reads of this project made PostHog scan over the last hour. */
export function bytesReadLastHour(target: Pick<PosthogTarget, "region" | "projectId">, now = Date.now()): number {
  const list = (spent.get(projectKey(target)) ?? []).filter((r) => r.at > now - HOUR_MS);
  spent.set(projectKey(target), list);
  return list.reduce((a, r) => a + r.bytes, 0);
}

/** Tests only: forget every gate and every recorded read. */
export function resetPosthogBudgetState(): void {
  gates.clear();
  spent.clear();
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
  const until = throttledUntil(target);
  if (until) throw new PosthogThrottled(`waiting for PostHog's read budget until ${until.toISOString()}`, until);
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
    const bytesRead = Number(res.headers.get("x-posthog-query-bytes-read"));
    if (Number.isFinite(bytesRead) && bytesRead > 0) {
      const key = projectKey(target);
      spent.set(key, [...(spent.get(key) ?? []), { at: Date.now(), bytes: bytesRead }]);
    }
    if (res.status === 429) {
      const message = readVendorMessage(text);
      const retryAt = retryAtOf(res.headers.get("retry-after"), message, Date.now());
      holdReads(target, retryAt);
      throw new PosthogThrottled(message, retryAt);
    }
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

/** A person PostHog was told who they are, on the `persons` table. */
// ⚠️ A missing email property is NULL and `notEmpty(toString(NULL))` is NULL, so
// `NOT (is_identified OR notEmpty(...))` silently drops every such person:
// both halves are made strictly boolean.
const HAS_EMAIL = (alias: string) => `ifNull(toString(${alias}properties.email), '') != ''`;
/** The person properties a product names a phone by (the same keys the Clerk adapter reads in metadata). */
export const PHONE_PROPERTY_KEYS = ["phone", "phone_number", "phoneNumber"] as const;
const HAS_PHONE = (alias: string) =>
  `(${PHONE_PROPERTY_KEYS.map((k) => `ifNull(toString(${alias}properties.${k}), '') != ''`).join(" OR ")})`;
/** The person properties a product names a person by (a name) or their website by. */
export const NAME_PROPERTY_KEYS = ["name", "first_name", "last_name"] as const;
export const WEBSITE_PROPERTY_KEYS = ["website"] as const;
const HAS_ANY = (alias: string, keys: readonly string[]) =>
  `(${keys.map((k) => `ifNull(toString(${alias}properties.${k}), '') != ''`).join(" OR ")})`;
const IS_IDENTIFIED = (alias: string) =>
  `(ifNull(${alias}is_identified, 0) = 1 OR ${HAS_EMAIL(alias)} OR ${HAS_PHONE(alias)}` +
  ` OR ${HAS_ANY(alias, NAME_PROPERTY_KEYS)} OR ${HAS_ANY(alias, WEBSITE_PROPERTY_KEYS)})`;
/** Every person property that makes a person known: setting one is what the fast mirror watches. */
export const KNOWN_PROPERTY_KEYS = ["email", ...PHONE_PROPERTY_KEYS, ...NAME_PROPERTY_KEYS, ...WEBSITE_PROPERTY_KEYS] as const;
export const IDENTIFIED = IS_IDENTIFIED("");

/**
 * Which rows an activity read covers (POSTHOG-429-1107, measured on project 171095 with PostHog's own
 * `X-PostHog-Query-Bytes-Read`): a persons sub-query (`person.id IN (SELECT id FROM persons WHERE ...)`) re-scans the
 * whole persons table with every property on EVERY read: 1.8 GB for one 15-min visit window, 2-3 GB for the
 * every-minute fast mirror, 7.6 GB for one person's history. So no read filters on the persons table any more:
 *  - `window`: every row of the window, no person filter (2 days of visits = 24 MB); the caller keeps only the rows
 *    of persons it holds and drops the rest in memory (an anonymous visitor is never stored).
 *  - `distinctIds`: the rows of these distinct ids. The events table is sorted by (day, event, distinct id hash), so
 *    this prunes to the granules holding them (7 people over 30 days of pageviews = 21 MB).
 */
export type PersonScope = { kind: "window" } | { kind: "distinctIds"; ids: string[] };

const personScopeSql = (scope: PersonScope) =>
  scope.kind === "window" ? "1 = 1" : `distinct_id IN (${scope.ids.map(lit).join(", ")})`;

/** PURE: a person row read without the IDENTIFIED filter is KNOWN (the same rule as `IDENTIFIED`, applied in code). */
export function isKnownPerson(row: Record<string, unknown>): boolean {
  const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
  if (Number(row.is_identified) === 1 || row.is_identified === true) return true;
  return (
    filled(row.email) ||
    NAME_PROPERTY_KEYS.some((k) => filled(row[k])) ||
    [...PHONE_PROPERTY_KEYS, ...WEBSITE_PROPERTY_KEYS].some((k) => filled(row[`prop_${k}`]))
  );
}

/**
 * Prove the key reads THIS project with the scope the sync needs, in one call:
 * the count of identified persons (`IDENTIFIED`) (it is also PostHog's own count, served back
 * for reconciliation). A key without `query:read`, a wrong project or a wrong
 * region is refused by PostHog itself, in its own words.
 */
export async function countIdentifiedPersons(target: PosthogTarget): Promise<number> {
  const rows = await hogql(target, `SELECT count() AS n FROM persons WHERE ${IDENTIFIED}`);
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

const PERSON_BASE_COLUMNS = `
  toString(p.id) AS id, toString(p.properties.email) AS email,
  toString(p.properties.name) AS name, toString(p.properties.first_name) AS first_name,
  toString(p.properties.last_name) AS last_name, p.created_at AS created_at,
  ${[...PHONE_PROPERTY_KEYS, ...WEBSITE_PROPERTY_KEYS].map((k) => `toString(p.properties.${k}) AS prop_${k}`).join(", ")},
  p.is_identified AS is_identified`;
const PERSON_COLUMNS = `${PERSON_BASE_COLUMNS}, d.ids AS distinct_ids`;

/** Up to 50 distinct ids per person: the ids another tool of the brand may name them by. */
const distinctIdsOf = (personFilter: string) => `
  LEFT JOIN (
    SELECT person_id, groupArray(50)(distinct_id) AS ids FROM person_distinct_ids
    WHERE person_id IN (SELECT id FROM persons WHERE ${personFilter})
    GROUP BY person_id
  ) AS d ON d.person_id = p.id`;

/** Every identified person: id, email, name fields, creation date, distinct ids. */
export function listIdentifiedPersons(target: PosthogTarget) {
  return keysetPages(
    target,
    (after) => `
      SELECT ${PERSON_COLUMNS}
      FROM persons AS p ${distinctIdsOf(IDENTIFIED)}
      WHERE ${IS_IDENTIFIED("p.")}
        ${after ? `AND toString(p.id) > ${lit(String(after.id))}` : ""}
      ORDER BY id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
}

/**
 * The NOT-identified persons carrying one of these distinct ids (the brand's auth user ids). Two cheap reads: the
 * distinct id -> person map (person_distinct_ids, ~1 MB), then those persons by id. Call with at most a few hundred ids.
 */
export async function listPersonsByDistinctIds(target: PosthogTarget, distinctIds: string[]) {
  if (distinctIds.length === 0) return [];
  const rows = await hogql(
    target,
    `SELECT DISTINCT toString(person_id) AS person_id FROM person_distinct_ids WHERE distinct_id IN (${distinctIds.map(lit).join(", ")}) LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
  const persons = await readPersonsByIds(target, rows.map((r) => String(r.person_id)).filter(Boolean));
  return persons.filter((p) => !isKnownPerson(p));
}

/** Up to `max` distinct ids of each of these persons (by person id): ~1.5 MB, the table is small. */
export async function distinctIdsOfPersons(target: PosthogTarget, personIds: string[], max = 50): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (personIds.length === 0) return out;
  const rows = await hogql(
    target,
    `SELECT toString(person_id) AS person_id, groupArray(${max})(distinct_id) AS ids FROM person_distinct_ids
     WHERE toString(person_id) IN (${personIds.map(lit).join(", ")}) GROUP BY person_id LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
  for (const r of rows) out.set(String(r.person_id), Array.isArray(r.ids) ? r.ids.map(String) : []);
  return out;
}

/**
 * These persons by id, known or not, each with `distinct_ids`, the SAME columns as every person read. The persons
 * table is keyed on the id, so this reads only their rows (3 persons = 16.5 MB); the distinct ids come from their own
 * small read (the old `person_id IN (SELECT id FROM persons WHERE ...)` join re-scanned persons: 76 MB).
 */
async function readPersonsByIds(target: PosthogTarget, ids: string[]): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const persons = await hogql(
    target,
    `
      SELECT ${PERSON_BASE_COLUMNS}
      FROM persons AS p
      WHERE toString(p.id) IN (${ids.map(lit).join(", ")})
      ORDER BY id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
  const distinct = await distinctIdsOfPersons(target, persons.map((p) => String(p.id)));
  return persons.map((p) => ({ ...p, distinct_ids: distinct.get(String(p.id)) ?? null }));
}

/**
 * POSTHOG-SCANNER-VISIT-1025: the POSITIVE fingerprint of an automated browser on a visit. A desktop browser
 * a person drives shows its page in a window: the viewport is smaller than the screen (tabs, address bar).
 * A headless browser (an email security scanner opening every newsletter link, our own Playwright probes)
 * renders with the viewport EQUAL to the screen in both dimensions. Measured on project 171095 (7 days):
 * newsletter-link pageviews 7,423 equal vs 47 not; signed-in dashboard pageviews 0 equal vs 1,247 not; over
 * 30 days the only signed-in desktop sessions matching were our own test accounts and probes.
 * `viewport_is_screen` = 1 only when EVERY pageview of the session is a desktop one matching it; a pageview
 * missing either size, or a phone / tablet (in-app browsers fill the screen), reads 0: unknown = a person.
 * `headless_default_screen` (ROBOTS-NEVER-LEAVE-BRONZE-1028) = 1 only when EVERY pageview is a desktop one on an
 * 800x600 SCREEN: the headless default (Puppeteer / Chromium's own), no desktop a person browses on today. Measured
 * 2026-10-28: 29 of the 44 newsletter-link visits the first fingerprint let through were single-pageview 0-second
 * sessions on it. A phone / tablet of that size, or a pageview missing a size, reads 0: unknown = a person.
 * ROBOTS-NEVER-LEAVE-BRONZE-1028 part 2 (measured 2026-10-28, 30-90 days, project 171095):
 * `desktop_1280_on_1080p` = EVERY pageview a desktop one on a 1920x1080 screen with a viewport exactly 1280 wide:
 * 1,627 sessions, 0 of a person PostHog knows an email for (20 on newsletter links, 0 on the signed-in dashboard).
 * `headless_screen_wider_viewport` = EVERY pageview on an 800x600 screen (the headless default, any device type) with
 * a viewport WIDER than it: 0 sessions with an email over 90 days. A viewport wider than the screen in general is NOT
 * a machine: browser zoom below 100% does it (a client's admin at 80%: 1920 screen, 2400 viewport, 33 pageviews).
 * `screen` = the size it matched, for the record.
 */
export const MACHINE_VIEWPORT_SQL = `
             min(ifNull(
               toString(properties.$device_type) = 'Desktop'
               AND toFloat(properties.$screen_width) > 0 AND toFloat(properties.$screen_height) > 0
               AND toFloat(properties.$viewport_width) = toFloat(properties.$screen_width)
               AND toFloat(properties.$viewport_height) = toFloat(properties.$screen_height), 0)) AS viewport_is_screen,
             min(ifNull(
               toString(properties.$device_type) = 'Desktop'
               AND toFloat(properties.$screen_width) = 800 AND toFloat(properties.$screen_height) = 600, 0)) AS headless_default_screen,
             min(ifNull(
               toString(properties.$device_type) = 'Desktop'
               AND toFloat(properties.$screen_width) = 1920 AND toFloat(properties.$screen_height) = 1080
               AND toFloat(properties.$viewport_width) = 1280, 0)) AS desktop_1280_on_1080p,
             min(ifNull(
               toFloat(properties.$screen_width) = 800 AND toFloat(properties.$screen_height) = 600
               AND toFloat(properties.$viewport_width) > 800, 0)) AS headless_screen_wider_viewport,
             any(concat(toString(properties.$screen_width), 'x', toString(properties.$screen_height))) AS screen`;

/**
 * Visits (sessions with at least one pageview) of identified people that were
 * ACTIVE since `since`. A session is aggregated over ALL its pageviews, not only
 * those inside the window, so a session straddling the window boundary is never
 * mirrored half-read (PostHog caps a session at 24 h, hence the 1-day lookback).
 */
export function listVisits(target: PosthogTarget, since: Date, scope: PersonScope) {
  return keysetPages(
    target,
    (after) => `
      SELECT toString($session_id) AS session_id, toString(person_id) AS person_id,
             min(timestamp) AS started_at, max(timestamp) AS ended_at,
             argMin(toString(properties.$current_url), timestamp) AS entry_url,
             argMin(toString(properties.$pathname), timestamp) AS entry_path,
             count() AS pageviews,
             groupUniqArray(20)(toString(properties.$pathname)) AS paths,
             argMin(toString(properties.$referrer), timestamp) AS referrer,
             ${MACHINE_VIEWPORT_SQL}
      FROM events
      WHERE event = '$pageview' AND ${personScopeSql(scope)} AND notEmpty(toString($session_id))
        AND timestamp >= ${ts(since)} - INTERVAL 1 DAY
        AND $session_id IN (SELECT $session_id FROM events WHERE event = '$pageview' AND timestamp >= ${ts(since)})
      GROUP BY session_id, person_id
      ${after ? `HAVING (started_at, session_id, person_id) > (${ts(new Date(String(after.started_at)))}, ${lit(String(after.session_id))}, ${lit(String(after.person_id))})` : ""}
      ORDER BY started_at, session_id, person_id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
}

/** At most this many of an event's own properties are kept, each string cut at `EVENT_PROPERTY_MAX_CHARS`. */
export const EVENT_PROPERTY_MAX_KEYS = 50;
export const EVENT_PROPERTY_MAX_CHARS = 1000;

/**
 * PURE: the properties the BRAND put on an event (what the visitor typed, the step):
 * every key PostHog's own SDK did not add (`$`-prefixed: `$current_url`, `$set`,
 * `$browser`...), in their order, strings cut at `EVENT_PROPERTY_MAX_CHARS`.
 * HogQL serves `properties` as a JSON string.
 */
export function ownEventProperties(raw: unknown): Record<string, unknown> {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const cut = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > EVENT_PROPERTY_MAX_CHARS ? `${v.slice(0, EVENT_PROPERTY_MAX_CHARS)}…` : v;
    if (v && typeof v === "object") {
      const text = JSON.stringify(v);
      return text.length > EVENT_PROPERTY_MAX_CHARS ? `${text.slice(0, EVENT_PROPERTY_MAX_CHARS)}…` : v;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k.startsWith("$") || k.startsWith("__")) continue;
    if (Object.keys(out).length >= EVENT_PROPERTY_MAX_KEYS) break;
    out[k] = cut(v);
  }
  return out;
}

/**
 * Key events of identified people since `since`: every CUSTOM event (one the
 * brand named itself). PostHog's own `$`-prefixed events (pageview, autocapture,
 * pageleave…) are not key events; pageviews arrive as visits. Each carries the
 * brand's own properties (`ownEventProperties`), what the visitor entered on that
 * step (ONBOARDING-IN-UNIBOX-1015); PostHog's `$` properties never leave PostHog.
 */
export async function* listKeyEvents(target: PosthogTarget, since: Date, scope: PersonScope): AsyncGenerator<Record<string, unknown>[]> {
  for await (const page of keysetPages(
    target,
    (after) => `
      SELECT toString(uuid) AS id, event, timestamp, toString(person_id) AS person_id,
             toString(properties.$current_url) AS url, toString(properties.$pathname) AS path,
             toString($session_id) AS session_id, properties AS properties
      FROM events
      WHERE event NOT LIKE '$%' AND ${personScopeSql(scope)} AND timestamp >= ${ts(since)}
        ${after ? `AND (timestamp, toString(uuid)) > (${ts(new Date(String(after.timestamp)))}, ${lit(String(after.id))})` : ""}
      ORDER BY timestamp, id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  )) {
    yield page.map((r) => ({ ...r, properties: ownEventProperties(r.properties) }));
  }
}

/**
 * The persons the brand learned something about since `since`, for the fast mirror
 * (WA-GIVEN-TRIGGER-1015, ONBOARDING-IN-UNIBOX-1015): any event that SET a property
 * making a person known (`$set` / `$set_once` of an email, phone, name or website:
 * `identify`, `setPersonProperties`, a capture carrying `$set`), plus every custom
 * event of a person already known. A cheap read on the events table, asked every
 * minute, so a number or a website typed on a form, and each step after it, reach
 * us within a minute. Returns PostHog person ids.
 */
/**
 * The events that can make a person known or change who they are: PostHog's own person-setting events (`identify`,
 * `setPersonProperties`, alias, merge) and every custom event (a product's form step carries its `$set`).
 */
export const PERSON_SETTING_EVENTS = ["$identify", "$set", "$create_alias", "$merge_dangerously"] as const;

export async function listPersonIdsTouchedSince(target: PosthogTarget, since: Date): Promise<string[]> {
  // POSTHOG-429-1107: chosen by event NAME, never by reading `properties.$set` nor the persons table: 2.8 MB a call
  // (it was 2-3 GB, every minute, and alone spent the project's hourly read budget). Who is KNOWN is decided on the
  // person read that follows (`isKnownPerson`). Anonymous person ids read here are dropped, never stored.
  const rows = await hogql(
    target,
    `
      SELECT DISTINCT toString(person_id) AS id
      FROM events
      WHERE timestamp >= ${ts(since)}
        AND (event NOT LIKE '$%' OR event IN (${PERSON_SETTING_EVENTS.map(lit).join(", ")}))
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
  return rows.map((r) => String(r.id)).filter((id) => !!id);
}

/**
 * These persons (PostHog ids) when they are known (`isKnownPerson`) or carry one of `authUserIds` as a distinct id,
 * with the same columns as every person read.
 */
export async function listPersonsByIds(target: PosthogTarget, ids: string[], authUserIds: ReadonlySet<string> = new Set()) {
  const persons = await readPersonsByIds(target, ids);
  return persons.filter(
    (p) => isKnownPerson(p) || (Array.isArray(p.distinct_ids) && p.distinct_ids.some((d) => authUserIds.has(String(d)))),
  );
}
