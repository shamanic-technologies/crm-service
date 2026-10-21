import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { ContactUpload } from "../../db/schema.js";
import { cleanText, normalizeDomain, normalizeEmail, normalizeLinkedinUrl, normalizePhone } from "./normalize.js";

/**
 * CONTACTS ADDED ONE BY ONE (CRM-ADD-ONE-CONTACT-1021).
 *
 * A client knows one person and wants us to reach them ("Head of Automation at NTT, here is
 * his LinkedIn"), from the Copilot, the API or the MCP. Each brand holds ONE list of such
 * contacts: a `contact_uploads` row of kind `manual` (filename "Contacts added one by one"),
 * so everything a CSV contact goes through (the `sendable_contacts` gold view, the serve,
 * per-file toggles, the fact feed, the people build's CSV evidence) applies unchanged.
 *
 * - BRONZE stays append-only: every add is a NEW `contact_rows_raw` row (the statement, who,
 *   when). Adding the same person again appends a second statement, never rewrites the first.
 * - SILVER = one contact per PERSON: rows naming the same email or the same LinkedIn profile
 *   are ONE cluster (union-find), derived in row order (a later statement's value wins, notes
 *   are kept, all of them). The cluster's FIRST row is its anchor (`source_row_id`): stable,
 *   so the contact keeps its id across adds.
 * - A person already in a CSV FILE of the brand (same email / LinkedIn) is taken over: their
 *   file contact's fields are copied into the new statement (`fromContact`, so the file's
 *   phone / opt-out are never lost) and the file row is no longer derived over them
 *   (`manualHeldKeys`, read by every file promote). One person, never two.
 * - An email found later by a lookup (`contact_email_lookups` found) fills a contact stating
 *   none (lib/contacts/email-lookup.ts).
 * - No model, no vendor, no cost: adding a contact is free (owner 2026-10-21).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<typeof db, "execute">;

export const MANUAL_UPLOAD_FILENAME = "Contacts added one by one";
const manualHash = (brandId: string) => `manual:${brandId}`;

export function isManualUpload(u: Pick<ContactUpload, "kind">): boolean {
  return u.kind === "manual";
}

/** What a client states about one person. Every field optional; the route requires enough to find them. */
export interface ManualContactInput {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  note?: string | null;
}

/** A file contact's fields, copied into the statement that takes them over. */
interface FromContact {
  contactId: string;
  uploadId: string | null;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  note: string | null;
  rawAttributes: Record<string, string>;
  consentStatus: string;
  unsubscribed: boolean;
}

/** The bronze payload of one statement. */
export interface ManualPayload {
  kind: "manual_contact";
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  note: string | null;
  addedByUserId: string | null;
  addedAt: string;
  runId: string;
  fromContact: FromContact | null;
}

/** The input, normalized the way silver stores it. */
export function normalizeManualInput(input: ManualContactInput) {
  return {
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
    firstName: cleanText(input.firstName),
    lastName: cleanText(input.lastName),
    fullName: cleanText(input.fullName),
    companyName: cleanText(input.companyName),
    companyDomain: normalizeDomain(input.companyDomain),
    jobTitle: cleanText(input.jobTitle),
    linkedinUrl: normalizeLinkedinUrl(input.linkedinUrl),
    note: cleanText(input.note),
  };
}

export interface ManualRecord {
  anchorRowId: string;
  rowIds: string[];
  primaryEmail: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  note: string | null;
  rawAttributes: Record<string, string>;
  consentStatus: "granted" | "denied" | "unknown";
  unsubscribed: boolean;
}

interface RawRow {
  id: string;
  row_number: number;
  payload: ManualPayload;
}

/**
 * Pure: the statements of a brand's manual list → one record per person. Rows sharing an
 * email or a LinkedIn profile (their own or the file contact they took over) are one person.
 */
export function deriveManualRecords(rows: RawRow[]): ManualRecord[] {
  const sorted = [...rows].sort((a, b) => a.row_number - b.row_number);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const byKey = new Map<string, string>();
  for (const r of sorted) {
    parent.set(r.id, r.id);
    const p = r.payload;
    const keys = [p.email, p.fromContact?.email].filter(Boolean).map((e) => `email:${e}`);
    keys.push(...[p.linkedinUrl, p.fromContact?.linkedinUrl].filter(Boolean).map((l) => `li:${l}`));
    for (const k of keys) {
      const seen = byKey.get(k);
      if (seen) union(seen, r.id);
      else byKey.set(k, r.id);
    }
  }
  // Anchor = the earliest row of each cluster (union keeps the earlier root: rows run in order).
  const clusters = new Map<string, RawRow[]>();
  for (const r of sorted) {
    const root = find(r.id);
    clusters.set(root, [...(clusters.get(root) ?? []), r]);
  }
  const out: ManualRecord[] = [];
  for (const members of clusters.values()) {
    const rec: ManualRecord = {
      anchorRowId: members[0].id,
      rowIds: members.map((m) => m.id),
      primaryEmail: null,
      phoneE164: null,
      firstName: null,
      lastName: null,
      fullName: null,
      companyName: null,
      companyDomain: null,
      jobTitle: null,
      linkedinUrl: null,
      note: null,
      rawAttributes: {},
      consentStatus: "unknown",
      unsubscribed: false,
    };
    const notes: string[] = [];
    const take = (src: Partial<Record<keyof ManualPayload, unknown>>) => {
      const set = <K extends keyof ManualRecord>(k: K, v: unknown) => {
        if (typeof v === "string" && v !== "") (rec[k] as unknown) = v;
      };
      set("primaryEmail", src.email);
      set("phoneE164", src.phone);
      set("firstName", src.firstName);
      set("lastName", src.lastName);
      set("fullName", src.fullName);
      set("companyName", src.companyName);
      set("companyDomain", src.companyDomain);
      set("jobTitle", src.jobTitle);
      set("linkedinUrl", src.linkedinUrl);
    };
    for (const m of members) {
      const from = m.payload.fromContact;
      if (from) {
        // The file's values first: what the client states next wins over them.
        take(from as unknown as Record<string, unknown>);
        rec.rawAttributes = { ...rec.rawAttributes, ...from.rawAttributes };
        if (from.unsubscribed) rec.unsubscribed = true;
        if (from.consentStatus === "denied") rec.consentStatus = "denied";
        else if (from.consentStatus === "granted" && rec.consentStatus === "unknown") rec.consentStatus = "granted";
        if (from.note && !notes.includes(from.note)) notes.push(from.note);
      }
      take(m.payload as unknown as Record<string, unknown>);
      if (m.payload.note && !notes.includes(m.payload.note)) notes.push(m.payload.note);
    }
    if (!rec.fullName && (rec.firstName || rec.lastName)) rec.fullName = [rec.firstName, rec.lastName].filter(Boolean).join(" ");
    if (rec.fullName && !rec.firstName && !rec.lastName) {
      const parts = rec.fullName.split(/\s+/);
      rec.firstName = parts[0] ?? null;
      rec.lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    rec.note = notes.length ? notes.join("\n\n") : null;
    out.push(rec);
  }
  return out;
}

/** Every email + LinkedIn the brand's manual list holds: a file promote never derives over them. */
export async function manualHeldKeys(exec: Exec, orgId: string, brandId: string): Promise<{ emails: Set<string>; linkedins: Set<string> }> {
  const rows = (await exec.execute(sql`
    SELECT lower(c.primary_email) AS email, c.linkedin_url
    FROM contacts c JOIN contact_uploads u ON u.id = c.source_upload_id
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = 'csv' AND u.kind = 'manual'
  `)) as unknown as { email: string | null; linkedin_url: string | null }[];
  return {
    emails: new Set(rows.map((r) => r.email).filter((e): e is string => !!e)),
    linkedins: new Set(rows.map((r) => r.linkedin_url).filter((l): l is string => !!l)),
  };
}

/** The brand's manual list, created on first use (one per (org, brand)). */
export async function ensureManualUpload(tx: Tx, orgId: string, brandId: string, runId: string): Promise<ContactUpload> {
  await tx.execute(sql`
    INSERT INTO contact_uploads (org_id, brand_id, filename, content_hash, row_count, column_headers, column_mapping,
                                 mapping_provenance, status, run_id, kind)
    VALUES (${orgId}, ${brandId}, ${MANUAL_UPLOAD_FILENAME}, ${manualHash(brandId)}, 0, '[]'::jsonb, '{}'::jsonb,
            'manual', 'promoted', ${runId}, 'manual')
    ON CONFLICT DO NOTHING
  `);
  const [row] = (await tx.execute(sql`
    SELECT id, org_id, brand_id, kind FROM contact_uploads
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND kind = 'manual'
  `)) as unknown as { id: string; org_id: string; brand_id: string; kind: string }[];
  if (!row) throw new Error(`[crm-service] manual contacts: no manual list for brand ${brandId} after create`);
  return { id: row.id, orgId: row.org_id, brandId: row.brand_id, kind: row.kind } as ContactUpload;
}

/**
 * Re-derive the brand's whole manual list into silver, in place: an existing contact keeps
 * its id (matched on its anchor row), a new person is inserted, a person merged into another
 * is deleted. A file contact naming one of its emails / LinkedIns is removed (taken over).
 * Returns each bronze row's contact id.
 */
export async function rederiveManual(
  tx: Tx,
  upload: Pick<ContactUpload, "id" | "orgId" | "brandId">,
): Promise<{ rawRows: number; contacts: number; contactByRow: Map<string, string> }> {
  const { id: uploadId, orgId, brandId } = upload;
  const rows = (await tx.execute(sql`
    SELECT id, row_number, payload FROM contact_rows_raw WHERE upload_id = ${uploadId} ORDER BY row_number
  `)) as unknown as RawRow[];
  const records = deriveManualRecords(rows);

  const found = new Map(
    (
      (await tx.execute(sql`
        SELECT source_row_id, email FROM contact_email_lookups
        WHERE brand_id = ${brandId} AND status = 'found' AND email IS NOT NULL
      `)) as unknown as { source_row_id: string; email: string }[]
    ).map((r) => [r.source_row_id, r.email]),
  );
  // A found email fills a person stating none, unless another person of the list states it.
  const stated = new Set(records.map((r) => r.primaryEmail).filter(Boolean));
  for (const r of records) {
    const f = found.get(r.anchorRowId);
    if (!r.primaryEmail && f && !stated.has(f)) {
      r.primaryEmail = f;
      stated.add(f);
    }
  }

  const existing = new Map(
    (
      (await tx.execute(sql`
        SELECT id, source_row_id FROM contacts WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source_upload_id = ${uploadId}
      `)) as unknown as { id: string; source_row_id: string }[]
    ).map((r) => [r.source_row_id, r.id]),
  );

  // Take over file contacts naming the same person (CSV rows only, never another source).
  const emails = records.map((r) => r.primaryEmail).filter((e): e is string => !!e);
  const linkedins = records.map((r) => r.linkedinUrl).filter((l): l is string => !!l);
  if (emails.length || linkedins.length) {
    const anyOf = [
      emails.length ? sql`lower(primary_email) IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})` : null,
      linkedins.length ? sql`linkedin_url IN (${sql.join(linkedins.map((l) => sql`${l}`), sql`, `)})` : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);
    await tx.execute(sql`
      DELETE FROM contacts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = 'csv'
        AND source_upload_id IS DISTINCT FROM ${uploadId}
        AND (${sql.join(anyOf, sql` OR `)})
    `);
  }

  const keep = new Set(records.map((r) => r.anchorRowId));
  const gone = [...existing.entries()].filter(([anchor]) => !keep.has(anchor)).map(([, id]) => id);
  if (gone.length) {
    await tx.execute(sql`DELETE FROM contacts WHERE id IN (${sql.join(gone.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }

  const contactByRow = new Map<string, string>();
  for (const r of records) {
    const values = sql`
      ${r.primaryEmail}, ${r.phoneE164}, ${r.fullName}, ${r.firstName}, ${r.lastName},
      ${JSON.stringify(r.rawAttributes)}::jsonb, ${r.consentStatus}, ${r.unsubscribed},
      ${r.companyName}, ${r.companyDomain}, ${r.jobTitle}, ${r.linkedinUrl}, ${r.note}`;
    const id = existing.get(r.anchorRowId);
    let contactId: string;
    if (id) {
      await tx.execute(sql`
        UPDATE contacts SET (primary_email, phone_e164, full_name, first_name, last_name, raw_attributes, consent_status,
                             unsubscribed, company_name, company_domain, job_title, linkedin_url, note) = (${values}),
               last_rebuilt_at = now()
        WHERE id = ${id}
      `);
      contactId = id;
    } else {
      const [ins] = (await tx.execute(sql`
        INSERT INTO contacts (primary_email, phone_e164, full_name, first_name, last_name, raw_attributes, consent_status,
                              unsubscribed, company_name, company_domain, job_title, linkedin_url, note,
                              org_id, brand_id, source, source_upload_id, source_row_id)
        VALUES (${values}, ${orgId}, ${brandId}, 'csv', ${uploadId}, ${r.anchorRowId})
        RETURNING id
      `)) as unknown as { id: string }[];
      contactId = ins.id;
    }
    for (const rowId of r.rowIds) contactByRow.set(rowId, contactId);
  }
  await tx.execute(sql`UPDATE contact_uploads SET row_count = ${rows.length} WHERE id = ${uploadId}`);
  return { rawRows: rows.length, contacts: records.length, contactByRow };
}

export interface AddedContact {
  contactId: string;
  created: boolean;
  matchedOn: "email" | "linkedin" | null;
  emailStatus: EmailStatus;
}

export type EmailStatus = "known" | "unknown" | "not_found";

/**
 * Add one person to the brand's CRM (ONE transaction, serialized per brand). Matches an
 * existing CSV-pool person of the brand by email, then LinkedIn: matched = the same contact
 * (created false), never a second one.
 */
export async function addManualContact(
  identity: { orgId: string; brandId: string; userId: string | null; runId: string },
  input: ManualContactInput,
): Promise<AddedContact> {
  const { orgId, brandId } = identity;
  const v = normalizeManualInput(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`crm-manual-contacts:${brandId}`}))`);
    const upload = await ensureManualUpload(tx, orgId, brandId, identity.runId);

    let matchedOn: AddedContact["matchedOn"] = null;
    let match: (Record<string, unknown> & { id: string; source_upload_id: string | null }) | undefined;
    for (const [on, cond] of [
      ["email", v.email ? sql`lower(c.primary_email) = ${v.email}` : null],
      ["linkedin", v.linkedinUrl ? sql`c.linkedin_url = ${v.linkedinUrl}` : null],
    ] as const) {
      if (!cond || match) continue;
      const [m] = (await tx.execute(sql`
        SELECT c.* FROM contacts c
        WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = 'csv' AND ${cond}
        ORDER BY (c.source_upload_id = ${upload.id}) DESC, c.last_rebuilt_at ASC, c.id ASC
        LIMIT 1
      `)) as unknown as (Record<string, unknown> & { id: string; source_upload_id: string | null })[];
      if (m) {
        match = m;
        matchedOn = on;
      }
    }

    const fromContact: FromContact | null =
      match && match.source_upload_id !== upload.id
        ? {
            contactId: match.id,
            uploadId: match.source_upload_id,
            email: (match.primary_email as string | null) ?? null,
            phone: (match.phone_e164 as string | null) ?? null,
            firstName: (match.first_name as string | null) ?? null,
            lastName: (match.last_name as string | null) ?? null,
            fullName: (match.full_name as string | null) ?? null,
            companyName: (match.company_name as string | null) ?? null,
            companyDomain: (match.company_domain as string | null) ?? null,
            jobTitle: (match.job_title as string | null) ?? null,
            linkedinUrl: (match.linkedin_url as string | null) ?? null,
            note: (match.note as string | null) ?? null,
            rawAttributes: (match.raw_attributes as Record<string, string>) ?? {},
            consentStatus: String(match.consent_status ?? "unknown"),
            unsubscribed: match.unsubscribed === true,
          }
        : null;

    const payload: ManualPayload = {
      kind: "manual_contact",
      ...v,
      addedByUserId: identity.userId,
      addedAt: new Date().toISOString(),
      runId: identity.runId,
      fromContact,
    };
    const [{ next }] = (await tx.execute(sql`
      SELECT COALESCE(max(row_number), -1) + 1 AS next FROM contact_rows_raw WHERE upload_id = ${upload.id}
    `)) as unknown as { next: number }[];
    const [raw] = (await tx.execute(sql`
      INSERT INTO contact_rows_raw (org_id, brand_id, upload_id, row_number, payload)
      VALUES (${orgId}, ${brandId}, ${upload.id}, ${next}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id
    `)) as unknown as { id: string }[];

    const { contactByRow } = await rederiveManual(tx, upload);
    const contactId = contactByRow.get(raw.id);
    if (!contactId) throw new Error(`[crm-service] manual contacts: row ${raw.id} derived no contact`);
    return { contactId, created: !match, matchedOn, emailStatus: await emailStatusOf(tx, contactId) };
  });
}

/** known = the contact holds an email; not_found = a lookup found none; unknown = not looked up / not resolved yet. */
export async function emailStatusOf(exec: Exec, contactId: string): Promise<EmailStatus> {
  const [r] = (await exec.execute(sql`
    SELECT c.primary_email, l.status AS lookup
    FROM contacts c
    LEFT JOIN contact_email_lookups l ON l.brand_id = c.brand_id AND l.source_row_id = c.source_row_id
    WHERE c.id = ${contactId}
  `)) as unknown as { primary_email: string | null; lookup: string | null }[];
  if (!r) throw new Error(`[crm-service] contact ${contactId} not found`);
  // `found` without an email here = the found address belongs to another contact of the brand.
  if (r.primary_email || r.lookup === "found") return "known";
  return r.lookup === "not_found" ? "not_found" : "unknown";
}
