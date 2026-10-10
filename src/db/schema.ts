import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  numeric,
  doublePrecision,
  boolean,
  bigint,
  bigserial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

    // The id this contact carries in the SOURCE system, when the source has one
    // of its own (GoHighLevel's contact id). Null for CSV (a spreadsheet row has
    // no durable vendor id) and for Matrix (whose identity is channel_handle).
    // (org, brand, source, external_id) is a unique index — Postgres treats NULLs
    // as distinct, so both older sources are exempt from it.
    externalId: text("external_id"),

    // ── What the SOURCE holds about the person beyond identity ──────────────
    //
    // Every column below is nullable and written only when the source actually
    // reports it: absent stays NULL, never a default, never a guess. They exist
    // because identity alone cannot answer "is this CRM record the same human as
    // one of our leads" — measured on the first GoHighLevel customer, 454 of the
    // 455 contacts carrying a company name carry NO email, so company is the only
    // non-name signal those records have anywhere.
    //
    // They are generic on purpose (a CSV export names a company too); today only
    // the GoHighLevel derivation populates them.
    companyName: text("company_name"),
    website: text("website"),

    city: text("city"),
    // The source's own word for the sub-national region — a state, a province, a
    // county. Kept verbatim, not normalized against any list of ours.
    stateRegion: text("state_region"),
    // Verbatim. GoHighLevel reports ISO-3166 alpha-2 in practice, but nothing
    // here validates or converts it — what the source said is what is stored.
    country: text("country"),
    postalCode: text("postal_code"),
    streetAddress: text("street_address"),

    // Where the record came from, in the source's OWN vocabulary. Free text per
    // customer ("STripe Test ", "order_form") — never mapped to a vocabulary of
    // ours, exactly as the pipeline stage names are not.
    leadSource: text("lead_source"),
    // The source's own classification of the record ('lead', 'customer', …).
    // Verbatim, uninterpreted.
    contactType: text("contact_type"),
    // The source's labels, as an array, verbatim. NULL when the source reports no
    // tags field at all; `[]` when it reports an empty one — those differ.
    tags: jsonb("tags"),

    // FIRST-touch attribution, when the source records one. Only the three fields
    // that say where the person came FROM are lifted; the raw attribution blob in
    // bronze also carries IPs and user agents, which are not re-served.
    originMedium: text("origin_medium"),
    originUrl: text("origin_url"),
    originReferrer: text("origin_referrer"),

    // When the SOURCE created and last touched its own record — not when we
    // mirrored it (`last_rebuilt_at` is ours).
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),

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
    // Keyed per CONNECTION too: a brand can link several accounts on one
    // channel (two WhatsApp numbers), and the same counterpart writing to both
    // is one contact per account, each removed with its own account on unlink.
    // The person layer joins them back (same stable handle = same person).
    uniqueIndex("contacts_org_brand_conn_channel_handle_uq").on(
      table.orgId,
      table.brandId,
      table.sourceConnectionId,
      table.channel,
      table.channelHandle,
    ),
    // Third natural key, for any source that carries its OWN durable record id
    // (GoHighLevel). NULLs are distinct, so CSV and Matrix rows never collide here.
    uniqueIndex("contacts_org_brand_source_external_uq").on(
      table.orgId,
      table.brandId,
      table.source,
      table.externalId,
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

    // Set ONLY on a connection opened by a self-serve link (`matrix_links`): the
    // access token of the brand's OWN dedicated Matrix account, so its /sync sees
    // that brand's rooms and nobody else's. NULL = a connection registered by hand
    // against the platform account (`MATRIX_ACCESS_TOKEN`). Never served.
    accessToken: text("access_token"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Several accounts per (org, brand, channel): each linked account is its
    // own dedicated Matrix account, so the account is part of the key.
    uniqueIndex("matrix_connections_org_brand_channel_account_uq").on(
      table.orgId,
      table.brandId,
      table.channel,
      table.matrixUserId,
    ),
    index("matrix_connections_status_idx").on(table.status),
  ],
);

/**
 * OPERATIONAL — one row per (org, brand, channel) self-serve link: a signed-in
 * user linking their WhatsApp (or Telegram) account to the brand from the
 * dashboard, with no staff step.
 *
 * Isolation: every link gets its OWN dedicated Matrix account
 * (`@crm_<random>:<server>`), created through crm-service's appservice. The
 * bridge keeps one login per Matrix account and puts that login's rooms in that
 * account only, so one brand's WhatsApp can never reach another brand's /sync.
 *
 * The row carries what the dashboard polls while the user scans: the CURRENT
 * QR payload or pairing code (it refreshes on WhatsApp's schedule), and the
 * bridge's own error code + message when the link fails. Once linked, the
 * brand's `matrix_connections` row exists and syncs like any other.
 */
export const matrixLinks = pgTable(
  "matrix_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    // 'whatsapp' | 'telegram' | 'discord'
    channel: text("channel").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),

    // The brand's dedicated Matrix account. NULL after an unlink: the next link
    // gets a fresh account, so nothing of the old login can resurface.
    matrixUserId: text("matrix_user_id"),

    // 'waiting' | 'linked' | 'failed' | 'unlinked'
    status: text("status").notNull(),
    // 'qr' | 'phone'
    method: text("method").notNull(),

    // The bridge's in-flight login process + the step it is on. Every write by
    // the background driver is conditioned on `bridge_process_id`, so a restart
    // or an unlink makes a stale driver stop instead of overwriting.
    bridgeProcessId: text("bridge_process_id"),
    bridgeStepId: text("bridge_step_id"),

    // What the user must act on right now: 'qr' (render `display_data` as a QR
    // code) or 'code' (type `display_data` into WhatsApp › Linked devices).
    displayType: text("display_type"),
    displayData: text("display_data"),
    instructions: text("instructions"),
    displayIssuedAt: timestamp("display_issued_at", { withTimezone: true }),

    // The account that linked, as the bridge names it (a WhatsApp phone number).
    remoteLoginId: text("remote_login_id"),
    remoteName: text("remote_name"),

    // The bridge step waiting for the USER to answer (a LinkedIn login form, an
    // emailed code, cookies): the bridge's own step verbatim (ids, field ids,
    // types, labels). Null when no input is awaited. What the user types is
    // relayed to the bridge and never stored.
    inputStep: jsonb("input_step"),

    // The bridge's OWN error code + message, verbatim.
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    connectionId: uuid("connection_id").references(() => matrixConnections.id, {
      onDelete: "set null",
    }),
    runId: text("run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // NOT unique: a brand links N accounts per channel, one row (and one
    // dedicated Matrix account) each. A link is addressed by its id.
    index("matrix_links_org_brand_channel_idx").on(table.orgId, table.brandId, table.channel),
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

/**
 * BRONZE — one row per (org, brand) GoHighLevel connection.
 *
 * The analogue of `contact_uploads` / `matrix_connections`: it IS the source
 * artifact. It names the GoHighLevel sub-account ("location") whose records are
 * mirrored, and holds the connection's health.
 *
 * THE CREDENTIAL IS NOT HERE. crm-service never stores a GoHighLevel Private
 * Integration Token; key-service holds it, scoped to this exact (org, brand)
 * pair, and every sync resolves it at call time. There is deliberately no token
 * column to accidentally write one into.
 *
 * `location_id` is supplied by the customer alongside the token: a Private
 * Integration Token is an opaque static bearer and GoHighLevel publishes no way
 * to read the target sub-account out of it (verified against the v2 docs,
 * 2026-09-19), so the id cannot be derived and must be stated.
 *
 * `created_by_user_id` is persisted at create time ON PURPOSE — the sync runs
 * from a cron with NO inbound identity headers, and the org run it opens must
 * still be attributed. A request-scoped header does not survive that async
 * boundary; the row is the carrier.
 */
export const ghlConnections = pgTable(
  "ghl_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),

    // The GoHighLevel sub-account ("location") id this connection mirrors.
    locationId: text("location_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),

    // 'active' | 'paused' | 'error'
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // ONE GoHighLevel account per brand.
    uniqueIndex("ghl_connections_org_brand_uq").on(table.orgId, table.brandId),
    index("ghl_connections_status_idx").on(table.status),
  ],
);

/**
 * BRONZE — verbatim, append-only-in-spirit mirror of GoHighLevel records.
 *
 * One row per (connection, kind, external_id), `payload` = the record JSON
 * exactly as GoHighLevel sent it. GoHighLevel's own record id IS the idempotency
 * key, so a re-run of a sync writes nothing new.
 *
 * `content_hash` (sha256 of the canonical payload) is what keeps a re-sync from
 * CHURNING rows that have not changed: the upsert only writes when the hash
 * differs, so `mirrored_at` and the derived silver rows stay still for unchanged
 * records. That is the difference between "does not duplicate" and "does not
 * touch", and the acceptance criteria ask for both.
 *
 * Everything downstream (contacts, opportunities, pipelines) is derived from
 * THIS table, so wiping the derived layers and rebuilding needs no vendor call.
 */
export const ghlRawRecords = pgTable(
  "ghl_raw_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    // 'contact' | 'opportunity' | 'pipeline' | 'calendar' | 'appointment' | 'form' | 'form_submission' — see GHL_RECORD_KINDS.
    kind: text("kind").notNull(),
    // GoHighLevel's own id for the record. The natural idempotency key.
    externalId: text("external_id").notNull(),
    // sha256 of the canonical payload — the no-churn guard.
    contentHash: text("content_hash").notNull(),

    payload: jsonb("payload").notNull(),
    mirroredAt: timestamp("mirrored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ghl_raw_records_conn_kind_external_uq").on(
      table.connectionId,
      table.kind,
      table.externalId,
    ),
    index("ghl_raw_records_org_brand_kind_idx").on(table.orgId, table.brandId, table.kind),
  ],
);

/**
 * SILVER — one row per GoHighLevel pipeline, with its ordered stages.
 *
 * Deterministically derived from the mirrored `kind='pipeline'` records — zero
 * LLM. The stage list is what lets the opportunities read group things "the way
 * GoHighLevel groups them" instead of by opaque stage ids.
 */
export const ghlPipelines = pgTable(
  "ghl_pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    // Ordered [{ id, name, position }] as GoHighLevel lists them.
    stages: jsonb("stages").notNull(),

    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ghl_pipelines_conn_external_uq").on(table.connectionId, table.externalId),
    index("ghl_pipelines_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * SILVER — one row per GoHighLevel opportunity (the sales pipeline itself).
 *
 * Deterministically derived from the mirrored `kind='opportunity'` records, with
 * the pipeline and stage NAMES resolved against `ghl_pipelines`. Whatever
 * GoHighLevel reports is what is stored: its pipeline, its stage, its status and
 * its monetary value, none of it re-interpreted.
 *
 * `contact_id` links to the silver contact when GoHighLevel named one we have
 * mirrored; it stays null otherwise rather than inventing an attachment.
 */
export const ghlOpportunities = pgTable(
  "ghl_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    externalId: text("external_id").notNull(),
    name: text("name").notNull(),

    pipelineExternalId: text("pipeline_external_id"),
    pipelineName: text("pipeline_name"),
    stageExternalId: text("stage_external_id"),
    stageName: text("stage_name"),

    // GoHighLevel's own status vocabulary: open | won | lost | abandoned | ...
    status: text("status"),
    // Whole-currency amount as GoHighLevel reports it. Numeric, not integer —
    // GoHighLevel returns fractional values.
    monetaryValue: numeric("monetary_value"),

    assignedTo: text("assigned_to"),
    // GoHighLevel's contact id, kept even when no silver contact matched.
    externalContactId: text("external_contact_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),

    ghlCreatedAt: timestamp("ghl_created_at", { withTimezone: true }),
    ghlUpdatedAt: timestamp("ghl_updated_at", { withTimezone: true }),

    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ghl_opportunities_conn_external_uq").on(table.connectionId, table.externalId),
    index("ghl_opportunities_org_brand_idx").on(table.orgId, table.brandId),
    index("ghl_opportunities_pipeline_idx").on(table.connectionId, table.pipelineExternalId),
  ],
);

/**
 * SILVER — one row per GoHighLevel calendar APPOINTMENT.
 *
 * Deterministically derived from the mirrored `kind='appointment'` records.
 * This is the real, dated source of a booked meeting: `booked_at` is when the
 * appointment was CREATED in GoHighLevel, `starts_at` is when the meeting is
 * scheduled, and `status` is GoHighLevel's own fixed appointment vocabulary
 * (`new | confirmed | cancelled | showed | noshow | invalid`), verbatim.
 *
 * `contact_id` links to the silver contact when GoHighLevel named one we have
 * mirrored; it stays null otherwise rather than inventing an attachment.
 */
export const ghlAppointments = pgTable(
  "ghl_appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    externalId: text("external_id").notNull(),
    calendarExternalId: text("calendar_external_id"),
    calendarName: text("calendar_name"),
    title: text("title"),

    // GoHighLevel's own appointment status, verbatim.
    status: text("status"),

    // GoHighLevel's contact id, kept even when no silver contact matched.
    externalContactId: text("external_contact_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),

    // When the appointment was created in GoHighLevel — the booking moment.
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    ghlUpdatedAt: timestamp("ghl_updated_at", { withTimezone: true }),

    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ghl_appointments_conn_external_uq").on(table.connectionId, table.externalId),
    index("ghl_appointments_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * SILVER — one row per GoHighLevel FORM SUBMISSION: a person submitted one of
 * the customer's forms (a funnel opt-in, a Meta Ads lead form relayed into
 * GoHighLevel, a booking form...).
 *
 * Deterministically derived from the mirrored `kind='form_submission'` records,
 * with the form's NAME resolved from the mirrored `kind='form'` records.
 * `submitted_at` is GoHighLevel's own timestamp for the submission, or NULL when
 * it gave none with a zone. What the person typed stays in bronze.
 *
 * `contact_id` links to the silver contact when GoHighLevel named one we have
 * mirrored; it stays null otherwise rather than inventing an attachment.
 */
export const ghlFormSubmissions = pgTable(
  "ghl_form_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    externalId: text("external_id").notNull(),
    formExternalId: text("form_external_id"),
    // The customer's own name for the form, verbatim.
    formName: text("form_name"),

    // GoHighLevel's contact id, kept even when no silver contact matched.
    externalContactId: text("external_contact_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ghl_form_submissions_conn_external_uq").on(table.connectionId, table.externalId),
    index("ghl_form_submissions_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * APPEND-ONLY — every stage or status an opportunity was OBSERVED in, with the
 * date GoHighLevel itself gives for entering it.
 *
 * GoHighLevel keeps no stage history: an opportunity carries only its CURRENT
 * stage plus `lastStageChangeAt` / `lastStatusChangeAt`. So the moment it moves
 * on, when it entered the previous stage is gone. This table is where that
 * history accumulates FROM THE FIRST SYNC ONWARDS. It is never rewritten and it
 * cannot be rebuilt from bronze (bronze keeps the latest payload only), so it is
 * a record in its own right, like the bronze tables.
 *
 * A row is appended when the (value, changed_at) pair differs from the latest
 * row of the same kind for that opportunity — so a re-sync of an unchanged
 * opportunity appends nothing, and a stage left and re-entered is recorded.
 *
 * `changed_at` is GoHighLevel's own timestamp, or NULL when it gives none — it is
 * never filled with the observation time. `observed_at` is when we saw it.
 * The past before the first sync is lost and is not fabricated: the first row of
 * an opportunity is its CURRENT stage, dated by GoHighLevel's `lastStageChangeAt`.
 */
export const ghlOpportunityHistory = pgTable(
  "ghl_opportunity_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    opportunityExternalId: text("opportunity_external_id").notNull(),
    externalContactId: text("external_contact_id"),

    // 'stage' | 'status'
    kind: text("kind").notNull(),
    // kind='stage': the stage id. kind='status': GoHighLevel's status, verbatim.
    value: text("value"),

    // Names as they were when observed — stage names are the customer's free text.
    pipelineExternalId: text("pipeline_external_id"),
    pipelineName: text("pipeline_name"),
    stageName: text("stage_name"),

    changedAt: timestamp("changed_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ghl_opportunity_history_conn_opp_idx").on(
      table.connectionId,
      table.opportunityExternalId,
      table.kind,
    ),
    index("ghl_opportunity_history_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * What each of a customer's free-text pipeline stages MEANS in our funnel
 * vocabulary — decided ONCE by a judgment model (Jev, through chat-service
 * /orgs/judgments) and recorded with its confidence.
 *
 * Keyed on (connection, stage id, stage NAME): the same stage resolves the same
 * way on every read, and a stage is re-decided only when a NEW name appears for
 * it (a rename is a different statement by the customer). `model` and `run_id`
 * are the provenance of the decision. There is no string matching in code: this
 * table is the only source of a stage's meaning.
 */
export const ghlStageMeanings = pgTable(
  "ghl_stage_meanings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ghlConnections.id, { onDelete: "cascade" }),

    pipelineExternalId: text("pipeline_external_id"),
    pipelineName: text("pipeline_name"),
    stageExternalId: text("stage_external_id").notNull(),
    stageName: text("stage_name").notNull(),

    // See STAGE_MEANINGS: meeting_booked | meeting_attended | meeting_not_held
    // | sale | deal_lost | none
    meaning: text("meaning").notNull(),
    // The judgment model's confidence in `meaning` (0..1) and its full
    // distribution over the vocabulary. Below STAGE_MEANING_MIN_CONFIDENCE the
    // meaning is recorded but not served as evidence.
    confidence: doublePrecision("confidence").notNull(),
    probabilities: jsonb("probabilities").notNull(),

    model: text("model").notNull(),
    runId: text("run_id").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ghl_stage_meanings_conn_stage_name_uq").on(
      table.connectionId,
      table.stageExternalId,
      table.stageName,
    ),
    index("ghl_stage_meanings_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

/**
 * GOLD — the merged PERSON layer: one person, every channel, one thread.
 *
 * A people scope is one (org, brand) whose people are indexed. It is the source
 * artifact of the layer, like `ghl_connections` / `matrix_connections`, and it
 * carries `created_by_user_id` ON PURPOSE: the rebuild runs from a cron with no
 * inbound identity headers, and the org run + every sibling read it makes must
 * still be attributed. A request-scoped header does not survive that boundary.
 *
 * `source_reads` records, per source, what the LAST build could read: whether
 * the source is connected, how many people it yielded, what the source itself
 * counts, and why a read failed. "not connected", "connected but nobody" and
 * "failed to read" stay three different answers.
 */
export const peopleScopes = pgTable(
  "people_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),

    // pending (never built) -> built | error
    status: text("status").notNull().default("pending"),
    sourceReads: jsonb("source_reads"),
    lastError: text("last_error"),
    lastBuiltAt: timestamp("last_built_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),
    // instantly-service outreach fact feed position this scope's freshness watch has read up to.
    outreachFactsCursor: text("outreach_facts_cursor"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("people_scopes_org_brand_uq").on(table.orgId, table.brandId)],
);

/**
 * GOLD — one row per merged person of a scope, fully re-derived on every build
 * from the sources' served reads (never their bronze).
 *
 * `person_key` is the public identity: the smallest email key of the person
 * (else the smallest phone key, else the source-local key). It is stable for as
 * long as the person keeps that address, so a consumer can hold it across
 * rebuilds; `identity_keys` holds EVERY key of the person, so any one of them
 * opens the same person.
 *
 * Merging happens only on positive evidence (a record holding two keys at
 * once). There is no name matching anywhere.
 */
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => peopleScopes.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),

    personKey: text("person_key").notNull(),
    // Every identity key of the person: "email:a@b.com", "phone:+336...", or a
    // source-local key ("matrix:<contactId>") for someone with neither.
    identityKeys: jsonb("identity_keys").notNull(),
    displayName: text("display_name"),
    company: text("company"),
    emails: jsonb("emails").notNull(),
    phones: jsonb("phones").notNull(),
    // The distinct sources the person appears on.
    sources: jsonb("sources").notNull(),
    // One entry per source record this person was merged from.
    presences: jsonb("presences").notNull(),
    // The evidence that merged two keys (a Google / GoHighLevel / CSV contact
    // holding both, a lead-service "same person" ruling).
    mergeEvidence: jsonb("merge_evidence").notNull(),

    firstActivityAt: timestamp("first_activity_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),

    // The ONE state, decided by the source that states it (see people/state.ts).
    state: text("state").notNull(),
    stateSource: text("state_source").notNull(),
    stateDetail: jsonb("state_detail"),

    // Jev said EVERY address of the person is an automated sender (a digest, a
    // notification, a no-reply, a newsletter): hidden from the list by default.
    // The verdicts that decided it ride in `automated_verdict` (see
    // people/automated.ts). A person never judged is not automated.
    automated: boolean("automated").notNull().default(false),
    automatedVerdict: jsonb("automated_verdict"),

    // Jev said none of the person's conversations is about THIS brand (personal
    // life, or another business of the owner): hidden from the list by default.
    // Only a person known from a personal channel ALONE (Gmail, Matrix) can be;
    // see people/relevance.ts. `relevance` = the per-conversation verdicts,
    // `offer_ids` = the brand's offers those conversations are about.
    notBusiness: boolean("not_business").notNull().default(false),
    relevance: jsonb("relevance"),
    offerIds: jsonb("offer_ids").notNull().default([]),

    // CRM contacts lead-service paired with one of our leads on a GUESS
    // (`toConfirm`): shown beside the person, never merged into it.
    possibleLeads: jsonb("possible_leads").notNull().default([]),

    // The person's OPAQUE id (a random uuid, no personal data), stable across
    // rebuilds: carried over through `person_ids` (see people/person-id.ts).
    // Null only on a row built before the column existed.
    personId: uuid("person_id"),

    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("people_scope_person_key_uq").on(table.scopeId, table.personKey),
    index("people_org_brand_activity_idx").on(table.orgId, table.brandId, table.lastActivityAt),
    index("people_org_brand_person_id_idx").on(table.orgId, table.brandId, table.personId),
  ],
);

/**
 * Which opaque person id each identity key belongs to, per (org, brand). Unlike
 * `people` it is NEVER wiped by a build: it is the memory that gives the same
 * person the same `person_id` tomorrow (and again if they vanish and come back).
 * A build points every key of a person at that person's id.
 */
export const personIds = pgTable(
  "person_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    identityKey: text("identity_key").notNull(),
    personId: uuid("person_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("person_ids_org_brand_key_uq").on(table.orgId, table.brandId, table.identityKey),
    index("person_ids_org_brand_person_idx").on(table.orgId, table.brandId, table.personId),
  ],
);

/**
 * A person id RETIRED by a merge (two people found to be one: the merged person
 * keeps the older id) points at the id that absorbed it, so a link holding the
 * retired id still opens the person.
 */
export const personIdAliases = pgTable(
  "person_id_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    retiredId: uuid("retired_id").notNull(),
    personId: uuid("person_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("person_id_aliases_org_brand_retired_uq").on(table.orgId, table.brandId, table.retiredId)],
);

/**
 * SEARCH INDEX — one row per message an indexing UNIT holds, so a brand owner
 * can search what was said without the dashboard fanning out to every source.
 *
 * Only the sources whose text lives in a SIBLING are indexed here (Gmail via
 * google-service's per-address conversation, cold email via instantly-service's
 * per-(campaign, address) conversation). Matrix text is already crm-service's
 * own bronze and is searched in place. Nothing here is a source of truth: the
 * timeline still reads live, and the whole index can be dropped and rebuilt.
 *
 * `address` is the person's lower-cased email the unit was read for; a search
 * hit reaches the person through `people.emails`, so a rebuild of `people`
 * (which replaces every row) never orphans the index. `search_text` is
 * subject + body, trigram-indexed for substring search.
 */
export const peopleMessageTexts = pgTable(
  "people_message_texts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => peopleScopes.id, { onDelete: "cascade" }),
    // gmail | instantly
    source: text("source").notNull(),
    // gmail: the address; instantly: "<campaignId>:<address>"
    unit: text("unit").notNull(),
    address: text("address").notNull(),
    messageKey: text("message_key").notNull(),
    at: timestamp("at", { withTimezone: true }),
    // inbound | outbound | other
    direction: text("direction"),
    subject: text("subject"),
    body: text("body"),
    searchText: text("search_text").notNull(),
    // The full timeline item as the person thread serves it (null on rows stored in format 1).
    item: jsonb("item"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("people_message_texts_unit_message_uq").on(table.scopeId, table.source, table.unit, table.messageKey),
    // One message is stored ONCE per address, whichever unit read it: instantly-service answers a
    // campaign's whole family, so two campaign units of one lead return the same thread.
    uniqueIndex("people_message_texts_address_message_uq").on(table.scopeId, table.source, table.address, table.messageKey),
    index("people_message_texts_scope_address_idx").on(table.scopeId, table.address),
  ],
);

/**
 * One row per indexing unit of a scope: what was read, when, through which
 * activity. A unit is re-read when the person's last activity moved past
 * `activity_at`, when its last read failed, or once a day (google-service
 * cleans bodies after the fact). `status` is `ok` | `failed` — a failed read is
 * recorded with its error and its old messages kept, never turned into "no
 * messages".
 */
export const peopleMessageUnits = pgTable(
  "people_message_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => peopleScopes.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    unit: text("unit").notNull(),
    address: text("address").notNull(),
    activityAt: timestamp("activity_at", { withTimezone: true }),
    status: text("status").notNull(),
    error: text("error"),
    messages: integer("messages").notNull().default(0),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    runId: text("run_id").notNull(),
    // Stored row shape (see people/search.ts STORE_FORMAT); an older one is re-read.
    format: integer("format").notNull().default(1),
    // When the freshness watch learned the source thread gained a message (people/freshness.ts).
    changedAt: timestamp("changed_at", { withTimezone: true }),
    // The source's own marker of that change (Gmail: the correspondent's lastMessageAt).
    changeMark: text("change_mark"),
  },
  (table) => [uniqueIndex("people_message_units_uq").on(table.scopeId, table.source, table.unit)],
);

/**
 * What lead-service last said about one email of a brand: its standing (or that
 * the address is not one of our leads). A cache of lead-service's answer, never
 * a grade of ours, so a 5-minute rebuild does not ask lead-service about every
 * person every time. Re-asked once it is older than the TTL or older than the
 * person's last activity.
 */
export const leadStandingObservations = pgTable(
  "lead_standing_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    email: text("email").notNull(),
    found: boolean("found").notNull(),
    // lead-service's answer, verbatim where it matters (standing, row ids).
    payload: jsonb("payload"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lead_standing_observations_org_brand_email_uq").on(
      table.orgId,
      table.brandId,
      table.email,
    ),
  ],
);

/**
 * Whether one email address is a HUMAN or an AUTOMATED sender, as Jev judged it
 * (chat-service `POST /orgs/judgments`, one `choice` question per address, the
 * address and what the mail it sent carries as input). Never a regex of ours.
 *
 * Keyed per (org, email): an address does not change nature, so it is judged
 * ONCE and every later build reads the record — no model call per page read or
 * per rebuild. Gmail is connected per ORG, so the org is the scope. `confidence`
 * and `probabilities` are Jev's own; `input` is exactly what Jev was shown.
 */
export const senderVerdicts = pgTable(
  "sender_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    email: text("email").notNull(),
    // human | automated
    verdict: text("verdict").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    probabilities: jsonb("probabilities").notNull(),
    input: jsonb("input").notNull(),
    model: text("model").notNull(),
    runId: text("run_id").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sender_verdicts_org_email_uq").on(table.orgId, table.email)],
);

/**
 * Whether one conversation from an owner's PERSONAL channel (a Gmail
 * correspondent, a Matrix-bridged DM) is about THIS brand, as Jev judged it
 * (chat-service `POST /orgs/judgments`): `topic` = personal | other_business |
 * this_brand, plus one yes/no per active offer of the brand. See
 * people/relevance.ts.
 *
 * Keyed per (org, brand, conversation): Gmail is connected per ORG and shared
 * by every brand of the org, so the same thread is judged once per brand.
 * Re-judged only when the conversation moved (`judged_through` = its last
 * activity / last event id) or the brand's context changed (`context_hash`).
 */
export const conversationVerdicts = pgTable(
  "conversation_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    // gmail:<address> | matrix:<conversation id>
    conversationKey: text("conversation_key").notNull(),
    source: text("source").notNull(),
    // readable = Jev judged it; none = no word a person wrote is left once the
    // bridge's own notices and uncaptioned media are dropped: nothing to judge,
    // so every judgment column below is NULL (people/relevance.ts).
    content: text("content").notNull().default("readable"),
    // personal | other_business | this_brand
    topic: text("topic"),
    confidence: doublePrecision("confidence"),
    probabilities: jsonb("probabilities"),
    // Jev's probability that the conversation is about this brand.
    brandProbability: doublePrecision("brand_probability"),
    // offerId -> Jev's yes-probability; offer_ids = the ones at or above the bar.
    offerScores: jsonb("offer_scores"),
    offerIds: jsonb("offer_ids").notNull(),
    contextHash: text("context_hash").notNull(),
    judgedThrough: text("judged_through").notNull(),
    input: jsonb("input").notNull(),
    model: text("model"),
    runId: text("run_id").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_verdicts_org_brand_key_uq").on(table.orgId, table.brandId, table.conversationKey),
  ],
);

/**
 * THE FACT FEED — every dated, UNTAGGED thing the client's own accounts say
 * happened to a person, in one total order (`feed_seq`). lead-service copies it
 * verbatim (`GET /internal/people/facts`) and owns what it MEANS (the tags).
 * See people/facts.ts.
 *
 * Append-only for every SERVED column: a fact is never rewritten; a correction
 * is a `withdrawn` fact plus a new one. Three columns are bookkeeping, never
 * served: `live` (false once withdrawn), `owner_person_key` (who the fact
 * belongs to NOW, to detect merges/splits) and the `subject_*` columns (how to
 * find that owner again).
 *
 * There is deliberately NO foreign key to any connection or scope: disconnecting
 * a source STOPS its facts, it never deletes or withdraws the ones already
 * emitted (owner decision 2026-10-08).
 */
export const peopleFacts = pgTable(
  "people_facts",
  {
    feedSeq: bigserial("feed_seq", { mode: "number" }).primaryKey(),
    factId: uuid("fact_id").notNull().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),

    personKey: text("person_key").notNull(),
    emails: jsonb("emails").notNull(),
    phones: jsonb("phones").notNull(),
    fullName: text("full_name"),
    sourceContactId: text("source_contact_id"),
    // crm-service's own contact row id (`contacts.id`) at emission: the id
    // /orgs/gohighlevel/contacts serves as `id` and funnel-events as `contactId`.
    // Not part of the content hash (a reconnect re-mints row ids, the fact is the same).
    crmContactId: uuid("crm_contact_id"),

    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    dateBasis: text("date_basis").notNull(),
    source: text("source").notNull(),
    sourceRef: text("source_ref").notNull(),
    payload: jsonb("payload").notNull(),
    withdrawnOf: uuid("withdrawn_of"),

    // Bookkeeping (never served). Null on crm meta facts (withdrawn, merged, split).
    naturalKey: text("natural_key"),
    family: text("family"),
    contentHash: text("content_hash"),
    live: boolean("live").notNull().default(true),
    ownerPersonKey: text("owner_person_key"),
    subjectPresence: text("subject_presence"),
    subjectKeys: jsonb("subject_keys"),
    subjectStandalone: boolean("subject_standalone").notNull().default(false),

    emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("people_facts_fact_id_uq").on(table.factId),
    // One LIVE fact per natural key: a re-sync of an unchanged record emits nothing.
    uniqueIndex("people_facts_live_natural_key_uq")
      .on(table.orgId, table.brandId, table.naturalKey)
      .where(sql`${table.live} AND ${table.naturalKey} IS NOT NULL`),
    index("people_facts_org_brand_seq_idx").on(table.orgId, table.brandId, table.feedSeq),
  ],
);

/**
 * BRONZE — the source artifact for a brand's PostHog project, mirrored
 * READ-ONLY. One row per (org, brand).
 *
 * Exactly like `ghl_connections`, there is NO credential column: the brand's
 * PostHog personal API key lives in key-service, scoped to (org, brand), and
 * every sync resolves it at call time. `project_id` and `region` say WHICH
 * project to read; a personal API key may reach several projects, so the id
 * cannot be derived from the key.
 *
 * `region` is `us` | `eu` (PostHog Cloud). The host is derived from it in code,
 * never taken from the caller, so a connection can never point this service at
 * an arbitrary URL.
 *
 * `synced_through` is the window cursor: the next pass re-reads activity from a
 * little before it (see posthog/sync.ts) so late-ingested events are not lost.
 */
export const posthogConnections = pgTable(
  "posthog_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    projectId: text("project_id").notNull(),
    region: text("region").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    // 'active' | 'paused' | 'error'
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncedThrough: timestamp("synced_through", { withTimezone: true }),
    lastRunId: text("last_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("posthog_connections_org_brand_uq").on(table.orgId, table.brandId),
    index("posthog_connections_status_idx").on(table.status),
  ],
);

/**
 * BRONZE — PostHog records verbatim, one row per (connection, kind, id).
 * `kind` is `person` (an IDENTIFIED person: PostHog knows their email), `visit`
 * (one session of an identified person, aggregated by PostHog's own query
 * engine) or `event` (one custom event of an identified person). PostHog's own
 * id (person id, session id, event uuid) is the idempotency key and
 * `content_hash` the no-churn guard, as for GoHighLevel.
 */
export const posthogRawRecords = pgTable(
  "posthog_raw_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => posthogConnections.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").notNull(),
    mirroredAt: timestamp("mirrored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("posthog_raw_records_conn_kind_external_uq").on(
      table.connectionId,
      table.kind,
      table.externalId,
    ),
    index("posthog_raw_records_org_brand_kind_idx").on(table.orgId, table.brandId, table.kind),
  ],
);

/**
 * SILVER — one dated website activity of an identified PostHog person: a
 * `visit` (session: start, end, entry page, pageviews) or an `event` (a custom
 * event, by its own name). Deterministic from bronze, zero LLM. `contact_id`
 * is the silver contact (source `posthog`) of the person; null rather than
 * guessed when the person was not mirrored.
 */
export const posthogActivities = pgTable(
  "posthog_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => posthogConnections.id, { onDelete: "cascade" }),
    // 'visit' | 'event'
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    externalPersonId: text("external_person_id").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // visit: the entry page path; event: the event name, verbatim.
    name: text("name").notNull(),
    url: text("url"),
    pageviews: integer("pageviews"),
    detail: jsonb("detail").notNull(),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("posthog_activities_conn_kind_external_uq").on(
      table.connectionId,
      table.kind,
      table.externalId,
    ),
    index("posthog_activities_contact_idx").on(table.contactId),
  ],
);

/**
 * BRONZE — the source artifact for a brand's Stripe account, mirrored
 * READ-ONLY. One row per (org, brand). No credential column: the brand's Stripe
 * RESTRICTED key lives in key-service. `key_mode` (`live` | `test`) is read off
 * the key's own prefix at connect time so a test-mode account is never mistaken
 * for revenue.
 *
 * `last_full_sync_at`: most passes re-list only recently created objects; a full
 * re-list runs once a day so a change on an old object (an email edited on a
 * year-old customer) still lands.
 */
export const stripeConnections = pgTable(
  "stripe_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    keyMode: text("key_mode").notNull(),
    // The key-service provider name this connection's restricted key is stored
    // under. `stripe` for the brand's first account (every connection made
    // before several were possible); each further account stores its own key
    // under its own name (`stripe-<label>`), so N keys coexist in key-service.
    credentialProvider: text("credential_provider").notNull().default("stripe"),
    // Which Stripe account the key reads, as Stripe states it (`GET /v1/account`).
    // Null when the restricted key has no permission to read the account.
    accountId: text("account_id"),
    accountName: text("account_name"),
    createdByUserId: text("created_by_user_id").notNull(),
    // 'active' | 'paused' | 'error'
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stripe_connections_org_brand_provider_uq").on(table.orgId, table.brandId, table.credentialProvider),
    index("stripe_connections_status_idx").on(table.status),
  ],
);

/**
 * BRONZE — Stripe objects verbatim: `customer` | `charge` | `refund` |
 * `subscription`. Stripe's own object id is the idempotency key, `content_hash`
 * the no-churn guard.
 */
export const stripeRawRecords = pgTable(
  "stripe_raw_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").notNull(),
    mirroredAt: timestamp("mirrored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stripe_raw_records_conn_kind_external_uq").on(
      table.connectionId,
      table.kind,
      table.externalId,
    ),
    index("stripe_raw_records_org_brand_kind_idx").on(table.orgId, table.brandId, table.kind),
  ],
);

/**
 * SILVER — one money movement or subscription of a Stripe customer:
 * `payment` (a charge), `refund`, `subscription`. Amount in the currency's
 * MINOR unit exactly as Stripe states it, currency and status verbatim (Stripe's
 * fixed vocabularies). `contact_id` is the silver contact (source `stripe`) of
 * the customer; null when the object names no customer we mirrored.
 */
export const stripeTransactions = pgTable(
  "stripe_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    // 'payment' | 'refund' | 'subscription'
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    externalCustomerId: text("external_customer_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    status: text("status"),
    description: text("description"),
    detail: jsonb("detail").notNull(),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stripe_transactions_conn_kind_external_uq").on(
      table.connectionId,
      table.kind,
      table.externalId,
    ),
    index("stripe_transactions_contact_idx").on(table.contactId),
  ],
);

/**
 * BRONZE — the source artifact for a brand's AUTH PROVIDER (Clerk today;
 * Supabase Auth, Auth0, Firebase are future siblings under their own
 * `provider`): the tool that holds every person who signed up to the brand's
 * product. Mirrored READ-ONLY. One row per (org, brand, provider).
 *
 * No credential column: the brand's secret key lives in key-service under the
 * provider's name, scoped to (org, brand); every sync resolves it at call time.
 * `provider_user_count` is the provider's OWN count of its users at the last
 * pass, served beside what was mirrored so the two can be reconciled.
 */
export const authConnections = pgTable(
  "auth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    // 'clerk'
    provider: text("provider").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    // 'active' | 'paused' | 'error'
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // The provider's own user count at the last pass, beside what was listed.
    providerUserCount: integer("provider_user_count"),
    lastRunId: text("last_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_connections_org_brand_provider_uq").on(table.orgId, table.brandId, table.provider),
    index("auth_connections_status_idx").on(table.status),
  ],
);

/**
 * BRONZE — one row per user of the auth provider, verbatim minus the
 * provider's server-only secrets (Clerk `private_metadata` is never stored).
 * The provider's user id is the idempotency key, `content_hash` the no-churn
 * guard, as for every other mirror.
 */
export const authRawRecords = pgTable(
  "auth_raw_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => authConnections.id, { onDelete: "cascade" }),
    // 'user'
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").notNull(),
    mirroredAt: timestamp("mirrored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_raw_records_conn_kind_external_uq").on(table.connectionId, table.kind, table.externalId),
    index("auth_raw_records_org_brand_kind_idx").on(table.orgId, table.brandId, table.kind),
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
export type MatrixLink = typeof matrixLinks.$inferSelect;
export type MatrixRawEvent = typeof matrixRawEvents.$inferSelect;
export type NewMatrixRawEvent = typeof matrixRawEvents.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type MatrixLead = typeof matrixLeads.$inferSelect;
export type NewMatrixLead = typeof matrixLeads.$inferInsert;
export type GhlConnection = typeof ghlConnections.$inferSelect;
export type NewGhlConnection = typeof ghlConnections.$inferInsert;
export type GhlRawRecord = typeof ghlRawRecords.$inferSelect;
export type NewGhlRawRecord = typeof ghlRawRecords.$inferInsert;
export type GhlPipeline = typeof ghlPipelines.$inferSelect;
export type NewGhlPipeline = typeof ghlPipelines.$inferInsert;
export type GhlOpportunity = typeof ghlOpportunities.$inferSelect;
export type NewGhlOpportunity = typeof ghlOpportunities.$inferInsert;
export type GhlAppointment = typeof ghlAppointments.$inferSelect;
export type GhlOpportunityHistoryRow = typeof ghlOpportunityHistory.$inferSelect;
export type GhlStageMeaning = typeof ghlStageMeanings.$inferSelect;
export type PeopleScope = typeof peopleScopes.$inferSelect;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type PosthogConnection = typeof posthogConnections.$inferSelect;
export type PosthogActivity = typeof posthogActivities.$inferSelect;
export type StripeConnection = typeof stripeConnections.$inferSelect;
export type StripeTransaction = typeof stripeTransactions.$inferSelect;
export type PeopleFact = typeof peopleFacts.$inferSelect;
export type NewPeopleFact = typeof peopleFacts.$inferInsert;
export type AuthConnection = typeof authConnections.$inferSelect;
