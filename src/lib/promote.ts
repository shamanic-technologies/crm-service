import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { contactUploads, contactRowsRaw, contacts, NewContact } from "../db/schema.js";
import { ColumnMapping, ColumnField } from "./column-typing.js";

/**
 * SILVER promotion — deterministic, idempotent projection of bronze raw rows into
 * canonical `contacts`. ZERO per-row LLM: the column mapping (one LLM call at
 * upload time) is applied in code here.
 */

const CHUNK = 1000;

const TRUTHY = /^(true|1|yes|y|on|granted|subscribed|opt.?in)$/i;
const FALSY = /^(false|0|no|n|off|denied|unsubscribed|opt.?out)$/i;
const UNSUB_KEY = /unsub|opt.?out|do.?not.?(mail|email|contact)|blacklist|suppress/i;
const CONSENT_KEY = /consent|gdpr|opt.?in|permission|marketing.?consent/i;

interface SilverRecord {
  primaryEmail: string | null;
  phoneE164: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  rawAttributes: Record<string, string>;
  consentStatus: "granted" | "denied" | "unknown";
  unsubscribed: boolean;
  sourceRowId: string;
}

function firstNonEmpty(
  payload: Record<string, string>,
  headers: string[],
  mapping: ColumnMapping,
  field: ColumnField,
): string | null {
  for (const header of headers) {
    if (mapping[header] !== field) continue;
    const v = payload[header];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v === "" ? null : v;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  return cleaned === "" || cleaned === "+" ? null : cleaned;
}

/** Deterministically derive consent + unsubscribe from known column NAMES. */
function deriveConsent(payload: Record<string, string>): {
  consentStatus: "granted" | "denied" | "unknown";
  unsubscribed: boolean;
} {
  let unsubscribed = false;
  let consentStatus: "granted" | "denied" | "unknown" = "unknown";

  for (const [key, value] of Object.entries(payload)) {
    const v = String(value ?? "").trim();
    if (v === "") continue;

    if (UNSUB_KEY.test(key)) {
      if (TRUTHY.test(v)) unsubscribed = true;
      // A "subscribed=false" style column also implies unsubscribed.
      else if (FALSY.test(v) && /subscrib/i.test(key)) unsubscribed = true;
    }

    if (CONSENT_KEY.test(key) && consentStatus === "unknown") {
      if (TRUTHY.test(v)) consentStatus = "granted";
      else if (FALSY.test(v)) consentStatus = "denied";
    }
  }

  return { consentStatus, unsubscribed };
}

/** Build one silver record from a raw payload + mapping. */
export function deriveSilverRecord(
  payload: Record<string, string>,
  headers: string[],
  mapping: ColumnMapping,
  sourceRowId: string,
): SilverRecord {
  const primaryEmail = normalizeEmail(firstNonEmpty(payload, headers, mapping, "email"));
  const phoneE164 = normalizePhone(firstNonEmpty(payload, headers, mapping, "phone"));
  let firstName = firstNonEmpty(payload, headers, mapping, "first_name");
  let lastName = firstNonEmpty(payload, headers, mapping, "last_name");
  let fullName = firstNonEmpty(payload, headers, mapping, "full_name");

  // Light, deterministic name reconciliation.
  if (fullName && !firstName && !lastName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0] ?? null;
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
  } else if (!fullName && (firstName || lastName)) {
    fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
  }

  // Everything typed 'other' lands in raw_attributes verbatim.
  const rawAttributes: Record<string, string> = {};
  for (const header of headers) {
    if (mapping[header] === "other") {
      const v = payload[header];
      if (v !== undefined && v !== null) rawAttributes[header] = String(v);
    }
  }

  const { consentStatus, unsubscribed } = deriveConsent(payload);

  return {
    primaryEmail,
    phoneE164,
    fullName,
    firstName,
    lastName,
    rawAttributes,
    consentStatus,
    unsubscribed,
    sourceRowId,
  };
}

export interface PromoteResult {
  uploadId: string;
  rawRows: number;
  contactsUpserted: number;
}

/**
 * Promote a single upload's bronze rows into silver. Idempotent: re-running
 * produces the same silver state. Runs in one transaction.
 */
export async function promoteUpload(uploadId: string): Promise<PromoteResult> {
  const [upload] = await db.select().from(contactUploads).where(eq(contactUploads.id, uploadId));
  if (!upload) throw new Error(`[crm-service] promote: upload ${uploadId} not found`);

  const mapping = (upload.columnMapping ?? {}) as ColumnMapping;
  const headers = (upload.columnHeaders ?? []) as string[];
  if (!upload.columnMapping) {
    throw new Error(`[crm-service] promote: upload ${uploadId} has no column mapping yet`);
  }

  const rawRows = await db
    .select()
    .from(contactRowsRaw)
    .where(eq(contactRowsRaw.uploadId, uploadId));

  // Dedup within the upload: email-bearing rows collapse on lower(email)
  // (last row wins); null-email rows are kept individually.
  const emailMap = new Map<string, NewContact>();
  const noEmail: NewContact[] = [];

  for (const raw of rawRows) {
    const rec = deriveSilverRecord(
      (raw.payload ?? {}) as Record<string, string>,
      headers,
      mapping,
      raw.id,
    );
    const base: NewContact = {
      orgId: upload.orgId,
      brandId: upload.brandId,
      primaryEmail: rec.primaryEmail,
      phoneE164: rec.phoneE164,
      fullName: rec.fullName,
      firstName: rec.firstName,
      lastName: rec.lastName,
      rawAttributes: rec.rawAttributes,
      consentStatus: rec.consentStatus,
      unsubscribed: rec.unsubscribed,
      sourceUploadId: uploadId,
      sourceRowId: rec.sourceRowId,
    };
    if (rec.primaryEmail) emailMap.set(rec.primaryEmail, base);
    else noEmail.push(base);
  }

  let upserted = 0;

  await db.transaction(async (tx) => {
    // Remove the rows this upload previously produced (idempotent re-promote).
    await tx
      .delete(contacts)
      .where(
        and(
          eq(contacts.orgId, upload.orgId),
          eq(contacts.brandId, upload.brandId),
          eq(contacts.sourceUploadId, uploadId),
        ),
      );

    // Null-email rows: plain insert (no email dedup key).
    for (let i = 0; i < noEmail.length; i += CHUNK) {
      const chunk = noEmail.slice(i, i + CHUNK);
      if (chunk.length) {
        await tx.insert(contacts).values(chunk);
        upserted += chunk.length;
      }
    }

    // Email-bearing rows: last-write-wins on the (org, brand, lower(email))
    // natural key. Deduped above, so each email appears once. drizzle 0.36 can't
    // express an ON CONFLICT against an expression index, so we delete any
    // existing contact sharing one of these emails (cross-upload takeover) then
    // bulk-insert. The unique index still guards integrity.
    const emailRows = [...emailMap.values()];
    for (let i = 0; i < emailRows.length; i += CHUNK) {
      const chunk = emailRows.slice(i, i + CHUNK);
      if (!chunk.length) continue;
      const emails = chunk.map((r) => r.primaryEmail as string);
      await tx
        .delete(contacts)
        .where(
          and(
            eq(contacts.orgId, upload.orgId),
            eq(contacts.brandId, upload.brandId),
            inArray(sql`lower(${contacts.primaryEmail})`, emails),
          ),
        );
      await tx.insert(contacts).values(chunk);
      upserted += chunk.length;
    }
  });

  return { uploadId, rawRows: rawRows.length, contactsUpserted: upserted };
}
