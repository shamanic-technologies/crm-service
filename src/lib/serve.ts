import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

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
): Promise<ServeNextResult> {
  const files = uploadFilter(uploadIds);
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
  const remaining = await countRemaining(orgId, brandId, uploadIds);

  return { contacts, served: contacts.length, exhausted: remaining === 0 };
}

async function countRemaining(
  orgId: string,
  brandId: string,
  uploadIds?: string[],
): Promise<number> {
  const files = uploadFilter(uploadIds);
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
): Promise<ServeStats> {
  if (uploadIds && uploadIds.length > 0) return serveStatsForFiles(orgId, brandId, uploadIds);

  const res = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM contact_serves s
         WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId})            AS served,
      (SELECT count(*)::int FROM sendable_contacts c
         WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId})            AS total_sendable,
      (SELECT count(*)::int FROM sendable_contacts c
         WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}
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
): Promise<ServeStats> {
  const files = uploadFilter(uploadIds);
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
