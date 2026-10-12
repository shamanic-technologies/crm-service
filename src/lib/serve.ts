import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { AUTH_PROVIDER_NAMES } from "./auth/providers.js";
import { PERSON_REPLIED_SQL } from "./people/conversation.js";
import { STAFF_DOMAIN, STAFF_EMAIL_LIST } from "./owner-telegram.js";
import { perStageSegments, personOptedOut, readSegmentCatalogue, segmentClauses, type PoolClause, type Segment, type SegmentCatalogue } from "./people/segment.js";

/**
 * SERVE — hand out the next batch of not-yet-served sendable contacts for a
 * brand, and atomically mark them served so no concurrent or subsequent call
 * ever returns them again.
 *
 * crm-service OWNS the served-tracking because it performs the terminal serve
 * action (identity-keying rule: the service that emits owns "don't re-emit").
 * Suppression is permanent and keyed on the atomic member — the individual
 * contact, identified by its durable `lower(primary_email)` (see the
 * `contact_serves` note in schema.ts for why not the volatile silver uuid).
 *
 * PER-FILE RESTRICTION (`uploadIds`)
 * A serve can optionally be restricted to one or several of the brand's
 * imported CRM files (`contact_uploads` rows), so the product can toggle a file
 * ON/OFF and have outreach draw only from the enabled ones. The restriction is
 * applied at SERVE time on the silver `source_upload_id` attribution — the same
 * file identity the uploads list and the admin per-file view already use. It
 * narrows the CANDIDATE pool only:
 *
 *  - suppression stays BRAND-WIDE. `contact_serves` is keyed on
 *    (brand_id, email) with NO upload dimension, so a contact served through
 *    file A can never be re-served through file B. Restricting can only ever
 *    return FEWER contacts, never a repeat.
 *  - omitting `uploadIds` is the pre-existing whole-brand behaviour, unchanged.
 *
 * Silver dedups on (org, brand, lower(email)), so a person appearing in two
 * files is ONE silver row attributed to the file that promoted last — exactly
 * what `GET /orgs/contacts/uploads` + the admin per-file contact view show. So
 * per-file pools partition the brand's sendable contacts: every contact belongs
 * to exactly one file, and the per-file counts sum to the brand total.
 */

/** A served silver contact — same shape the list endpoint returns. */
export interface ServedContact {
  id: string;
  orgId: string;
  brandId: string;
  primaryEmail: string | null;
  phoneE164: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  rawAttributes: Record<string, string>;
  consentStatus: string;
  unsubscribed: boolean;
  sourceUploadId: string;
  sourceRowId: string;
  lastRebuiltAt: string;
}

export interface ServeNextResult {
  contacts: ServedContact[];
  /** How many contacts this call served (0 when the brand is drained). */
  served: number;
  /**
   * True when there are ZERO remaining un-served sendable contacts for the
   * brand after this serve — a truthful "done/exhausted" signal, computed from
   * live state, never fabricated.
   */
  exhausted: boolean;
}

interface RawContactRow {
  id: string;
  org_id: string;
  brand_id: string;
  primary_email: string | null;
  phone_e164: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  raw_attributes: Record<string, string> | null;
  consent_status: string;
  unsubscribed: boolean;
  source_upload_id: string;
  source_row_id: string;
  last_rebuilt_at: string | Date;
}

function toServedContact(r: RawContactRow): ServedContact {
  return {
    id: r.id,
    orgId: r.org_id,
    brandId: r.brand_id,
    primaryEmail: r.primary_email,
    phoneE164: r.phone_e164,
    fullName: r.full_name,
    firstName: r.first_name,
    lastName: r.last_name,
    rawAttributes: r.raw_attributes ?? {},
    consentStatus: r.consent_status,
    unsubscribed: r.unsubscribed,
    sourceUploadId: r.source_upload_id,
    sourceRowId: r.source_row_id,
    lastRebuiltAt:
      r.last_rebuilt_at instanceof Date ? r.last_rebuilt_at.toISOString() : r.last_rebuilt_at,
  };
}

/**
 * SQL fragment restricting the candidate pool to a set of imported files.
 * Empty (no-op) when no restriction is asked for — the whole-brand path emits
 * exactly the pre-existing query.
 *
 * One bound parameter per id (not an array literal) so the fragment is safe and
 * driver-agnostic; the route caps the list length.
 */
function uploadFilter(uploadIds?: string[]) {
  if (!uploadIds || uploadIds.length === 0) return sql.empty();
  return sql` AND c.source_upload_id IN (${sql.join(
    uploadIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/**
 * REACHABILITY — a serve made FOR a pipe names the channel(s) it writes on
 * (`reachableBy`): `phone` (WhatsApp, calls, SMS) or `email`. A person the
 * pipe cannot reach is SKIPPED, never marked served, so it stays available to
 * the pipe that can (owner 2026-10-12: a WhatsApp serve must not burn the
 * email-only signups the email pipe will write to). Same rule on both pools and
 * every channel. Several values = all required. Empty = no requirement (the
 * pre-existing behaviour, byte for byte).
 */
export const REACH_CHANNELS = ["phone", "email"] as const;
export type Reach = (typeof REACH_CHANNELS)[number];

/** CSV pool (alias `c` on `sendable_contacts`): the view already requires a valid email. */
function csvReachFilter(reach: readonly Reach[] = []) {
  return reach.includes("phone") ? sql` AND c.phone_e164 IS NOT NULL` : sql.empty();
}

/** `?reachableBy=phone,email` or repeated → the list; values are zod-checked by the route. */
export function normalizeReachQuery(raw: unknown): string[] {
  return normalizeUploadIdsQuery(raw);
}

/**
 * Normalize the `uploadIds` query parameter into a list of raw strings.
 * Accepts a repeated param (`?uploadIds=a&uploadIds=b`) or a comma-separated
 * one (`?uploadIds=a,b`). Returns `[]` when absent — i.e. no restriction.
 * Values are NOT validated here; the route zod-checks them as uuids.
 */
export function normalizeUploadIdsQuery(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => String(p).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Select up to `limit` sendable, not-yet-served contacts for (org, brand) and
 * atomically mark them served in ONE statement:
 *
 *  - `candidate` reads the gold `sendable_contacts` view, anti-joined against
 *    `contact_serves` (durable email key), ordered oldest-first, `LIMIT`,
 *    `FOR UPDATE SKIP LOCKED` — so two concurrent calls lock disjoint rows and
 *    never pick the same contact.
 *  - `ins` inserts the picked rows into `contact_serves`; `ON CONFLICT
 *    (brand_id, email) DO NOTHING` is the permanent-suppression guard AND a
 *    belt-and-suspenders against a racing serve of the same email.
 *  - the final SELECT returns ONLY rows THIS call actually inserted (won).
 *
 * Result: no double-serve across sequential OR concurrent calls.
 *
 * `uploadIds` (optional) narrows the candidate pool to those imported files.
 * It does NOT touch the anti-join, so brand-wide suppression is untouched.
 */
export async function serveNext(
  orgId: string,
  brandId: string,
  limit: number,
  runId: string,
  uploadIds?: string[],
  reach: readonly Reach[] = [],
): Promise<ServeNextResult> {
  const files = sql`${uploadFilter(uploadIds)}${csvReachFilter(reach)}`;
  const rows = (await db.execute(sql`
    WITH candidate AS (
      SELECT c.id, c.org_id, c.brand_id, c.primary_email, c.phone_e164,
             c.full_name, c.first_name, c.last_name, c.raw_attributes,
             c.consent_status, c.unsubscribed, c.source_upload_id,
             c.source_row_id, c.last_rebuilt_at
      FROM sendable_contacts c
      WHERE c.org_id = ${orgId}
        AND c.brand_id = ${brandId}${files}
        AND NOT EXISTS (
          SELECT 1 FROM contact_serves s
          WHERE s.brand_id = c.brand_id AND s.email = c.primary_email
        )
      ORDER BY c.last_rebuilt_at ASC, c.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    ins AS (
      INSERT INTO contact_serves (org_id, brand_id, contact_id, email, served_run_id)
      SELECT org_id, brand_id, id, primary_email, ${runId} FROM candidate
      ON CONFLICT (brand_id, email) DO NOTHING
      RETURNING email
    )
    SELECT candidate.* FROM candidate
    JOIN ins ON ins.email = candidate.primary_email
    ORDER BY candidate.last_rebuilt_at ASC, candidate.id ASC
  `)) as unknown as RawContactRow[];

  const contacts = rows.map(toServedContact);

  // Truthful exhaustion: count sendable contacts still not served AFTER this
  // serve. Zero → the pool is drained. Computed live, never fabricated. Under a
  // file restriction the pool IS the restricted one, so `exhausted` answers
  // "these files are drained" — the question the caller actually asked.
  const remaining = await countRemaining(orgId, brandId, uploadIds, reach);

  return { contacts, served: contacts.length, exhausted: remaining === 0 };
}

async function countRemaining(
  orgId: string,
  brandId: string,
  uploadIds?: string[],
  reach: readonly Reach[] = [],
): Promise<number> {
  const files = sql`${uploadFilter(uploadIds)}${csvReachFilter(reach)}`;
  const res = (await db.execute(sql`
    SELECT count(*)::int AS remaining
    FROM sendable_contacts c
    WHERE c.org_id = ${orgId}
      AND c.brand_id = ${brandId}${files}
      AND NOT EXISTS (
        SELECT 1 FROM contact_serves s
        WHERE s.brand_id = c.brand_id AND s.email = c.primary_email
      )
  `)) as unknown as { remaining: number }[];
  return res[0]?.remaining ?? 0;
}

export interface ServeStats {
  /** Distinct contacts already served for the brand (permanent suppression size). */
  served: number;
  /** Sendable contacts not yet served — the count serve-next can still hand out. */
  remainingSendable: number;
  /** All sendable contacts for the brand (served + remaining). */
  totalSendable: number;
}

/**
 * Served vs remaining counts. Whole-brand by default; scoped to one or several
 * imported files when `uploadIds` is given (the per-file progress read).
 *
 * The two scopes count `served` from different angles, on purpose:
 *  - whole-brand: every suppression row for the brand (the full permanent
 *    suppression size, including emails no longer present in silver).
 *  - per-file: sendable contacts OF THOSE FILES that are already served — the
 *    only definition that can be attributed to a file, and the one that keeps
 *    `served + remainingSendable == totalSendable` for the file.
 */
export async function serveStats(
  orgId: string,
  brandId: string,
  uploadIds?: string[],
  reach: readonly Reach[] = [],
): Promise<ServeStats> {
  if (uploadIds && uploadIds.length > 0) return serveStatsForFiles(orgId, brandId, uploadIds, reach);
  const reachSql = csvReachFilter(reach);

  const res = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM contact_serves s
         WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId})            AS served,
      (SELECT count(*)::int FROM sendable_contacts c
         WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}${reachSql})            AS total_sendable,
      (SELECT count(*)::int FROM sendable_contacts c
         WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}${reachSql}
           AND NOT EXISTS (
             SELECT 1 FROM contact_serves s
             WHERE s.brand_id = c.brand_id AND s.email = c.primary_email
           ))                                                              AS remaining_sendable
  `)) as unknown as { served: number; total_sendable: number; remaining_sendable: number }[];

  const row = res[0] ?? { served: 0, total_sendable: 0, remaining_sendable: 0 };
  return {
    served: row.served,
    remainingSendable: row.remaining_sendable,
    totalSendable: row.total_sendable,
  };
}

async function serveStatsForFiles(
  orgId: string,
  brandId: string,
  uploadIds: string[],
  reach: readonly Reach[] = [],
): Promise<ServeStats> {
  const files = sql`${uploadFilter(uploadIds)}${csvReachFilter(reach)}`;
  const res = (await db.execute(sql`
    SELECT
      count(*)::int AS total_sendable,
      (count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM contact_serves s
          WHERE s.brand_id = c.brand_id AND s.email = c.primary_email
        )
      ))::int AS served
    FROM sendable_contacts c
    WHERE c.org_id = ${orgId}
      AND c.brand_id = ${brandId}${files}
  `)) as unknown as { total_sendable: number; served: number }[];

  const row = res[0] ?? { total_sendable: 0, served: 0 };
  return {
    served: row.served,
    remainingSendable: row.total_sendable - row.served,
    totalSendable: row.total_sendable,
  };
}

// ─── PEOPLE pool — serve merged persons, not CSV rows ────────────────────────

/**
 * A serve can draw from the brand's merged PEOPLE (lib/people) instead of its
 * CSV rows: everyone the brand's own tools know (its product's signups, its
 * CRM, its mailbox, its WhatsApp…), one row per human. The filter says WHICH
 * people, in the same words for every brand and every channel:
 *
 *  - `signedUp: true`  → only people who signed up to the brand's product (a
 *    presence on one of its auth providers, Clerk today). `false` → only people
 *    who did not.
 *  - `replied: false`  → only people who NEVER wrote to the brand on any
 *    conversation channel (Gmail / WhatsApp / LinkedIn inbound, any answer to
 *    our cold email). Never written to AND written to without an answer both
 *    qualify. `true` → only people who did answer.
 *  - `reachableBy`     → only people holding a `phone` / an `email`.
 *  - `segment`         → only people in that part of the brand's own CRM (a
 *    deal stage, a tag, a funnel step reached...; lib/people/segment.ts). Clients
 *    are out of a segment unless it says `includeClients`.
 *
 * Always out: people Jev holds as automated senders or as not about this
 * brand, anyone without an email (an email is the durable no-re-serve key), and
 * anyone the brand's CRM marks do-not-contact (a CSV opt-out, a GoHighLevel DND),
 * exactly as the CSV pool's `sendable_contacts` already excludes them; only a
 * segment stating `includeOptedOut` lifts it.
 *
 * No re-serve is the SAME brand-wide guard as the CSV pool: `contact_serves`
 * keyed (brand, email). Serving a person suppresses EVERY address they hold, and
 * a person any of whose addresses was served (from a CSV file or this pool) is
 * never served again.
 */
export interface PeopleFilter {
  signedUp?: boolean;
  replied?: boolean;
  reachableBy?: Reach | Reach[];
  segment?: Segment;
}

const reachList = (r: PeopleFilter["reachableBy"]): Reach[] => (r === undefined ? [] : Array.isArray(r) ? r : [r]);

/** A served person — the CSV `ServedContact` shape plus the person's identity. */
export interface ServedPerson extends Omit<ServedContact, "sourceUploadId" | "sourceRowId"> {
  sourceUploadId: null;
  sourceRowId: null;
  pool: "people";
  /** The person's opaque id (people/person-id.ts): what a URL or a later call names them by. */
  personId: string | null;
  emails: string[];
  phones: string[];
  /** Where each phone came from (`{ phone, source, via }`), from the person's presences. */
  phoneSources: { phone: string; source: string; via: string | null }[];
  sources: string[];
}

export interface ServeNextPeopleResult {
  contacts: ServedPerson[];
  served: number;
  exhausted: boolean;
}

interface RawPersonRow {
  id: string;
  org_id: string;
  brand_id: string;
  person_id: string | null;
  display_name: string | null;
  emails: string[];
  phones: string[];
  sources: string[];
  presences: { source: string; phones?: string[]; detail?: Record<string, unknown> }[];
  built_at: string | Date;
}

/** Names first / last the same light way the CSV and Matrix paths do. */
function splitDisplayName(name: string | null): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

export function phoneSourcesOf(row: Pick<RawPersonRow, "phones" | "presences">): ServedPerson["phoneSources"] {
  return row.phones.map((phone) => {
    const holder = row.presences.find((p) => (p.phones ?? []).some((x) => normalizedEq(x, phone)));
    const via = holder?.detail && typeof holder.detail === "object"
      ? ((holder.detail.phoneSources as { phone: string; via: string }[] | undefined) ?? []).find((s) => normalizedEq(s.phone, phone))?.via ?? null
      : null;
    return { phone, source: holder?.source ?? "evidence", via };
  });
}

const digits = (s: string) => s.replace(/\D/g, "");
const normalizedEq = (a: string, b: string) => digits(a) === digits(b);

function toServedPerson(r: RawPersonRow): ServedPerson {
  const { firstName, lastName } = splitDisplayName(r.display_name);
  return {
    id: r.id,
    orgId: r.org_id,
    brandId: r.brand_id,
    primaryEmail: r.emails[0] ?? null,
    phoneE164: r.phones[0] ?? null,
    fullName: r.display_name,
    firstName,
    lastName,
    rawAttributes: {},
    consentStatus: "unknown",
    unsubscribed: false,
    sourceUploadId: null,
    sourceRowId: null,
    lastRebuiltAt: r.built_at instanceof Date ? r.built_at.toISOString() : r.built_at,
    pool: "people",
    personId: r.person_id,
    emails: r.emails,
    phones: r.phones,
    phoneSources: phoneSourcesOf(r),
    sources: r.sources,
  };
}

/**
 * The people pool's rule as NAMED clauses (alias `p`), before the no-re-serve
 * guard and without the org/brand scope. ONE list feeds both the serve's WHERE
 * (`peoplePoolWhere`) and the still-fits read (lib/still-fits.ts), so "who the
 * pool takes" and "why this person is no longer in it" can never disagree.
 */
export function peoplePoolClauses(orgId: string, brandId: string, filter: PeopleFilter, reach: readonly Reach[] = []): PoolClause[] {
  const auth = sql.join(AUTH_PROVIDER_NAMES.map((n) => sql`${n}`), sql`, `);
  const parts: PoolClause[] = [
    { code: "automated", reason: "Known as an automated sender", sql: sql`NOT p.automated` },
    { code: "not_business", reason: "Not about this brand's business", sql: sql`NOT p.not_business` },
    { code: "no_email", reason: "Holds no email address", sql: sql`jsonb_array_length(p.emails) > 0` },
    // Never our staff (the owner merged across his addresses, our own test accounts):
    // same rule as isStaffEmail, plus-addressing ignored, on EVERY address of the person.
    {
      code: "staff",
      reason: "Is our own staff",
      sql: sql`NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p.emails) AS se(email)
      WHERE lower(se.email) LIKE ${`%${STAFF_DOMAIN}`}
         OR (regexp_replace(split_part(lower(se.email), '@', 1), '[+].*$', '') || '@' || split_part(lower(se.email), '@', 2))
            IN (${sql.join(STAFF_EMAIL_LIST.map((e) => sql`${e}`), sql`, `)})
    )`,
    },
  ];
  if (filter.signedUp !== undefined) {
    const signed = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(p.presences) pr WHERE pr->>'source' IN (${auth}))`;
    parts.push(
      filter.signedUp
        ? { code: "signed_up", reason: "Not signed up to the product", sql: signed }
        : { code: "signed_up", reason: "Signed up to the product", sql: sql`NOT ${signed}` },
    );
  }
  if (filter.replied !== undefined) {
    parts.push(
      filter.replied
        ? { code: "replied", reason: "Never answered the brand", sql: PERSON_REPLIED_SQL }
        : { code: "replied", reason: "Has written to the brand", sql: sql`NOT ${PERSON_REPLIED_SQL}` },
    );
  }
  // Email is always required (the no-re-serve key); phone when the audience or the pipe asks.
  if ([...reachList(filter.reachableBy), ...reach].includes("phone")) {
    parts.push({ code: "no_phone", reason: "Holds no phone number", sql: sql`jsonb_array_length(p.phones) > 0` });
  }
  if (!filter.segment?.includeOptedOut) {
    parts.push({ code: "opted_out", reason: "Marked do not contact in the brand's CRM", sql: sql`NOT ${personOptedOut(orgId, brandId)}` });
  }
  parts.push(...segmentClauses(orgId, brandId, filter.segment));
  return parts;
}

/** The WHERE of the people pool (alias `p`), before the no-re-serve guard. */
export function peoplePoolWhere(orgId: string, brandId: string, filter: PeopleFilter, reach: readonly Reach[] = []) {
  const parts = [sql`p.org_id = ${orgId}`, sql`p.brand_id = ${brandId}`, ...peoplePoolClauses(orgId, brandId, filter, reach).map((c) => c.sql)];
  return sql.join(parts, sql` AND `);
}

const NOT_SERVED = sql`NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(p.emails) AS pe(email)
  JOIN contact_serves s ON s.brand_id = p.brand_id AND s.email = pe.email
)`;

export async function serveNextPeople(
  orgId: string,
  brandId: string,
  limit: number,
  runId: string,
  filter: PeopleFilter,
  reach: readonly Reach[] = [],
): Promise<ServeNextPeopleResult> {
  const where = peoplePoolWhere(orgId, brandId, filter, reach);
  const rows = (await db.execute(sql`
    WITH candidate AS (
      SELECT p.id, p.org_id, p.brand_id, p.person_id, p.display_name, p.emails, p.phones,
             p.sources, p.presences, p.built_at, p.first_activity_at, p.person_key
      FROM people p
      WHERE ${where} AND ${NOT_SERVED}
      ORDER BY p.first_activity_at ASC NULLS LAST, p.person_key ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    ins AS (
      INSERT INTO contact_serves (org_id, brand_id, contact_id, email, served_run_id)
      SELECT c.org_id, c.brand_id, c.id, e.email, ${runId}
      FROM candidate c, jsonb_array_elements_text(c.emails) AS e(email)
      ON CONFLICT (brand_id, email) DO NOTHING
      RETURNING contact_id, email
    )
    SELECT candidate.* FROM candidate
    WHERE EXISTS (SELECT 1 FROM ins WHERE ins.contact_id = candidate.id AND ins.email = candidate.emails->>0)
    ORDER BY candidate.first_activity_at ASC NULLS LAST, candidate.person_key ASC
  `)) as unknown as RawPersonRow[];

  const contacts = rows.map(toServedPerson);
  const stats = await serveStatsPeople(orgId, brandId, filter, reach);
  return { contacts, served: contacts.length, exhausted: stats.remainingSendable === 0 };
}

/** Same `{ served, remainingSendable, totalSendable }` over the people pool; served + remaining = total. */
export async function serveStatsPeople(
  orgId: string,
  brandId: string,
  filter: PeopleFilter,
  reach: readonly Reach[] = [],
): Promise<ServeStats> {
  const where = peoplePoolWhere(orgId, brandId, filter, reach);
  const res = (await db.execute(sql`
    SELECT count(*)::int AS total, (count(*) FILTER (WHERE ${NOT_SERVED}))::int AS remaining
    FROM people p WHERE ${where}
  `)) as unknown as { total: number; remaining: number }[];
  const row = res[0] ?? { total: 0, remaining: 0 };
  return { served: row.total - row.remaining, remainingSendable: row.remaining, totalSendable: row.total };
}

export interface StageCount extends ServeStats {
  pipeline: string | null;
  stage: string;
}

/**
 * The same counts per stated deal stage of a segment (`byStage`): what each
 * stage brings. Entries overlap when a person holds deals at two of them; the
 * segment's own total counts that person once. Empty when the segment names no
 * stage.
 */
export async function serveStatsPeopleByStage(
  orgId: string,
  brandId: string,
  filter: PeopleFilter,
  reach: readonly Reach[] = [],
): Promise<StageCount[]> {
  if (!filter.segment) return [];
  const out: StageCount[] = [];
  for (const one of perStageSegments(filter.segment)) {
    const stats = await serveStatsPeople(orgId, brandId, { ...filter, segment: one.segment }, reach);
    out.push({ pipeline: one.pipeline, stage: one.stage, ...stats });
  }
  return out;
}

/** What the brand's CRM holds that a segment can name, counted over the people pool (lib/people/segment.ts). */
export function readPeopleSegments(orgId: string, brandId: string): Promise<SegmentCatalogue> {
  return readSegmentCatalogue(
    async <T>(q: SQL) => (await db.execute(q)) as unknown as T[],
    orgId,
    brandId,
    peoplePoolWhere(orgId, brandId, {}),
  );
}
