# crm-service — agent notes

The fleet's contact registry. Scaffold mirrors apollo-service (Express +
drizzle-orm + postgres.js + zod + drizzle-kit + migrate-on-boot).

**The CSV is not crm-service's identity, it is its first source.** Two sources
feed the same registry, both layered bronze/silver/gold:

| Source | Direction | What it ingests | Sendable? |
|--------|-----------|-----------------|-----------|
| `csv`    | OUTBOUND | a client's own B2C CRM export, uploaded as a file | YES — feeds `serve-next` → human-service → cold email |
| `matrix` | INBOUND  | direct messages the client RECEIVED on WhatsApp / Telegram / Discord, mirrored into Matrix | NEVER — these people wrote first and are already in conversation |

As a CSV lead-provider it is a sibling of `apollo-service` / `apify-service`.

## Route tiers (service-architecture)

- `/health`, `/openapi.json` — public, no auth.
- `/internal/*` — `apiKeyAuth` (`x-api-key`).
- `/orgs/*` — `apiKeyAuth` + `requireOrg`/`requireOrgAndUser` (`x-org-id`, and
  `x-user-id` for upload). `apiKeyAuth` reads `CRM_SERVICE_API_KEY` at module load
  and **crashes at boot** if it is missing.
- Every authenticated request creates its own run (`@ src/lib/runs-client.ts`);
  a runs-service failure fails the request 502. Org routes → org run; `/internal`
  reprocess → platform run. Provenance rows store `run_id` + `parent_run_id`.
- Every `/orgs/*` query filters on `org_id`.

## Cost

crm-service declares **NO cost of its own**. Every external/metered call is an LLM
completion routed through chat-service `POST /complete`, which self-declares its
LLM cost against the run id crm-service forwards. crm-service imports no LLM SDK
and holds no provider key, so no costs-service catalog row is needed.

There are exactly TWO such calls, both once-per-artifact, never per row:
1. column typing, one per CSV upload;
2. thread reading, one per CHANGED Matrix conversation (watermark-gated).

**Models are named CONFIGS, not literals** (`@ src/lib/chat-config.ts`). A config
is an env var holding `"<provider>/<model>"`, so pointing a task at a cheaper
provider landing in chat-service later is a change on the box with ZERO code
change here. `CRM_LEAD_READING_CHAT_CONFIG` is the Matrix one. Unset or malformed
→ throws; it never falls back to some default model.

## Data layering (bronze / silver / gold)

crm-service owns bronze + silver + gold for BOTH sources. The CSV layering is
below; the Matrix layering is in its own section further down and follows the
same shape (source artifact + verbatim rows → deterministic silver → business
gold).

### Bronze — append-only raw mirror

- `contact_uploads` — one row per upload. Columns: filename, `content_hash`
  (sha256 of raw bytes), `row_count`, `column_headers` (jsonb), `column_mapping`
  (jsonb, header→enum), `mapping_provenance` (`llm`|`override`), `status`
  (`uploaded`→`promoting`→`promoted`|`failed`), `run_id`, `parent_run_id`.
  - **Natural key = `UNIQUE(org_id, brand_id, content_hash)`.** Re-uploading the
    exact same file returns the existing upload — no re-typing, no bronze
    duplication. (The proposed shape had no hash; it was added so re-upload is
    genuinely idempotent, per the data-layering idempotency checklist.)
- `contact_rows_raw` — one row per CSV data row. `payload` jsonb = the raw row.
  `UNIQUE(upload_id, row_number)` → chunked / retried inserts are idempotent.

### Silver — canonical typed contact (`contacts`)

`contacts` is SHARED by both sources, discriminated by `source` (`csv`|`matrix`,
NOT NULL DEFAULT `'csv'`). Two natural keys coexist, and they cannot collide:
`(org, brand, lower(primary_email))` for CSV, `(org, brand, channel,
channel_handle)` for Matrix — the second is a plain unique index and Postgres
treats NULLs as distinct, so every CSV row (both columns null) is exempt from it.
`source_upload_id` / `source_row_id` (CSV) and `source_connection_id` (Matrix) are
each nullable; exactly one side is populated.

CSV specifics:

- Deterministically derived from bronze via `promoteUpload()` — **zero per-row
  LLM**. The column mapping (one LLM call at upload time) is applied in code.
- **Natural key = `(org_id, brand_id, lower(primary_email))`** (expression unique
  index, hand-written migration). Last-write-wins per field. Null-email rows are
  kept but not email-deduped; they are re-derived per upload (delete-by
  `source_upload_id` then re-insert) so re-promotion stays idempotent.
- Columns typed to the enum (`email`/`phone`/`first_name`/`last_name`/`full_name`)
  populate the typed silver columns; everything typed `other` lands in
  `raw_attributes` jsonb.
- `consent_status` (`granted`|`denied`|`unknown`, default `unknown`) and
  `unsubscribed` are detected deterministically from well-known column NAMES
  (`/consent|gdpr|opt.?in/`, `/unsub|opt.?out|do.?not.?contact/`) — the fixed
  typing enum has no consent field, so this is a separate deterministic rule.
- `source_upload_id`, `source_row_id`, `last_rebuilt_at` = source attribution.

### Gold — `sendable_contacts` view

Filters to sendable contacts: non-null valid email (regex), `NOT unsubscribed`,
`consent_status <> 'denied'`, **`source = 'csv'`**. `unknown` consent IS sendable
(B2C CRM exports rarely carry an explicit consent column; only an explicit denial
or unsubscribe excludes). Materialize later only if perf demands.

**The `source = 'csv'` guard is load-bearing and must never be relaxed.** This
view feeds `serve-next` → human-service → live cold email for real paying brands.
A Matrix-sourced contact reaching it would cold-email someone who is already in
conversation with the user. It is an ALLOWLIST on purpose: a future source has to
opt into outreach deliberately. It is also byte-identical in behaviour for every
row that existed before it — the migration adds `source` with
`DEFAULT 'csv' NOT NULL`, which backfills every pre-existing contact, so the
guard cannot drop a row that used to be sendable (proved by a test).

### Serve-tracking — `contact_serves` (per-brand no-re-serve suppression)

crm-service is a lead PROVIDER to human-service (the people gateway), a third
provider alongside apollo-service / apify-service. `POST /orgs/contacts/serve-next`
hands human-service the next batch of not-yet-served sendable contacts for a brand
and **atomically marks them served** so no concurrent or subsequent call ever
returns them again. crm-service OWNS this tracking because it performs the terminal
serve (identity-keying rule: the emitter owns "don't re-emit").

- `contact_serves` — one row per (brand, contact) served. Columns: `org_id`,
  `brand_id`, `contact_id` (provenance only), `email`, `served_run_id`, `served_at`.
- **Suppression natural key = `UNIQUE(brand_id, email)`** where `email =
  lower(primary_email)`. Suppression is keyed on the DURABLE contact identity
  (email), NOT the silver `contacts.id` — silver rows are delete-and-reinserted on
  every re-promotion so their uuid changes; keying on the uuid would leak a
  re-serve after any re-promote. The gold view already requires a non-null valid
  email, so every servable contact has a stable email. **Invariant: once a contact
  is served for a brand it is excluded from every future serve for that brand,
  forever** — permanent, per atomic member.
- **serve-next atomicity**: one SQL statement — a `candidate` CTE reads
  `sendable_contacts` anti-joined against `contact_serves`, `ORDER BY
  last_rebuilt_at`, `LIMIT`, `FOR UPDATE SKIP LOCKED` (concurrent calls lock
  disjoint rows); an `ins` CTE inserts the picked rows with `ON CONFLICT
  (brand_id, email) DO NOTHING` (permanent-suppression + race guard); the final
  SELECT returns only rows THIS call won. No double-serve sequential OR concurrent.
- **Truthful exhaustion**: `exhausted` is computed live (remaining un-served
  sendable count == 0 after the serve), never fabricated. A drained brand returns
  `{ contacts: [], served: 0, exhausted: true }`.
- `GET /orgs/contacts/serve-stats?brandId=` → `{ served, remainingSendable,
  totalSendable }`.
- Zero cost declared (DB-only). Org run per request via `requireOrg`.

### Per-file serve restriction (`uploadIds`) — each imported file is its own pool

Staff can toggle an imported CRM file ON/OFF, so a serve must be restrictable to a
subset of the brand's `contact_uploads`. Both serve routes take an OPTIONAL
`uploadIds`; omitting it is the pre-existing whole-brand behaviour, unchanged.

- `POST /orgs/contacts/serve-next` body `uploadIds?: uuid[]` (1..200).
- `GET /orgs/contacts/serve-stats?brandId=&uploadIds=a,b` (comma-separated or
  repeated) → the same `{ served, remainingSendable, totalSendable }` shape,
  scoped to those files.
- **The restriction narrows the CANDIDATE pool only — suppression stays
  BRAND-WIDE.** `contact_serves` has NO upload dimension (key stays
  `UNIQUE(brand_id, email)`), so a contact served through file A can never be
  re-served through file B. Restricting can only ever return FEWER contacts, never
  a repeat. Implemented as one extra `AND c.source_upload_id IN (…)` predicate on
  the candidate CTE (one bound param per id via `sql.join`); the anti-join is
  untouched.
- **File identity = the silver `source_upload_id` attribution**, the same one
  `GET /orgs/contacts/uploads` and the admin per-file contact view already use.
  Silver dedups on `(org, brand, lower(email))`, so a person present in two files
  is ONE row attributed to the file that promoted LAST. Per-file pools therefore
  PARTITION the brand's sendable contacts: every contact belongs to exactly one
  file and the per-file counts sum to the brand total. No membership bridge table,
  no promote change.
- `exhausted` under a restriction answers the asked scope ("these files are
  drained"), not the whole brand — the question the caller actually asked.
- **`served` in file-scoped stats** = sendable contacts OF THOSE FILES already
  served (the only file-attributable definition, and it keeps
  `served + remainingSendable == totalSendable`). Whole-brand `served` keeps its
  original meaning: every suppression row for the brand, including emails no
  longer present in silver.
- Gateway gap: api-service's `/v1/orgs/contacts/serve-stats` proxy currently
  forwards ONLY `brandId`, so `uploadIds` is stripped there — a per-file read
  through the gateway needs that proxy widened to a passthrough.

## Column typing (the mapping step)

CSV headers from arbitrary CRM exports must be classified against the FIXED enum
`{email, phone, first_name, last_name, full_name, other}`. Exactly **one**
chat-service `/complete` call per upload:

- `columnMapping` override present → use it (provenance `override`), skip the LLM.
- else build a per-header profile (header name + up to 5 non-null samples) and make
  ONE `/complete` call (anthropic/haiku, strict `responseSchema`), org-billed via
  the forwarded `x-org-id` + `x-user-id` + `x-run-id`. Provenance `llm`.
- Rows are then parsed DETERMINISTICALLY against the stored mapping — no per-row LLM.
- **The classify call is on the SYNCHRONOUS upload response path, behind the
  api-service gateway + Cloudflare's ~100s edge timeout.** So `chatComplete` is
  hard-bounded by `CHAT_SERVICE_TIMEOUT_MS` (default 25s, AbortController), and
  `classifyColumns` failure/timeout is caught: the upload falls back to a
  deterministic header-NAME heuristic (`heuristicMapping`, provenance `heuristic`)
  instead of hanging or 500-ing. Without this, a stalled chat-service hung the
  whole upload past the edge limit → the client saw a Cloudflare 502 and NOTHING
  was written to bronze (prod incident 2026-07-23). Provenance is one of
  `llm` | `override` | `heuristic`; a `heuristic` upload can be re-typed later via
  `/internal/contacts/promote` or an override re-upload.

## Async-promotion trigger

`POST /orgs/contacts/upload` writes bronze synchronously, returns
`{uploadId, rowCount}`, then kicks `runAsyncPromotion(uploadId)` via `setImmediate`
(fire-and-forget, its own platform run) — never on the boot path.
`POST /internal/contacts/promote` reprocesses one upload (or all) in the
background for schema migration / logic changes; idempotent.

## Matrix DM ingestion (second source)

An org receives its leads as DMs on WhatsApp / Telegram / Discord. A Matrix
homeserver (conduwuit) + three mautrix bridges run as containers on the Hetzner
box, **outside this repo** — they log into the user's personal accounts and mirror
every DM into Matrix rooms. crm-service does NOT build, configure or deploy them;
it CONSUMES the homeserver over the standard client-server API
(`GET /_matrix/client/v3/sync` with a `since` cursor), read-only.

**There is no send path, ever, by design.** `src/lib/matrix/client.ts` exposes
`sync()` and nothing else. That is what makes Discord read-only, and it is a
deliberate requirement — do not add a write.

### Bronze — `matrix_connections` + `matrix_raw_events`

- `matrix_connections` — one row per (org, brand, channel). The analogue of
  `contact_uploads`: it IS the source artifact. Holds `matrix_user_id` (the
  user's OWN bridged MXID — `sender == this` is what makes a message OUTBOUND),
  `counterpart_prefix` (the bridge ghost namespace, e.g. `@whatsapp_`),
  `since_token` (the `/sync` cursor), `status`, `last_error`, `last_synced_at`.
  - **Natural key = `UNIQUE(org_id, brand_id, channel)`.**
  - `created_by_user_id` is persisted at create time ON PURPOSE: the sync runs
    from a cron with NO inbound identity headers, and the org run + the
    chat-service call it triggers must still be attributed. A request-scoped
    header does not survive that async boundary — the row is the carrier.
- `matrix_raw_events` — one row per event, `payload` jsonb = the event verbatim.
  - **Natural key = `UNIQUE(event_id)`.** The Matrix event id is globally unique,
    so it IS the idempotency key — no content hash needed (unlike CSV, where the
    same bytes can legitimately be re-uploaded). Re-running a pass inserts nothing.
  - Room metadata (who the counterpart is) arrives as Matrix STATE events
    (`m.room.member`) and lands in this SAME table. There is no third bronze table.

**INGESTION FLOOR — why bronze has nothing before August.** `MATRIX_INGESTION_FLOOR`
(`2026-08-01` for the first org) is a hard floor: a `m.room.message` older than it
is NEVER mirrored. Bronze normally means "everything", so this is the one
deliberate exception — these are the user's PERSONAL accounts and back-filling
years of private DMs is not what anyone asked for. Unset → the sync throws.
Room STATE (`m.room.member`) is exempt from the floor because it is IDENTITY, not
content: a room joined in 2019 carries a 2019 membership event, and it is the only
thing that says who the counterpart is. Dropping it would leave every real room
unresolvable from bronze and would break "gold is rebuildable from bronze".

### Silver — `contacts` (source `matrix`) + `conversations`

Deterministic, **zero per-row LLM** — knowing who wrote to you needs no model.

- Counterpart resolution is STATE-EVENT work, not guesswork: `m.room.member`
  events, minus the connection's own MXID, keep the member in the bridge ghost
  namespace, most recent event wins (so a display-name change is picked up). No
  match → the room belongs to another bridge and is skipped. One access token
  yields one sync stream carrying every bridge's rooms, which is why each
  connection keeps its OWN cursor and filters by prefix.
- A WhatsApp ghost MXID encodes the phone (`@whatsapp_33612345678:hs` →
  `+33612345678`); other bridges use opaque ids and get `null` — deterministically,
  never a guess.
- `conversations` — one row per (contact, channel), a pure aggregation over the
  raw events: first/last message timestamp, message / inbound / outbound counts,
  and `last_event_id`, which doubles as the freshness watermark.
  **Natural key = `UNIQUE(contact_id, channel)`.**

### Gold — `matrix_leads`

Materialized (not a view) because the value is an LLM reading, not SQL: `status`
(fixed enum `new|qualifying|negotiating|won|lost|unresponsive`), `next_step`,
`estimated_value_usd`, `summary`, plus provenance `computed_through_event_id`,
`model`, `run_id`.

- **The watermark is what keeps the LLM bill near zero.** A row is recomputed ONLY
  when `conversations.last_event_id` differs from the stored
  `computed_through_event_id`. Get this wrong and every 5-minute tick re-reads
  every thread.
- **Fully rebuildable from bronze**: truncate `matrix_leads` and
  `POST /internal/matrix/rebuild` re-derives conversations and leads from the
  mirrored events alone, with no `/sync` call (proved by a test).

### Ingestion trigger + cron

`POST /internal/matrix/sync` (apiKeyAuth, optional `connectionId`) runs a pass in
the background and 202s. Cron on the box, every 5 minutes:

```
*/5 * * * * curl -fsS -X POST "$CRM_SERVICE_URL/internal/matrix/sync" \
  -H "x-api-key: $CRM_SERVICE_API_KEY" -H 'content-type: application/json' -d '{}'
```

The route's own platform run tracks only the TRIGGER. The pass itself opens **one
ORG run per connection**, using the org + creator stored on the connection row —
the spend belongs to the org that owns the connection, so this is not a
platform-run case. A per-connection failure is written to that connection
(`status='error'`, `last_error`), fails its run, and is returned in the pass
result — never swallowed, and one broken bridge does not stop the others.

### Read routes

- `POST /orgs/matrix/connections` (needs `x-user-id`), `PATCH
  /orgs/matrix/connections/:id` (pause/resume), `GET /orgs/matrix/connections?brandId=`
  → connection health (`status`, `synced`, `lastSyncedAt`, `lastError`).
- `GET /orgs/matrix/leads?brandId=&status=&limit=&offset=` → the gold leads joined
  with contact identity + conversation counters.

## Env vars

`CRM_SERVICE_DATABASE_URL`, `CRM_SERVICE_API_KEY`, `RUNS_SERVICE_URL`, `RUNS_SERVICE_API_KEY`,
`CHAT_SERVICE_URL`, `CHAT_SERVICE_API_KEY`, `MATRIX_HOMESERVER_URL`,
`MATRIX_ACCESS_TOKEN`, `MATRIX_INGESTION_FLOOR`, `CRM_LEAD_READING_CHAT_CONFIG`.
See `.env.example`. The four Matrix ones are REQUIRED for the sync to run at all —
without them `/internal/matrix/sync` fails loud instead of silently no-op-ing.
