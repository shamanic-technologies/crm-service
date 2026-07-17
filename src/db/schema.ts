import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * BRONZE — append-only raw mirror of an uploaded CSV.
 *
 * One row per upload artifact. `content_hash` (sha256 of the raw file bytes)
 * is the natural key for idempotent re-upload: sending the exact same file for
 * the same (org, brand) reuses the existing upload row instead of creating a
 * duplicate, and the raw rows collide on UNIQUE(upload_id, row_number).
 */
export const contactUploads = pgTable(
  "contact_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),

    filename: text("filename").notNull(),
    // sha256 hex of the raw uploaded bytes — natural key for re-upload idempotency.
    contentHash: text("content_hash").notNull(),

    rowCount: integer("row_count").notNull().default(0),
    // Ordered array of the CSV header names, as-parsed.
    columnHeaders: jsonb("column_headers").notNull(),
    // Map of header -> enum field {email,phone,first_name,last_name,full_name,other}.
    // Null until column typing has run.
    columnMapping: jsonb("column_mapping"),
    // How columnMapping was produced: 'llm' (chat-service classified) or 'override'
    // (caller supplied it). Null until typing has run.
    mappingProvenance: text("mapping_provenance"),

    // uploaded -> promoting -> promoted | failed
    status: text("status").notNull().default("uploaded"),

    // This service's own run id (from runs-service). parentRunId = inbound x-run-id.
    runId: text("run_id").notNull(),
    parentRunId: text("parent_run_id"),

    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contact_uploads_org_brand_hash_uq").on(
      table.orgId,
      table.brandId,
      table.contentHash,
    ),
    index("contact_uploads_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * BRONZE — one row per raw CSV data row, payload stored verbatim as jsonb.
 * UNIQUE(upload_id, row_number) makes chunked / retried inserts idempotent.
 */
export const contactRowsRaw = pgTable(
  "contact_rows_raw",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => contactUploads.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    // The full raw CSV row as a { header: value } object.
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contact_rows_raw_upload_row_uq").on(table.uploadId, table.rowNumber),
    index("contact_rows_raw_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * SILVER — canonical typed contact, derived deterministically from bronze.
 *
 * Dedup natural key: (org_id, brand_id, lower(primary_email)). The expression
 * unique index is created in a hand-written migration (drizzle-kit does not emit
 * expression indexes). Rows with a null email are kept but not deduped by email
 * (Postgres treats nulls as distinct).
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),

    primaryEmail: text("primary_email"),
    phoneE164: text("phone_e164"),
    fullName: text("full_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),

    // Every column NOT typed to a silver field ('other') lands here verbatim.
    rawAttributes: jsonb("raw_attributes").notNull(),

    // 'granted' | 'denied' | 'unknown' — deterministically detected from known
    // consent/opt-in column names; defaults to 'unknown'.
    consentStatus: text("consent_status").notNull().default("unknown"),
    unsubscribed: boolean("unsubscribed").notNull().default(false),

    sourceUploadId: uuid("source_upload_id").notNull(),
    sourceRowId: uuid("source_row_id").notNull(),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("contacts_org_brand_idx").on(table.orgId, table.brandId)],
);

/**
 * SERVE-TRACKING — permanent, per-(brand, contact) suppression list.
 *
 * crm-service serves sendable contacts to human-service (the people gateway).
 * Once a contact has been served for a brand it must NEVER be served again for
 * that brand — the atomic-member no-re-serve invariant (identity-keying rule).
 *
 * The suppression key is the DURABLE contact identity `lower(primary_email)`,
 * NOT the silver `contacts.id`. Silver rows are delete-and-reinserted on every
 * re-promotion, so their uuid changes; keying on the volatile uuid would leak a
 * re-serve after any re-promote. The gold `sendable_contacts` view already
 * requires a non-null valid email, so every servable contact has a stable email.
 * `contact_id` is stored for provenance only (may be stale after a re-promote).
 *
 * UNIQUE(brand_id, email) is the permanent no-re-serve guarantee AND the
 * concurrency guard: two parallel serve-next calls that race on the same email
 * cannot both insert. `email` is stored already-lowercased (silver normalizes it).
 */
export const contactServes = pgTable(
  "contact_serves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    // Provenance only — the silver row served at the time. May be stale after a
    // re-promote (that row's uuid changes); the suppression key is `email`.
    contactId: uuid("contact_id").notNull(),
    // Durable atomic-member identity = lower(primary_email). Suppression key.
    email: text("email").notNull(),
    // The org run under which this serve happened.
    servedRunId: text("served_run_id").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contact_serves_brand_email_uq").on(table.brandId, table.email),
    index("contact_serves_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

export type ContactUpload = typeof contactUploads.$inferSelect;
export type NewContactUpload = typeof contactUploads.$inferInsert;
export type ContactRowRaw = typeof contactRowsRaw.$inferSelect;
export type NewContactRowRaw = typeof contactRowsRaw.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactServe = typeof contactServes.$inferSelect;
export type NewContactServe = typeof contactServes.$inferInsert;
