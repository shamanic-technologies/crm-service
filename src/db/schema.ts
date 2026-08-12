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
 * TWO sources feed this table, discriminated by `source`:
 *  - 'csv'    — an uploaded CRM export (OUTBOUND prospects). Natural key
 *               (org_id, brand_id, lower(primary_email)).
 *  - 'matrix' — a direct message received over Matrix (INBOUND people who wrote
 *               first). Natural key (org_id, brand_id, channel, channel_handle):
 *               a WhatsApp DM yields a phone/handle and NO email, so the email
 *               key does not bite.
 *
 * Both unique keys are expression / partial indexes created in hand-written
 * migrations (drizzle-kit emits neither). Rows with a null email are kept but not
 * deduped by email (Postgres treats nulls as distinct).
 *
 * `source` is the discriminator the gold `sendable_contacts` view keys on: only
 * 'csv' contacts are sendable. A Matrix contact is already in conversation with
 * the user — cold-emailing them is the exact outcome the guard prevents.
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

    // 'csv' | 'matrix'. NOT NULL DEFAULT 'csv' so every pre-existing row reads as
    // CSV-sourced and stays sendable — the gold view can never drop a row that
    // was sendable before this column existed.
    source: text("source").notNull().default("csv"),
    // Matrix only: 'whatsapp' | 'telegram' | 'discord'. Null for CSV contacts.
    channel: text("channel"),
    // Matrix only: the counterpart's bridged Matrix user id (the durable handle
    // identity of the person who wrote in). Null for CSV contacts.
    channelHandle: text("channel_handle"),

    // Source attribution. CSV contacts carry upload + row; Matrix contacts carry
    // the connection. Exactly one side is populated, so both are nullable.
    sourceUploadId: uuid("source_upload_id"),
    sourceRowId: uuid("source_row_id"),
    sourceConnectionId: uuid("source_connection_id"),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("contacts_org_brand_idx").on(table.orgId, table.brandId),
    index("contacts_org_brand_source_idx").on(table.orgId, table.brandId, table.source),
    // Second natural key, for the Matrix source. Postgres treats NULLs as
    // distinct, so every CSV row (channel + channel_handle both null) is exempt
    // — no partial predicate needed and no existing row can collide.
    uniqueIndex("contacts_org_brand_channel_handle_uq").on(
      table.orgId,
      table.brandId,
      table.channel,
      table.channelHandle,
    ),
  ],
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

/**
 * BRONZE — one row per (org, brand, channel) Matrix connection.
 *
 * The analogue of `contact_uploads` for the Matrix source: it IS the source
 * artifact. A connection names the bridged channel, the account whose DMs are
 * mirrored, and holds the `/sync` cursor for that channel.
 *
 * `since_token` is the Matrix `next_batch` cursor. It is advanced in the SAME
 * transaction as the events it covers, so a crash mid-sync re-reads the batch
 * instead of silently dropping messages.
 *
 * `counterpart_prefix` is the bridge's ghost-user MXID prefix (e.g. `@whatsapp_`).
 * A sync batch from one access token carries rooms from every bridge, so the
 * prefix is what routes an event to exactly one connection.
 */
export const matrixConnections = pgTable(
  "matrix_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),

    // 'whatsapp' | 'telegram' | 'discord'
    channel: text("channel").notNull(),
    // The MXID of the user's OWN bridged account. Sender == this → outbound.
    matrixUserId: text("matrix_user_id").notNull(),
    // The org user who created this connection. The sync runs in a cron with NO
    // inbound identity headers, so the identity the org run + the chat-service
    // lead reading are billed under must be PERSISTED here at create time — a
    // request-scoped header does not survive that async boundary.
    createdByUserId: text("created_by_user_id").notNull(),
    // Bridge ghost-user MXID prefix that identifies this channel's rooms.
    counterpartPrefix: text("counterpart_prefix").notNull(),

    // Matrix /sync cursor. Null = never synced (next pass does an initial sync).
    sinceToken: text("since_token"),

    // 'active' | 'paused' | 'error'
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("matrix_connections_org_brand_channel_uq").on(
      table.orgId,
      table.brandId,
      table.channel,
    ),
    index("matrix_connections_status_idx").on(table.status),
  ],
);

/**
 * BRONZE — verbatim, append-only mirror of Matrix events.
 *
 * One row per event, `payload` = the event JSON exactly as the homeserver sent
 * it. The Matrix `event_id` is globally unique, so it IS the idempotency key —
 * no content hash needed (unlike the CSV path, where the same bytes can be
 * re-uploaded). Re-running a sync pass inserts nothing new.
 *
 * Room metadata (who the counterpart is, their display name) arrives as Matrix
 * STATE events (`m.room.member`), so it lands in THIS table too — there is no
 * separate room table.
 *
 * INGESTION FLOOR: events with `origin_server_ts` before MATRIX_INGESTION_FLOOR
 * are never written here. See CLAUDE.md — bronze normally means "everything",
 * and this is the one deliberate exception.
 */
export const matrixRawEvents = pgTable(
  "matrix_raw_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => matrixConnections.id, { onDelete: "cascade" }),

    // Globally unique Matrix event id — the natural idempotency key.
    eventId: text("event_id").notNull(),
    roomId: text("room_id").notNull(),
    sender: text("sender").notNull(),
    // 'm.room.message' | 'm.room.member' | any other mirrored type.
    eventType: text("event_type").notNull(),
    // State events carry a state_key; message events do not.
    stateKey: text("state_key"),
    originServerTs: timestamp("origin_server_ts", { withTimezone: true }).notNull(),

    payload: jsonb("payload").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("matrix_raw_events_event_id_uq").on(table.eventId),
    index("matrix_raw_events_room_idx").on(table.connectionId, table.roomId, table.originServerTs),
    index("matrix_raw_events_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * SILVER — one row per (contact, channel) conversation.
 *
 * A pure, deterministic AGGREGATION over `matrix_raw_events` — zero LLM. Knowing
 * who wrote to you, when, and how many times needs no model.
 *
 * `last_event_id` doubles as the freshness watermark the gold leads layer
 * compares against: a lead is recomputed only when this moved.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => matrixConnections.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),

    channel: text("channel").notNull(),
    // Most recent room this conversation was seen in (provenance).
    roomId: text("room_id").notNull(),

    firstMessageAt: timestamp("first_message_at", { withTimezone: true }).notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull(),
    inboundCount: integer("inbound_count").notNull(),
    outboundCount: integer("outbound_count").notNull(),

    // Watermark: the last message event folded into this aggregate.
    lastEventId: text("last_event_id").notNull(),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversations_contact_channel_uq").on(table.contactId, table.channel),
    index("conversations_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * GOLD — the business view of a Matrix conversation: what the LLM reads out of
 * the thread.
 *
 * Materialized (not a view) because the value comes from an LLM call, not from
 * SQL. Fully rebuildable: truncate this table, re-run the sync, and every row is
 * reproduced from bronze (bronze → conversations → leads).
 *
 * `computed_through_event_id` is the watermark. A row is recomputed ONLY when
 * `conversations.last_event_id` has moved past it — otherwise every 5-minute
 * cron would re-bill the LLM for unchanged threads.
 */
export const matrixLeads = pgTable(
  "matrix_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull(),

    // Fixed enum — see LEAD_STATUSES in src/lib/matrix/leads.ts.
    status: text("status").notNull(),
    nextStep: text("next_step").notNull(),
    // Estimated deal value in whole USD, as read from the thread.
    estimatedValueUsd: integer("estimated_value_usd").notNull(),
    summary: text("summary").notNull(),

    // Provenance: the conversation watermark this reading was computed through,
    // the model that produced it, and the org run it was billed under.
    computedThroughEventId: text("computed_through_event_id").notNull(),
    model: text("model").notNull(),
    runId: text("run_id").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("matrix_leads_conversation_uq").on(table.conversationId),
    index("matrix_leads_org_brand_idx").on(table.orgId, table.brandId),
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
export type MatrixConnection = typeof matrixConnections.$inferSelect;
export type NewMatrixConnection = typeof matrixConnections.$inferInsert;
export type MatrixRawEvent = typeof matrixRawEvents.$inferSelect;
export type NewMatrixRawEvent = typeof matrixRawEvents.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type MatrixLead = typeof matrixLeads.$inferSelect;
export type NewMatrixLead = typeof matrixLeads.$inferInsert;
