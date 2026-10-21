import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { normalizeEmail } from "./normalize.js";

/**
 * EMAIL UNKNOWN — a CSV-pool contact (a file row or a contact added one by one) whose email
 * we do not know yet is still reachable (CRM-ADD-ONE-CONTACT-1021): the serving side
 * (human-service) looks the email up at SERVE time, inside the campaign's caps and billed to
 * it (owner 2026-10-21: adding a contact stays free, a paid lookup only when a campaign
 * serves the person). crm-service does no lookup itself.
 *
 * - Hand-out (`serve-next` with `includeEmailUnknown: true`, CSV pool): contacts with NO
 *   email that carry a name AND something to find the email with (company domain, company
 *   name or LinkedIn), same opt-out / consent rules as `sendable_contacts`, same file /
 *   reach / step filters as the serve. Atomically recorded `handed_out` in
 *   `contact_email_lookups` (keyed on the bronze row, stable): concurrent serves never hand
 *   one person out twice. A `handed_out` row nobody resolves is handed out again after the
 *   TTL (the caller crashed before writing back).
 * - Write-back (`POST /orgs/contacts/{contactId}/email-lookup`): `found` + email = the
 *   contact gets the email (a normal sendable contact) AND is marked served on the email
 *   (the hand-out WAS its serve: the caller is writing to them now, the next serve never
 *   hands them out again); `not_found` = never handed out again. The found address held by
 *   another contact of the brand is that contact (`duplicateOf`): not copied, still served.
 */

const HANDOUT_TTL_HOURS = Number(process.env.CRM_EMAIL_LOOKUP_HANDOUT_TTL_HOURS) || 24;

export interface EmailUnknownCounts {
  /** Contacts that can be handed out now. */
  remaining: number;
  /** Handed out, not resolved yet (within the TTL). */
  handedOut: number;
  found: number;
  notFound: number;
}

/** Who can be handed out for a lookup (alias `c` on `contacts`), before the lookup-state guard. */
function lookupPoolWhere(orgId: string, brandId: string, extra: SQL): SQL {
  return sql`c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = 'csv'
    AND c.primary_email IS NULL AND c.source_row_id IS NOT NULL
    AND c.unsubscribed = false AND c.consent_status <> 'denied'
    AND (c.full_name IS NOT NULL OR c.first_name IS NOT NULL OR c.last_name IS NOT NULL)
    AND (c.company_domain IS NOT NULL OR c.company_name IS NOT NULL OR c.linkedin_url IS NOT NULL)${extra}`;
}

const NOT_LOOKED_UP = sql`NOT EXISTS (
  SELECT 1 FROM contact_email_lookups l
  WHERE l.brand_id = c.brand_id AND l.source_row_id = c.source_row_id
    AND (l.status <> 'handed_out' OR l.handed_out_at > now() - make_interval(hours => ${HANDOUT_TTL_HOURS}::int))
)`;

export interface HandedOutRow {
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
  company_name: string | null;
  company_domain: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  note: string | null;
}

/** Hand out up to `limit` email-unknown contacts and record them `handed_out`, atomically. */
export async function handOutEmailUnknown(
  orgId: string,
  brandId: string,
  limit: number,
  runId: string,
  extra: SQL,
): Promise<HandedOutRow[]> {
  if (limit <= 0) return [];
  return (await db.execute(sql`
    WITH candidate AS (
      SELECT c.id, c.org_id, c.brand_id, c.primary_email, c.phone_e164, c.full_name, c.first_name, c.last_name,
             c.raw_attributes, c.consent_status, c.unsubscribed, c.source_upload_id, c.source_row_id,
             c.last_rebuilt_at, c.company_name, c.company_domain, c.job_title, c.linkedin_url, c.note
      FROM contacts c
      WHERE ${lookupPoolWhere(orgId, brandId, extra)} AND ${NOT_LOOKED_UP}
      ORDER BY c.last_rebuilt_at ASC, c.id ASC
      LIMIT ${limit}
      FOR UPDATE OF c SKIP LOCKED
    ),
    ins AS (
      INSERT INTO contact_email_lookups AS l (org_id, brand_id, source_row_id, contact_id, status, handed_out_at, handed_out_run_id)
      SELECT org_id, brand_id, source_row_id, id, 'handed_out', now(), ${runId} FROM candidate
      ON CONFLICT (brand_id, source_row_id) DO UPDATE
        SET contact_id = excluded.contact_id, handed_out_at = now(), handed_out_run_id = excluded.handed_out_run_id,
            hand_out_count = l.hand_out_count + 1
        WHERE l.status = 'handed_out' AND l.handed_out_at <= now() - make_interval(hours => ${HANDOUT_TTL_HOURS}::int)
      RETURNING source_row_id
    )
    SELECT candidate.* FROM candidate JOIN ins ON ins.source_row_id = candidate.source_row_id
    ORDER BY candidate.last_rebuilt_at ASC, candidate.id ASC
  `)) as unknown as HandedOutRow[];
}

export async function emailUnknownCounts(orgId: string, brandId: string, extra: SQL): Promise<EmailUnknownCounts> {
  const [r] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM contacts c WHERE ${lookupPoolWhere(orgId, brandId, extra)} AND ${NOT_LOOKED_UP}) AS remaining,
      (SELECT count(*)::int FROM contact_email_lookups l
         WHERE l.org_id = ${orgId} AND l.brand_id = ${brandId} AND l.status = 'handed_out'
           AND l.handed_out_at > now() - make_interval(hours => ${HANDOUT_TTL_HOURS}::int)) AS handed_out,
      (SELECT count(*)::int FROM contact_email_lookups l WHERE l.org_id = ${orgId} AND l.brand_id = ${brandId} AND l.status = 'found') AS found,
      (SELECT count(*)::int FROM contact_email_lookups l WHERE l.org_id = ${orgId} AND l.brand_id = ${brandId} AND l.status = 'not_found') AS not_found
  `)) as unknown as { remaining: number; handed_out: number; found: number; not_found: number }[];
  return { remaining: r.remaining, handedOut: r.handed_out, found: r.found, notFound: r.not_found };
}

export class EmailLookupError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EmailLookupResult {
  contactId: string;
  status: "found" | "not_found";
  email: string | null;
  emailStatus: "known" | "not_found";
  /** The brand's other contact already holding the found address (that contact IS the person). */
  duplicateOf: string | null;
  /** True when the found address is marked served for the brand (it is never served again). */
  served: boolean;
}

/** Record what the serving side found for one contact. Idempotent; the latest statement wins. */
export async function recordEmailLookup(
  identity: { orgId: string; brandId: string; runId: string },
  contactId: string,
  status: "found" | "not_found",
  rawEmail: string | null,
): Promise<EmailLookupResult> {
  const { orgId, brandId, runId } = identity;
  const email = normalizeEmail(rawEmail);
  return db.transaction(async (tx) => {
    const [c] = (await tx.execute(sql`
      SELECT id, primary_email, source_row_id FROM contacts
      WHERE id = ${contactId} AND org_id = ${orgId} AND brand_id = ${brandId} AND source = 'csv'
      FOR UPDATE
    `)) as unknown as { id: string; primary_email: string | null; source_row_id: string | null }[];
    if (!c || !c.source_row_id) throw new EmailLookupError(404, "contact_not_found", "No imported or added contact of this brand has this id");
    if (c.primary_email) {
      if (status === "found" && email === c.primary_email.toLowerCase()) {
        return { contactId, status, email, emailStatus: "known", duplicateOf: null, served: true };
      }
      throw new EmailLookupError(409, "email_already_known", "This contact already holds an email; nothing to look up");
    }

    await tx.execute(sql`
      INSERT INTO contact_email_lookups AS l (org_id, brand_id, source_row_id, contact_id, status, email, handed_out_run_id, hand_out_count, resolved_at, resolved_run_id)
      VALUES (${orgId}, ${brandId}, ${c.source_row_id}, ${contactId}, ${status}, ${email}, ${runId}, 0, now(), ${runId})
      ON CONFLICT (brand_id, source_row_id) DO UPDATE
        SET status = excluded.status, email = excluded.email, contact_id = excluded.contact_id,
            resolved_at = now(), resolved_run_id = excluded.resolved_run_id
    `);
    if (status === "not_found") {
      return { contactId, status, email: null, emailStatus: "not_found", duplicateOf: null, served: false };
    }

    const [dup] = (await tx.execute(sql`
      SELECT id FROM contacts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = 'csv' AND lower(primary_email) = ${email} AND id <> ${contactId}
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (!dup) {
      await tx.execute(sql`UPDATE contacts SET primary_email = ${email}, last_rebuilt_at = now() WHERE id = ${contactId}`);
    }
    await tx.execute(sql`
      INSERT INTO contact_serves (org_id, brand_id, contact_id, email, served_run_id)
      VALUES (${orgId}, ${brandId}, ${dup?.id ?? contactId}, ${email}, ${runId})
      ON CONFLICT (brand_id, email) DO NOTHING
    `);
    return { contactId, status, email, emailStatus: "known", duplicateOf: dup?.id ?? null, served: true };
  });
}
