# crm-service — agent notes

The fleet's contact registry. Scaffold mirrors apollo-service (Express +
drizzle-orm + postgres.js + zod + drizzle-kit + migrate-on-boot).

**The CSV is not crm-service's identity, it is its first source.** Three sources
feed the same registry, both layered bronze/silver/gold:

| Source | Direction | What it ingests | Sendable? |
|--------|-----------|-----------------|-----------|
| `csv`    | OUTBOUND | a client's own B2C CRM export, uploaded as a file | YES — feeds `serve-next` → human-service → cold email |
| `matrix` | INBOUND  | direct messages the client RECEIVED on WhatsApp / Telegram / Discord, mirrored into Matrix | NEVER — these people wrote first and are already in conversation |
| `gohighlevel` | MIRROR | the client's live GoHighLevel CRM: their contacts, sales pipeline and calendar appointments, read-only | NEVER — these are the client's own people, already theirs |

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

There are exactly THREE such calls, all once-per-artifact, never per row:
1. column typing, one per CSV upload;
2. thread reading, one per CHANGED Matrix conversation (watermark-gated);
3. stage meaning, one per GoHighLevel sync that finds a pipeline stage NAME
   never decided before (recorded, so every later sync makes zero calls).

Everything else GoHighLevel sends arrives already structured, so deriving it is
pure code — no model, no metered call, no catalogue row.

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
conversation with the user; a GoHighLevel-sourced contact reaching it would cold-
email the client's own customer. Because the guard is an ALLOWLIST, the
GoHighLevel source was excluded the moment it existed, with no change to this
view — proved by a test. It is an ALLOWLIST on purpose: a future source has to
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

## GoHighLevel ingestion (third source)

A customer runs their business on GoHighLevel. They paste their credential once
and the dashboard shows them their own CRM — contacts and sales pipeline —
read-only, kept up to date on its own.

**There is no write path to GoHighLevel, ever, by design.**
`src/lib/gohighlevel/client.ts` exposes reads and nothing else. Do not add one.

### The credential lives in key-service, not here

crm-service does NOT store the token, and there is deliberately no column to
write one into. key-service owns it, scoped to an (organisation, brand) pair,
and every call resolves it at
`GET /keys/brands/{brandId}/gohighlevel/decrypt` (contract verified against the
DEPLOYED key-service, 2026-09-19: `{ brandId, provider, key, keySource, userId }`,
404 when the brand has none).

**There is no org-wide fallback and none may be added.** An agency org holds many
brands, each a different end client; falling back to the org key would connect
one brand to another brand's GoHighLevel account. A 404 from key-service is a
refusal, full stop.

`location_id` is supplied by the customer alongside the token. A Private
Integration Token is an opaque static bearer that neither expires nor refreshes,
and GoHighLevel publishes no way to read the target sub-account out of it
(checked against the v2 docs, 2026-09-19), so the id cannot be derived. Every
request carries `Version: 2021-07-28` — GoHighLevel picks its API version per
request from that header.

### Bronze — `ghl_connections` + `ghl_raw_records`

- `ghl_connections` — one row per (org, brand). The analogue of
  `contact_uploads` / `matrix_connections`: it IS the source artifact. Holds
  `location_id`, `status`, `last_error`, `last_synced_at`, `last_run_id`.
  - **Natural key = `UNIQUE(org_id, brand_id)`** — one GoHighLevel account per brand.
  - `created_by_user_id` is persisted at create time ON PURPOSE: the sync runs
    from a cron with NO inbound identity headers, and the org run + the
    key-service resolve must still be attributed. A request-scoped header does
    not survive that async boundary — the row is the carrier.
- `ghl_raw_records` — one row per record, `payload` = the record verbatim.
  - **Natural key = `UNIQUE(connection_id, kind, external_id)`**, `kind` one of
    `contact` | `opportunity` | `pipeline`. GoHighLevel's own record id IS the
    idempotency key, so a re-run inserts nothing.
  - **`content_hash` is the NO-CHURN guard**, and it is a different property from
    idempotency. The upsert carries `setWhere content_hash <> excluded.content_hash`,
    so an unchanged record is not rewritten at all: `mirrored_at` does not move,
    the row is not returned as changed, and nothing downstream re-derives. Get
    this wrong and every tick rewrites the customer's whole CRM.

### Silver — `contacts` (source `gohighlevel`) + `ghl_pipelines` + `ghl_opportunities`

Deterministic, **zero LLM**. The data arrives structured; reading it needs no model.

- Contacts land in the SHARED `contacts` table with `source = 'gohighlevel'`,
  carrying identity PLUS what GoHighLevel holds about the person's company and
  about where the record came from. Identity alone cannot answer "is this CRM
  record the same human as one of our leads": measured in prod on the first
  customer's 2,694 contacts, only 420 carry an email while **455 carry a company
  name and 454 of those 455 carry NO email** — so for those 454 the company is
  the only non-name signal that exists anywhere, and that set is almost entirely
  disjoint from the email set. The columns are `company_name`, `website`, `city`,
  `state_region`, `country`, `postal_code`, `street_address`, `lead_source`,
  `contact_type`, `tags`, `origin_medium`/`origin_url`/`origin_referrer`,
  `source_created_at`, `source_updated_at`.
  - **Every one is nullable and written only when the vendor reports it.** Absent
    stays NULL — never a default, never a guess. `tags` distinguishes NULL (no
    tags field at all) from `[]` (an empty one); those are different facts.
  - **`lead_source`, `contact_type` and `tags` are the customer's own free text**
    and are served verbatim, mapped onto no vocabulary of ours — the same rule
    the pipeline stage names live under.
  - `origin_*` is the FIRST-touch attribution entry. The same entry also carries
    an IP and a user agent; those stay in bronze and are never lifted or served.
  - The columns are generic on purpose (a CSV export names a company too), but
    today only the GoHighLevel derivation populates them. They are additive: a
    pre-existing row reads NULL everywhere and nothing already served changed
    shape.
  - **Natural key = `(org_id, brand_id, source, external_id)`** — GoHighLevel's
    own contact id. NULLs are distinct, so CSV and Matrix rows are exempt.
  - ⚠️ **The CSV email dedup index is now PARTIAL, `WHERE source = 'csv'`.** That
    rule exists because one CRM export lists a person once; it is a statement
    about the CSV source, not about contacts in general. Left unconditional, a
    GoHighLevel contact sharing an email with a CSV contact would collide and one
    source would silently overwrite the other. Behaviour is unchanged for every
    row that existed before (all `csv`, or `matrix` with a null email).
  - `dnd` is carried through as `unsubscribed` — it IS the customer's own
    do-not-contact mark on that person.
- `ghl_pipelines` — one row per pipeline with its ordered `stages`. This is what
  lets the read group by stage NAME instead of by opaque id.
- `ghl_opportunities` — one row per opportunity, with pipeline and stage names
  resolved. Whatever GoHighLevel reports is what is stored: its pipeline, its
  stage, its status, its value, none of it re-bucketed. `contact_id` is null
  rather than guessed when GoHighLevel names a contact we have not mirrored.

There is no gold TABLE. The pipeline view (`src/lib/gohighlevel/view.ts`) is a
deterministic grouping computed on read — there is no model in the loop, so
materializing it would buy nothing.

### Re-syncing changes nothing, and rebuilding needs no vendor call

- A second identical pass reports `contactsChanged: 0, opportunitiesChanged: 0,
  pipelinesChanged: 0` and writes not one row — proved by a test that compares
  every table row-for-row, timestamps included.
- Only records whose bronze row actually moved are re-derived. One coupling is
  deliberate: a pipeline can be renamed or re-staged without any opportunity
  changing, and every opportunity carries its pipeline and stage name, so a
  pipeline change re-derives every opportunity of the connection.
- `POST /internal/gohighlevel/rebuild` re-derives all of silver from the mirror
  alone, with no call to GoHighLevel and no credential (proved by a test).

### Ingestion trigger + cron

`POST /internal/gohighlevel/sync` (apiKeyAuth, optional `connectionId`) runs a
pass in the background and 202s. Cron on the box, every 15 minutes:

```
*/15 * * * * curl -fsS -X POST "$CRM_SERVICE_URL/internal/gohighlevel/sync" \
  -H "x-api-key: $CRM_SERVICE_API_KEY" -H 'content-type: application/json' -d '{}'
```

The route's own platform run tracks only the TRIGGER. The pass opens **one ORG
run per connection**, using the org + creator stored on the connection row. A
per-connection failure is written to that connection (`status='error'`,
`last_error`), fails its run, and is returned in the pass result — never
swallowed, and one broken connection does not stop the others.

### Routes

- `POST /orgs/gohighlevel/connections` (needs `x-user-id`) — resolves the
  credential, PROVES it against GoHighLevel, and only then writes the row. A
  refusal quotes GoHighLevel's own status and message
  (`{ vendorStatus, vendorError }`). The probe is `GET /contacts/?limit=1`
  rather than `GET /locations/{id}` on purpose: it exercises the exact scope the
  sync needs, so a token that passes can actually do the job, and a token bound
  to a different sub-account is refused by GoHighLevel itself.
- `PATCH /orgs/gohighlevel/connections/:id` — pause / resume.
- `DELETE /orgs/gohighlevel/connections/:id` — disconnect. The row goes and, by
  cascade, everything derived from it; with no row there is nothing for a pass to
  iterate, so the syncing stops.
- `GET /orgs/gohighlevel/connections?brandId=` — health (`status`, `synced`,
  `lastSyncedAt`, `lastError`).
- `GET /orgs/gohighlevel/contacts?brandId=&limit=&offset=` — identity, plus
  `company`, `location` and `record` (type, leadSource, tags, createdAt,
  updatedAt, origin). Grouped on the way out so identity, company, place and
  provenance are distinguishable at a glance; every pre-existing key keeps its
  name. Backfilling the columns onto contacts mirrored before they existed needs
  no vendor call — `POST /internal/gohighlevel/rebuild` re-derives silver from
  the mirror alone.
- `GET /orgs/gohighlevel/contacts/origins?brandId=` — where the brand's
  contacts came from, counted in SQL over the WHOLE population (so no caller
  pages every contact into a browser to count): `leadSource`, `originMedium`,
  `contactType` as `[{ value, count }]`, plus `tags`. Values are verbatim — no
  mapping, no case folding (`form 13` and `Form 13` are two buckets in prod
  because the customer typed two things). Contacts carrying no value are the
  `value: null` bucket, ALWAYS present (count 0 included), so each single-valued
  breakdown sums to `totalContacts`. Tags are multi-valued, so label counts
  overlap; they reconcile through `tagged + untagged = totalContacts` instead.
- `GET /orgs/gohighlevel/opportunities?brandId=` — the pipeline, grouped by
  pipeline then stage. Opportunities in a pipeline we have not mirrored come back
  under `ungrouped` rather than being dropped, so the counts add up to what the
  customer sees in GoHighLevel.
- `GET /orgs/gohighlevel/funnel-events?brandId=&contactId=&limit=&offset=` — the
  DATED funnel events the CRM evidences, grouped per crm-service contact (the
  `id` lead-service pairs on), paged over contacts in a total order. See below.
- `GET /orgs/gohighlevel/stage-meanings?brandId=` — the recorded stage decisions.

### Funnel evidence — appointments, stage history, stage meanings

The CRM knows things our funnel does not (a meeting BOOKED, ATTENDED or not, a
deal WON). This is where those facts become dated events lead-service can read.
lead-service never learns a GoHighLevel stage name; this service owns the
customer's vocabulary.

- **Appointments** — bronze `kind='calendar'` + `kind='appointment'`, silver
  `ghl_appointments`. Read per calendar via `GET /calendars/events` (Version
  `2021-04-15`), 2018 → ~13 months ahead in 180-day windows, de-duplicated on
  GoHighLevel's id. NOT the per-contact appointments read: it serves zone-less
  wall-clock times, and a zone-less time is stored NULL, never parsed in the
  server's zone. `booked_at` = `dateAdded`, `starts_at` = `startTime`, `status` =
  GoHighLevel's fixed appointment vocabulary, verbatim.
- **Opportunity history** — `ghl_opportunity_history`, APPEND-ONLY. GoHighLevel
  keeps no stage history (only the current stage + `lastStageChangeAt` /
  `lastStatusChangeAt`), so this accumulates it from the first sync onwards. A
  row is appended when (value, GoHighLevel's change date) differs from the
  latest row of that kind — a re-sync appends nothing. `changed_at` is
  GoHighLevel's date or NULL, never our observation time. It cannot be rebuilt
  from bronze (bronze keeps the latest payload only): it is a record, like
  bronze. The past before the first sync is lost and is NOT reconstructed.
- **Stage meanings** — `ghl_stage_meanings`, keyed (connection, stage id, stage
  NAME). An LLM decides (chat-service, `CRM_STAGE_MEANING_CHAT_CONFIG`) which of
  `meeting_booked | meeting_attended | meeting_not_held | sale | deal_lost |
  none` a stage means, and the decision is recorded with its model and run.
  **No stage name is ever mapped in code** — no string matching, no keyword
  list; the recorded decision is the only source. Re-decided only when a NEW
  name appears (a rename is a new statement by the customer). An answer that
  skips, duplicates or invents a meaning fails the sync loud.
- **The events** (`src/lib/gohighlevel/funnel-events.ts`), computed on read:
  appointment → `meeting_booked` at `booked_at`; appointment `showed` →
  `meeting_attended`, `noshow`/`cancelled` → `meeting_not_held`, both at the
  scheduled start; `invalid` → nothing. A history stage row whose meaning is not
  `none` → that step at `changed_at` (`stage_entry`). Status `won` / `lost` →
  `sale` / `deal_lost` at the status change date. Mapping GoHighLevel's FIXED
  status vocabularies in code is fine; mapping the customer's free-text stage
  names is not. Each event carries `occurredAt` (null when GoHighLevel gave no
  date), `dateBasis` naming which date it is, `source`, and GoHighLevel's id.
  The same fact can be evidenced twice (a calendar booking AND a "Booked" stage)
  — both are served, with their sources; the consumer picks.

## An org-scoped run must open even when the request carries NO brand

Run tracking is mandatory here, and `attachRun` runs BEFORE every `/orgs/*`
handler — so anything that makes run creation fail kills the route without the
handler running once. runs-service validates the body-level `brandIds` as
min-1-WHEN-PRESENT (its own schema marks the field deprecated in favour of the
`x-brand-id` header), so sending `[]` is a hard 400 and the route answers
`502 "run tracking unavailable"`. The customer sees a generic failure and no
diagnostic about their actual input.

That fires on EVERY org route whose brand lives in the request BODY or in a
PATH PARAM, because the api-service gateway only promotes `brandId` to the
identity header from a header or a query param — never from a body. GoHighLevel
connection create / pause / resume / delete, Matrix connection create and
update, and `serve-next` were all 100% broken in prod on 2026-09-21 for exactly
this reason.

Two rules, both in `src/lib/runs-client.ts` + `src/middleware/auth.ts`:

- **`createRun` OMITS `brandIds` entirely when there is no brand — never `[]`.**
  A brand-less org-scoped request is legitimate and must still open its run.
- **`resolveBrandIds()` reads the brand off the request the caller ALREADY
  sends**: `x-brand-id` first, then a uuid-shaped `brandId` in the parsed JSON
  body, then the query. `express.json()` runs app-wide before any router, so the
  body is available in middleware. A multipart upload's body is not parsed yet
  (multer runs inside the route), so that route keeps its header.

Attribution is best-effort and the route working is not: a path-param route
whose brand needs a DB lookup opens an UNATTRIBUTED run rather than failing. A
genuine runs-service outage still fails loud with a 502 — that is unchanged.

Do NOT fix a recurrence of this by having one more caller send `x-brand-id`.
That consumer-side patch already happened once (distribute.you#2968, the CSV
upload, 2026-07) and every route added since inherited the landmine. The tests
in `tests/unit/run-tracking.test.ts` assert what goes ON THE WIRE against a fake
runs-service that reproduces the real min-1-when-present validation — a suite
that mocks the run client cannot see this bug at all.

## Every limit/offset list needs a TOTAL order — end the ORDER BY on a unique column

Callers walk these lists page by page (lead-service pages
`/orgs/gohighlevel/contacts` and hands out `nextOffset` positions into it), and
Postgres keeps no stable order among TIES across different LIMIT/OFFSET
windows. A sort on a non-unique column (a name, a timestamp) can serve one row
on two pages and another on none, silently — nothing errors and the counts look
plausible. So every paged read ends its `orderBy` with a unique column
(`external_id` then `id` for GoHighLevel contacts, `id` elsewhere), keeping the
human-facing sort first. Measured before the fix (v0.4.1): walking 23 tied rows
in pages of 1 returned 21 distinct. `tests/integration/ghl-sync.test.ts` pins it
by walking in pages of 1, 7 and 1000.

## Test fixture ids must be REAL v4 uuids, not `0000`-padded placeholders

`z.string().uuid()` on zod 4 validates the version and variant nibbles, so a
readable placeholder like `aaaaaaaa-0000-0000-0000-000000000001` is REJECTED —
its version nibble is `0`. A direct `db.insert` accepts it happily (Postgres only
checks the shape), so a fixture id works everywhere until the first test that
goes through a ROUTE, where it comes back as `400 "brandId (uuid) query is
required"`. That message names the field as missing rather than as malformed,
which reads like a body-parsing or header problem and sends you to look at
`express.json()`.

Use `bbbbbbbb-1111-4111-8111-…` (version `4`, variant `8`) for anything a route
will parse. The older Matrix and CSV fixtures still carry `0000`-padded ids and
pass only because they never cross a zod boundary — do not copy them for a test
that calls a handler. (Set 2026-09-19, cost a debugging round on the GoHighLevel
integration suite.)

## `npm run build` fails LOCALLY on the openapi step — the failure is `pnpm`, not your diff

`build` is `tsc && pnpm generate:openapi`, and that second half dies on macOS
under Node 20 with a bare `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` stack and no
mention of any file. It reads as a compile error in whatever you just edited, so
the reflex is to go hunting through the diff — there is nothing there. The same
script run through npm works: `npm run generate:openapi` prints
`openapi.json generated`, and `pnpm generate:openapi` alone reproduces the crash
on a clean `origin/main`. It is the pnpm → tsx → node hand-off, not the code, and
CI is unaffected.

So the local build gate is `npx tsc --noEmit` plus `npm run generate:openapi`,
run separately. Do not read the chained failure as a signal about your change.
(Set 2026-09-22.)

## Env vars

`CRM_SERVICE_DATABASE_URL`, `CRM_SERVICE_API_KEY`, `RUNS_SERVICE_URL`, `RUNS_SERVICE_API_KEY`,
`CHAT_SERVICE_URL`, `CHAT_SERVICE_API_KEY`, `MATRIX_HOMESERVER_URL`,
`MATRIX_ACCESS_TOKEN`, `MATRIX_INGESTION_FLOOR`, `CRM_LEAD_READING_CHAT_CONFIG`,
`CRM_STAGE_MEANING_CHAT_CONFIG`, `KEY_SERVICE_URL`, `KEY_SERVICE_API_KEY`.
See `.env.example`. The four Matrix ones are REQUIRED for the sync to run at all —
without them `/internal/matrix/sync` fails loud instead of silently no-op-ing.
The two `KEY_SERVICE_*` ones are REQUIRED for GoHighLevel — they are how the
brand's credential is resolved, and crm-service holds no copy of it.
`CRM_STAGE_MEANING_CHAT_CONFIG` is REQUIRED for a GoHighLevel sync that meets an
undecided stage — unset, that sync fails loud rather than picking a model.
