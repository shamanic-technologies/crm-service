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
 * never sets `is_identified`). Anonymous visitors are out of scope and are
 * filtered inside PostHog's own query, so they never reach this service.
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

/** Which persons an activity read covers: the identified ones, or an explicit id list. */
export type PersonScope = { kind: "identified" } | { kind: "ids"; ids: string[] };

const personScopeSql = (scope: PersonScope) =>
  scope.kind === "identified"
    ? `person.id IN (SELECT id FROM persons WHERE ${IDENTIFIED})`
    : `toString(person.id) IN (${scope.ids.map(lit).join(", ")})`;

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

const PERSON_COLUMNS = `
  toString(p.id) AS id, toString(p.properties.email) AS email,
  toString(p.properties.name) AS name, toString(p.properties.first_name) AS first_name,
  toString(p.properties.last_name) AS last_name, p.created_at AS created_at,
  ${[...PHONE_PROPERTY_KEYS, ...WEBSITE_PROPERTY_KEYS].map((k) => `toString(p.properties.${k}) AS prop_${k}`).join(", ")},
  p.is_identified AS is_identified, d.ids AS distinct_ids`;

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
 * The NOT-identified persons carrying one of these distinct ids (the brand's
 * auth user ids). Call with at most a few hundred ids at a time.
 */
export async function listPersonsByDistinctIds(target: PosthogTarget, distinctIds: string[]) {
  if (distinctIds.length === 0) return [];
  const match = `id IN (SELECT person_id FROM person_distinct_ids WHERE distinct_id IN (${distinctIds.map(lit).join(", ")}))`;
  return hogql(
    target,
    `
      SELECT ${PERSON_COLUMNS}
      FROM persons AS p ${distinctIdsOf(match)}
      WHERE NOT ${IS_IDENTIFIED("p.")}
        AND p.${match}
      ORDER BY id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
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
export async function listPersonIdsTouchedSince(target: PosthogTarget, since: Date): Promise<string[]> {
  const setsKnown = KNOWN_PROPERTY_KEYS.flatMap((k) =>
    ["$set", "$set_once"].map((op) => `ifNull(toString(properties.${op}.${k}), '') != ''`),
  ).join(" OR ");
  const rows = await hogql(
    target,
    `
      SELECT DISTINCT toString(person_id) AS id
      FROM events
      WHERE timestamp >= ${ts(since)}
        AND ((${setsKnown}) OR (event NOT LIKE '$%' AND person.id IN (SELECT id FROM persons WHERE ${IDENTIFIED})))
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
  return rows.map((r) => String(r.id)).filter((id) => !!id);
}

/** These persons (PostHog ids) when they are known (`IDENTIFIED`), with the same columns as every person read. */
export async function listPersonsByIds(target: PosthogTarget, ids: string[]) {
  if (ids.length === 0) return [];
  const match = `toString(id) IN (${ids.map(lit).join(", ")})`;
  return hogql(
    target,
    `
      SELECT ${PERSON_COLUMNS}
      FROM persons AS p ${distinctIdsOf(match)}
      WHERE toString(p.id) IN (${ids.map(lit).join(", ")}) AND ${IS_IDENTIFIED("p.")}
      ORDER BY id
      LIMIT ${POSTHOG_PAGE_SIZE}`,
  );
}
