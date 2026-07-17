# crm-service — agent notes

Greenfield lead-provider sibling of `apollo-service` / `apify-service`. Ingests a
client's own B2C CRM CSV exports as contacts. Scaffold mirrors apollo-service
(Express + drizzle-orm + postgres.js + zod + drizzle-kit + migrate-on-boot).

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

crm-service declares **NO cost of its own**. The only external/metered call is the
column-typing completion, routed through chat-service `POST /complete`, which
self-declares its LLM cost against the run id crm-service forwards. crm-service
imports no LLM SDK and holds no provider key.

## Data layering (bronze / silver / gold)

crm-service owns bronze + silver + gold for CRM CSV contacts.

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
`consent_status <> 'denied'`. `unknown` consent IS sendable (B2C CRM exports
rarely carry an explicit consent column; only an explicit denial or unsubscribe
excludes). Materialize later only if perf demands.

## Column typing (the mapping step)

CSV headers from arbitrary CRM exports must be classified against the FIXED enum
`{email, phone, first_name, last_name, full_name, other}`. Exactly **one**
chat-service `/complete` call per upload:

- `columnMapping` override present → use it (provenance `override`), skip the LLM.
- else build a per-header profile (header name + up to 5 non-null samples) and make
  ONE `/complete` call (anthropic/haiku, strict `responseSchema`), org-billed via
  the forwarded `x-org-id` + `x-user-id` + `x-run-id`. Provenance `llm`.
- Rows are then parsed DETERMINISTICALLY against the stored mapping — no per-row LLM.

## Async-promotion trigger

`POST /orgs/contacts/upload` writes bronze synchronously, returns
`{uploadId, rowCount}`, then kicks `runAsyncPromotion(uploadId)` via `setImmediate`
(fire-and-forget, its own platform run) — never on the boot path.
`POST /internal/contacts/promote` reprocesses one upload (or all) in the
background for schema migration / logic changes; idempotent.

## Env vars

`DATABASE_URL`, `CRM_SERVICE_API_KEY`, `RUNS_SERVICE_URL`, `RUNS_SERVICE_API_KEY`,
`CHAT_SERVICE_URL`, `CHAT_SERVICE_API_KEY`. See `.env.example`.
