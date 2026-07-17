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
 */
export async function serveNext(
  orgId: string,
  brandId: string,
  limit: number,
  runId: string,
): Promise<ServeNextResult> {
  const rows = (await db.execute(sql`
    WITH candidate AS (
      SELECT c.id, c.org_id, c.brand_id, c.primary_email, c.phone_e164,
             c.full_name, c.first_name, c.last_name, c.raw_attributes,
             c.consent_status, c.unsubscribed, c.source_upload_id,
             c.source_row_id, c.last_rebuilt_at
      FROM sendable_contacts c
      WHERE c.org_id = ${orgId}
        AND c.brand_id = ${brandId}
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
  // serve. Zero → the brand is drained. Computed live, never fabricated.
  const remaining = await countRemaining(orgId, brandId);

  return { contacts, served: contacts.length, exhausted: remaining === 0 };
}

async function countRemaining(orgId: string, brandId: string): Promise<number> {
  const res = (await db.execute(sql`
    SELECT count(*)::int AS remaining
    FROM sendable_contacts c
    WHERE c.org_id = ${orgId}
      AND c.brand_id = ${brandId}
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

export async function serveStats(orgId: string, brandId: string): Promise<ServeStats> {
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
