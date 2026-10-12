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
| `posthog` | MIRROR | the brand's PostHog project: IDENTIFIED persons (email known), their visits and custom events, read-only | NEVER |
| `stripe` | MIRROR | the brand's Stripe account (restricted key): customers, charges, refunds, subscriptions, read-only | NEVER |
| `clerk` | MIRROR | the brand's AUTH PROVIDER: every user who signed up to its product, history included, read-only | NEVER |
| `copilot` | PUSHED | each distribute.you Copilot chat turn (user message + answer), pushed by chat-service, filed ONLY under the staff Unibox scope | NEVER |
| `api` | PUSHED | each call a client made to our API / MCP server with their own key (request + answer), pushed by api-service, filed ONLY under the staff Unibox scope | NEVER |

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

crm-service declares **NO cost of its own**. Every external/metered call is a
model call routed through chat-service, which self-declares its cost against the
run id crm-service forwards. crm-service imports no LLM SDK and holds no provider
key, so no costs-service catalog row is needed.

**A CLASSIFICATION goes to Jev, never to a completion model.** chat-service
`POST /orgs/judgments` (TypeSafe Jev) answers a typed `choice` question with the
model's own CONFIDENCE, bills input tokens only ($0.21/M org price, output free —
haiku was $5/$25) and answered 8 stage questions in 1.1s. **Do not use
`anthropic/haiku` for anything** (owner, 2026-09-24: "very bad and expensive").
A completion (`/complete`) is only for work that WRITES text.

There are exactly THREE such calls, all once-per-artifact, never per row:
1. column typing, one Jev call per CSV upload (`src/lib/column-typing.ts`);
   a column Jev types below 0.5 confidence becomes `other`;
2. thread reading, one `/complete` per CHANGED Matrix conversation
   (watermark-gated) — it writes a next step and a summary, so it is the one
   completion; its config is `CRM_LEAD_READING_CHAT_CONFIG` (`google/flash`);
3. stage meaning, one Jev call per GoHighLevel sync that finds a pipeline stage
   NAME never decided before (recorded, so every later sync makes zero calls);
4. business relevance, one Jev call per personal-channel conversation (Gmail
   correspondent, Matrix DM), re-asked only when it moves (see "Sales leads only").

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
  LLM**. The column mapping (one Jev call at upload time) is applied in code.
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

### People pool (`people`) — serve merged persons, filtered

`POST /orgs/contacts/serve-next` body `people: { signedUp?, replied?, reachableBy?: "phone"|"email" }`
(exclusive with `uploadIds`) serves from the brand's `people` gold instead of CSV rows;
`GET /orgs/contacts/serve-stats?pool=people&signedUp=true&replied=false[&reachableBy=phone]`
counts it. `signedUp` = a presence on an `AUTH_PROVIDERS` source; `replied=false` = never
wrote to the brand on a CONVERSATION channel (`lib/people/conversation.ts`: Gmail/Matrix
`inboundCount > 0`, Instantly `anyReply`/`replied`; Copilot/API = product use, not a
conversation; TS `personReplied` and `PERSON_REPLIED_SQL` must stay twins). Always out:
automated, not_business, no email, CRM do-not-contact (CSV opt-out / GoHighLevel DND, as the CSV pool). No re-serve = the SAME `contact_serves` (brand, email):
a served person suppresses EVERY address it holds. Served row = the Contact shape +
`pool: "people"`, `personId`, `emails`, `phones`, `phoneSources [{phone, source, via}]`.
Distribute.you 2026-10-12: 95 signups → 87 never answered (62 never written, 25 written
without answer), 8 answered. The chain human-service → serve-next must pass `people`
(human-service audience binding).

### Segment (`people.segment`) — a CRM sourcing scoped to a part of the brand's CRM

Owner 2026-10-12 (Doc Dinners nurturing): `people.segment` on serve-next / `segment=<json>` on
serve-stats (`pool=people`), `lib/people/segment.ts`. Keys AND, list entries OR: `dealStages
[{stage, pipeline?}]` (deal CURRENTLY there; GoHighLevel opportunities), `dealStatuses`, `tags`,
`reached` / `notReached` (funnel steps off the live fact feed, Outcomes' evidence + `meeting_not_held`).
Names = the customer's own, trimmed + case-insensitive, never mapped. Clients (`sale` reached) out
unless `includeClients`; opted-out out unless `includeOptedOut`. Stats with `dealStages` add
`byStage` (overlapping). `GET /orgs/contacts/segments?brandId=` = what a segment can name, each
with `people` + `inPool`. The scope reaches a campaign through a human-service CRM audience
(`crmPeople.segment`) the campaign targets (`audienceIds`).

### Reachability (`reachableBy`) — a serve FOR a pipe never burns whom it cannot reach

`serve-next` body / `serve-stats` query `reachableBy: "phone" | "email" | [both]` (owner
2026-10-12): the channel(s) the serving pipe writes on. On BOTH pools a contact / person
the pipe cannot reach is SKIPPED and NOT marked served, so a WhatsApp serve (phone) leaves
email-only people to the email pipe. Email is always held anyway (no-re-serve key); `phone`
adds `phone_e164 IS NOT NULL` (CSV) / `phones` non-empty (people). Omitted = unchanged.
The pipe's channel reaches here from lead-service (outreach channel) through human-service.

### Still fits (`POST /orgs/contacts/still-fits`) — is ONE person still in the pool, now?

STILL-FITS-1012 (owner 2026-10-12): a serve judges the pool once; lead-service hands a found person to a
pipe hours later (3 "never answered" signups had WhatsApp threads merged in by #114 and were still
contacted). human-service asks here at handover. Body `{brandId, email, people?: <filter> | uploadIds?}`
(same words as serve-next) → `{fits: true, pool}` | `{fits: false, pool, reason, failed: [{code, reason}]}`;
404 `person_not_found` (unknown is never fits), 409 `ambiguous_person`. People pool: every clause of
`peoplePoolClauses` (`lib/serve.ts`, the SAME list `peoplePoolWhere` joins: never add a pool rule
outside it) evaluated on the person holding the address; a failed `replied:false` names the channels
(`lib/still-fits.ts`). The no-re-serve guard is NOT a clause. CSV pool: still in `sendable_contacts`
(+ file). A question: writes nothing (no `contact_serves`). Tests: `tests/integration/still-fits.test.ts`.

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
  ONE chat-service `/orgs/judgments` call (Jev, one `choice` question per
  column), org-billed via the forwarded `x-org-id` + `x-user-id` + `x-run-id`.
  Provenance `llm` (the stored value predates Jev and is kept for shape).
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

**ONE send path: a WhatsApp text, from the WhatsApp send module only** (owner
2026-10-12, see "WhatsApp send" below). `client.ts` `sendText` + `bridge.ts`
`resolveIdentifier`/`createDm` are called by `lib/whatsapp/send.ts` and nothing
else; no redact, receipt, read marker or group, on any channel (pinned by
`tests/unit/matrix-link.test.ts`). Discord / LinkedIn / Telegram stay read-only.

### Bronze — `matrix_connections` + `matrix_raw_events`

- `matrix_connections` — one row per linked ACCOUNT (org, brand, channel,
  account MXID): a brand links N accounts per channel. The analogue of
  `contact_uploads`: it IS the source artifact. Holds `matrix_user_id` (the
  user's OWN bridged MXID — `sender == this` is what makes a message OUTBOUND),
  `counterpart_prefix` (the bridge ghost namespace, e.g. `@whatsapp_`),
  `since_token` (the `/sync` cursor), `status`, `last_error`, `last_synced_at`.
  - **Natural key = `UNIQUE(org_id, brand_id, channel, matrix_user_id)`.**
  - `created_by_user_id` is persisted at create time ON PURPOSE: the sync runs
    from a cron with NO inbound identity headers, and the org run + the
    chat-service call it triggers must still be attributed. A request-scoped
    header does not survive that async boundary — the row is the carrier.
- `matrix_raw_events` — one row per event, `payload` jsonb = the event verbatim.
  - **Natural key = `UNIQUE(event_id)`.** Matrix contacts key on (org, brand,
    connection, channel, handle): a counterpart writing to two linked accounts
    is one contact per account; the person layer joins them on the shared
    bridge handle (`clusterPeople`), and the fact feed's re-mint check treats
    the handle's rows as a SET (else every pass would withdraw + re-emit). The Matrix event id is globally unique,
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
  namespace still in the room; the ghost that joined FIRST is the counterpart and
  stays so (its latest event names it, so a rename is picked up). WhatsApp can put
  a SECOND ghost into a DM: "latest wins" moved a whole campaign thread onto an
  anonymous contact and withdrew every fact of the real person (2026-10-12). A
  room is ONE conversation: a rebuild deletes any other row of the room. No
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

`POST /internal/matrix/sync` (apiKeyAuth, optional `connectionId`, `resync: true` =
restart from an initial sync to recover skipped messages) runs a pass in the
background and 202s. ⚠️ An INCREMENTAL page carries a room's new messages WITHOUT its
member state: a room already in this connection's bronze stays routed to it (before
2026-10-12 such messages were dropped, a sent message included). Cron on the box, every 5 minutes:

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

### Self-serve linking (`/orgs/matrix/links`, `src/lib/matrix/link.ts`)

Connecting an account is a product feature, never a staff step (owner rule
2026-10-01). A signed-in user links the brand's WhatsApp from the dashboard:

- `POST /orgs/matrix/links {brandId, channel, method, phoneNumber?}` ADDS an
  account (fresh flow on its own Matrix account; a linked account is never
  returned or touched) → the first QR / 8-char `pairingCode`, or `input` (a
  form). `{…, method, linkId}` relinks THAT account (same mirror);
  `{brandId, channel, linkId, input: {fieldId: value}}` answers the step it
  waits on (claimed first, relayed, never stored). Methods per channel
  (`CHANNEL_METHODS`): WhatsApp `qr|phone`, LinkedIn `password|cookies`
  (mautrix-linkedin: credentials form, then maybe LinkedIn's emailed 6-digit
  code; or browser cookies). The same remote account linked twice on a brand
  → `ACCOUNT_ALREADY_LINKED` (it would mirror every thread twice).
- `GET /orgs/matrix/links?brandId=` → `{ links, accounts }`: `accounts` = every
  account (each its `linkId`, `account`, `needsRelink` when the bridge says
  BAD_CREDENTIALS / LOGGED_OUT); `links` = one tile per channel (in-progress >
  latest linked > latest failed), the pre-multi-account shape. Each: `available`, `status`
  (`not_linked|waiting|linked|failed`), the CURRENT code (WhatsApp refreshes the
  QR at 60s then every 20s, then times out ~2m40s → `failed`, start again), the
  bridge's own `error {code, message}`, and once linked `account` + live
  `bridgeState` + `connection`. The dashboard polls this.
- `DELETE /orgs/matrix/links/:channel?brandId=&linkId=` → ONE account (no
  `linkId` + several accounts = 409 `link_id_required`): bridge logout, sync token
  revoked, the link's connection + its raw events / conversations / leads AND its
  Matrix contacts (no FK: deleted explicitly) dropped, people rebuild kicked. A
  hand-registered connection (no link) is never touched by it.

**Isolation = one dedicated Matrix account per LINK (account)**,
`@crm_<random>:matrix.distribute.you`, created through crm-service's own
appservice (`id: crm`, exclusive `@crm_*` namespace, registration in
`/root/distribute/matrix/crm/` on the box). The bridge keeps one login per
Matrix account and invites only that account to its rooms; the connection syncs
with that account's OWN token (`matrix_connections.access_token`, never served),
so one brand's DMs cannot reach another's `/sync`. ⚠️ continuwuity refuses
`/sync` to a masquerading appservice ("Appservices must masquerade"), so the
account logs in via `m.login.application_service` once and the token is stored.

**The bridge double-puppets with the same appservice token**
(`double_puppet.secrets` in `matrix/whatsapp/config.yaml`). Without it the
user's own phone messages arrive from their self-GHOST (`@whatsapp_<own id>`),
which the counterpart resolution would mistake for a contact and the outbound
count would miss; with it they arrive as the account (sender == account →
outbound) and the bridge joins the account to its rooms itself.

The bridge's provisioning API (`/_matrix/provision/v3`, shared secret +
`?user_id=`) is driven by an in-process DRIVER that long-polls
`display_and_wait`. Every driver write is conditioned on the row's
`bridge_process_id`, so a superseded/unlinked link stops its driver. A `waiting`
row with no live driver (service restarted) is turned `failed / INTERRUPTED` on
the next read — never a stale QR posing as live.

A channel is `available` only when `MATRIX_APPSERVICE_TOKEN` and its
`MATRIX_<CHANNEL>_PROVISIONING_URL` + `_SECRET` are set. Telegram's bridge needs
a platform Telegram app credential (api_id/api_hash) that is not provisioned:
its env is absent and it answers `409 channel_unavailable` "not available yet".
Discord's bridge (mautrix-discord) is not bridgev2, so it stays unavailable too.

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
    `contact` | `opportunity` | `pipeline` | `calendar` | `appointment` | `form` |
    `form_submission`. GoHighLevel's own record id IS the
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
  to a different sub-account is refused by GoHighLevel itself. It also probes
  `GET /forms/submissions?limit=1` (`forms.readonly`), which the sync reads too.
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
- ~~`GET /orgs/gohighlevel/funnel-events`~~ RETIRED (2026-10-08): lead-service
  v0.83.16 reads the same evidence off the people fact feed (funnel facts keyed
  on `crmContactId`); no caller was left in the fleet. The reader
  (`readFunnelEvents` / `eventsQuery`) stays: the feed, funnel-reach and the
  person timeline stand on it.
- `GET /orgs/gohighlevel/stage-meanings?brandId=` — the recorded stage decisions.

### Funnel evidence — appointments, stage history, stage meanings

The CRM knows things our funnel does not (a meeting BOOKED, ATTENDED or not, a
deal WON). This is where those facts become dated events; lead-service reads
them as funnel facts on the people fact feed.
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
  ⚠️ It is observed over EVERY mirrored opportunity on every pass
  (`recordHistory`), never inside the changed-only derivation. v0.5.0 appended
  it while re-deriving CHANGED opportunities, so the 460 opportunities already
  mirrored in prod (bronze unchanged) were never observed and the first pass
  appended 0 rows. v0.5.1 fixed it. The rule applies to any NEW derived record
  added on top of a changed-only pass: rows that existed before it never move,
  so they never reach it. Test it with the prod shape: bronze full, nothing
  changed, new table empty.
- **Stage meanings** — `ghl_stage_meanings`, keyed (connection, stage id, stage
  NAME). Jev decides (chat-service `/orgs/judgments`, one `choice` question per
  stage, every pipeline as the shared state) which of `meeting_booked |
  meeting_attended | meeting_not_held | sale | deal_lost | none` a stage means,
  and the decision is recorded with its CONFIDENCE, full distribution, model and
  run. A meaning below `STAGE_MEANING_MIN_CONFIDENCE` (0.5) is recorded but
  never served as evidence (`hesitantStages` on the read): on the first
  customer, clear names answered at 1.0 and "Showed?" / "Onboarding Call" /
  "Free Trail client" at 0.33-0.42.
  **No stage name is ever mapped in code** — no string matching, no keyword
  list; the recorded decision is the only source. Re-decided only when a NEW
  name appears (a rename is a new statement by the customer). An answer that
  skips a stage, invents a meaning or omits its confidence fails the sync loud.
- **Form submissions** — bronze `kind='form'` + `kind='form_submission'`,
  silver `ghl_form_submissions` (form NAME resolved from the mirrored forms). Read
  via `GET /forms/submissions` with an explicit `startAt=2018-01-01` /
  `endAt=tomorrow`: ⚠️ WITHOUT that window GoHighLevel answers the last 30 days
  only (37 vs 707 on Doc Dinners), silently. `submitted_at` = the submission's
  `createdAt`, NULL when zone-less. A Meta Ads lead form relayed into GoHighLevel
  lands here (130 of Doc Dinners' 132 `source: Meta Ads` contacts; Facebook's own
  lead forms appear under formId `fb-<locationId>`, which `/forms/` does not list,
  so their `formName` is null).
- **The events** (`src/lib/gohighlevel/funnel-events.ts`), computed on read:
  appointment → `meeting_booked` at `booked_at`; appointment `showed` →
  `meeting_attended`, `noshow`/`cancelled` → `meeting_not_held`, both at the
  scheduled start; `invalid` → nothing. A history stage row whose meaning is not
  `none` → that step at `changed_at` (`stage_entry`). Status `won` / `lost` →
  `sale` / `deal_lost` at the status change date. A form submission →
  `form_submitted` at `submitted_at` (`form_submission`). A contact whose
  FIRST-touch attribution medium is `form` / `survey` → `form_submitted` at the
  contact's `source_created_at` (`form_origin`, dateBasis `contact_created_at`):
  the form is what created the contact — measured 289/289 created 0.1–4 s after
  their first submission — and it covers submissions GoHighLevel no longer
  serves. `order_form` is a checkout, not a lead form, and is excluded. Tags
  ("funnel form submitted"), `source` ("Meta Ads") and a "Form Filled" stage are
  the customer's free text and are NOT read for this: they added 0 contacts the
  structured records did not already cover. Mapping GoHighLevel's FIXED
  status vocabularies in code is fine; mapping the customer's free-text stage
  names is not. Each event carries `occurredAt` (null when GoHighLevel gave no
  date), `dateBasis` naming which date it is, `source`, and GoHighLevel's id.
  The same fact can be evidenced twice (a calendar booking AND a "Booked" stage)
  — both are served, with their sources; the consumer picks.

### Funnel reach — whole-CRM step counts (`src/lib/gohighlevel/funnel-reach.ts`)

`GET /orgs/gohighlevel/funnel-reach?brandId=` and its org-less twin
`GET /internal/gohighlevel/funnel-reach?brandId=[&orgId=]` (features-service
prices a leg the customer's own sales team runs off it). Counts distinct CRM
contacts that EVER reached each step over the whole CRM, not only the handful
paired with our leads.

- **Per contact**, never per opportunity / appointment.
- **Same evidence as `funnel-events`** (it reuses `eventsQuery`), so the per-lead
  and whole-CRM reads can never disagree on what counts. Every pipeline counts:
  the stage's recorded meaning makes it a step, not its pipeline.
- `contacts` = direct evidence; `contactsAtOrBeyond` adds contacts evidenced at
  a later step (`REACH_IMPLIED_BY`: booked ⇐ attended / not held / sale,
  attended ⇐ sale). Needed because GoHighLevel keeps no stage history: on Doc
  Dinners the history is ONE snapshot (first observed 2026-09-24), so the 28
  contacts parked in "Closed Client" carry no record of their meeting. A
  consumer dividing adjacent steps must use `contactsAtOrBeyond`.
- `available: false` + `reason` (`no_connection` | `not_synced` |
  `stage_meanings_pending`) is distinct from zeros; `steps` is then absent.

## People — one person, every channel, one thread (gold, `src/lib/people/`)

The merged PERSON is crm-service's: for one (org, brand), everyone the brand is
in conversation with, across sources, with ONE state. Sources stay where they
are — crm-service READS the siblings' served routes, never their bronze, and
never writes to them (no write path to any outside tool, by design).

| Source | Who counts as "in conversation" | Read from |
|--------|--------------------------------|-----------|
| `gmail` | addresses the org's mailbox WROTE to (Gmail is per ORG) | google-service `GET /orgs/google/correspondents` |
| `instantly` | every lead our cold email WROTE to (at least one real send), answered or not (owner 2026-10-09); replied/clicked read only off its `engaged` rows | instantly-service `GET /orgs/written-to-leads?brand_id=` (cursor-paged) |
| `matrix` | every Matrix conversation of the brand | own silver |
| `gohighlevel` | every mirrored GoHighLevel contact | own silver |

CSV contacts are NOT people (nobody talked to them yet); a CSV row holding an
email and a phone is still merge evidence.

**The brand's own addresses are nobody.** Every mailbox we send from
(instantly-service `/internal/accounts`) and every address on the brand's
domain (brand-service `/internal/brands/{id}`) is dropped before merging,
counted per source as `excludedOwn`. Measured on the first build for
Distribute.you: 75 of 656 "people" were our own warm-up / sending mailboxes the
owner had written to. A recorded fact, never an address-shape guess.

- **Automated senders are nobody either — and Jev says who they are**
  (`automated.ts`). A LinkedIn "X just messaged you" digest, a receipt, a
  newsletter, a no-reply: one Jev `choice` (`human|automated`) per ADDRESS,
  input = the address, its names, counts and the 3 latest Gmail messages IT
  SENT. No regex of ours. Recorded in `sender_verdicts` keyed (org, email),
  so an address is judged ONCE (a rebuild makes zero calls). ⚠️ Only
  Gmail-ONLY people who WROTE are asked: judged blind, Jev called Instantly
  leads and PostHog signups automated at 0.5-0.8 (v0.13.0 prod, 60+ real
  prospects hidden); any other source is a recorded human relationship.
  A person is `automated` only when Gmail-only, no phone, EVERY address
  `automated` at confidence >= 0.75 (real people sat at 0.52-0.74: an
  out-of-office, a Google "Accepted:" notice; Jev judges the address OWNER); `GET /orgs/people` hides them
  unless `includeAutomated=true` (`automatedHidden` counts them). Jev down =
  nobody hidden, `senderVerdicts.status=failed`, retried next build. Source
  data stays whole.
- **Sales leads only — every other thread is nobody** (`relevance.ts`,
  owner 2026-10-10: « je veux que mes sales lead »). Every Gmail / Matrix
  conversation of a non-automated person gets ONE Jev call: `topic` choice
  `personal | other_business | this_brand`, where `this_brand` = the
  counterpart is a SALES LEAD of the brand (prospect, client, user, referral
  partner) and `other_business` = any other work: suppliers / tools / vendors
  pitching the owner, accountant, lawyer, bank, admin, mentors, investors,
  press, candidates, another company (state = brand name + website +
  `companyOverview` extracted field, its ACTIVE offers, the org's other brands,
  from brand-service; the overview is NOT in the context hash). This REPLACES
  v0.29.x's rule that kept suppliers, the accountant and mentors visible.
  Plus one `noul` per active offer. Text is clipped on code points (Jev refuses
  a lone surrogate). Recorded in `conversation_verdicts` keyed (org, brand,
  `gmail:<addr>` | `matrix:<conv id>`): Gmail is per ORG, so each brand judges
  the same thread for itself. Re-judged only when `judged_through` moved (Gmail
  `lastActivityAt|messageCount`, Matrix `last_event_id`) or the brand context
  hash changed. Hidden (`people.not_business`)
  only when the person is on Gmail / Matrix ALONE (no Instantly / CRM / CSV /
  Stripe / PostHog presence, no csv / lead_pairing / ghl / stripe evidence, no
  lead-service lead, a failed lead read counts as a lead) AND every conversation
  has P(this_brand) < 0.50 (owner 2026-10-10, was 0.15) OR holds no word a
  person wrote (`content = 'none'`, recorded without a Jev call: the bridge's
  own `m.notice` lines "Old photo…" / "Failed to bridge…" (first paragraph;
  a caption after a blank line is kept), uncaptioned media and empty mails
  are dropped on STRUCTURE by `humanText` before the window; Jev read a
  notice-only thread as this_brand at 0.47-0.83). Unjudged = shown. Offers tagged at noul >= 0.5, only
  on a conversation about the brand → `people.offer_ids`; `GET /orgs/people`
  takes `offerId=` and `includeNotBusiness=true`. A hidden person's message text
  is dropped from our search index and their new facts are HELD (never emitted).
  The Matrix lead reading (`/complete`, paid) runs only on a conversation judged
  about the brand: the judgment sits BEFORE it, a conversation left unjudged is
  retried next pass (candidates = rebuilt + every conversation whose lead is
  behind), and `GET /orgs/matrix/leads` drops a conversation judged not about it.
- **Merge only on positive evidence.** Keys are `email:<lower>` and
  `phone:+<digits>` (international only — a national number has no country and
  is no key). Two keys merge only when ONE record states both: a GoHighLevel /
  Google / CSV / Stripe contact, or a CONFIDENT lead-service pairing
  (`lead_pairing`: a `state=paired` row of `GET /orgs/leads/crm-pairings` with
  `toConfirm: false` = signal, judgment >= its pair threshold, or human
  acceptance). A `paired` + `toConfirm` row (a judgment between its thresholds)
  is a GUESS: lead-service still counts it in its stats, but it merges nothing
  here; the CRM contact stays its own person carrying `possibleLeads` ("maybe
  the same as X, to confirm"; each with lead-service's `leadId` so the Unibox
  sends confirm / deny straight to lead-service's rulings). Brice Jackson (2026-10-10): paired by full name
  at 0.69, merged, shown under the CRM's gmail; 47 of 62 pairing merges in his
  brand were such guesses. Rejected / unconfirmed / unpaired tie nothing. No
  name matching of ours, no model. Union-find in `identity.ts`, deterministic.
- **A person's `emails` list lead-service's addresses FIRST**
  (`leadAddressesFirst`): a lead shows under the address lead-service serves,
  never a CRM / Gmail address merged into it. `person_key` keeps its key order
  (identity, the fact feed keys on it); the fact content hash ignores `emails`.
- **Stated merges** (`person_merges`, `lib/people/merges.ts`, owner 2026-10-12): staff /
  an agent says two people of a brand are ONE human where no record states it (a WhatsApp
  chat with a number never saved + the same person on Gmail). `POST /orgs/people/merges
  {brandId, personIds:[a,b], reason?}` records it (who = `x-user-id`, when, run) with every
  identity key each side held; every build reads it as evidence `stated_merge` (Evidence
  `keys` ties ANY key verbatim, `matrix:<id>` included) and kicks a rebuild. Ids: the
  person-id rule keeps one, retires the other. `POST /orgs/people/merges/:id/undo {brandId}`
  sets `undone_at` (row kept), points each side's keys back at its own id, drops the
  aliases, rebuilds: two people with their old ids. Idempotent both ways; refusals 404
  `person_not_found`, 422 `different_brand` | `same_person`, 409 `already_one_person`,
  404 `merge_not_found`. `GET /orgs/people/merges?brandId=` lists with `applied`.
- **`person_key`** = smallest email key, else phone, else `<source>:<ref>`.
  Any identity key opens the person (`people.identity_keys` GIN `@>`).
  It is PII: a URL / link / analytics event carries **`personId`** instead
  (`person-id.ts`): a random uuid, stable across rebuilds because
  `person_ids` (identity key → id, never wiped by a build) carries it over.
  Merge: the id holding most of the person's keys wins (tie: older, then
  smaller), the other is retired into it (`person_id_aliases`, still opens the
  person). Split: the part holding most of the old id's keys keeps it, the
  other gets a new id. Timeline takes `personId=` OR `personKey=` (exactly one).
- **Entry events** (`timeline.ts` `entryItems` / `csvEntryItems`): every source
  record that brought the person in adds one dated event, so a CRM-only person
  is never an empty thread: GoHighLevel `added_to_crm` (`contact_created_at`),
  CSV `added_to_crm` (`uploaded_at`, item `source: "csv"`), PostHog `signup`,
  Stripe `became_customer`. No vendor date → no event (never build time).
- **ONE state, read not graded** (`state.ts`): lead-service standing verbatim
  (first exact-address row of its own `sort=activity` search; a failed read is
  `unavailable`, never a guess; from `PEOPLE_STANDING_WALK_MIN` (200) addresses
  to ask, ONE walk of the brand's whole lead list in the same order replaces the
  per-address searches: 17.5k searches were ~15 min per build; the walk also
  finds a lead lead-service SERVES under the address we emailed while its
  search only indexes the identity address, 1 of 40 repliers on 2026-10-09) > GoHighLevel deal status (fixed vocabulary,
  `deal_*`) > Matrix thread reading > Instantly `replied|clicked` >
  `in_conversation`. The browser renders `state` + `stateSource`.
- **Materialized, rebuilt whole.** `people_scopes` (one per (org, brand),
  carries `created_by_user_id` for the cron's org run) → `people` replaced in
  ONE transaction per build. `source_reads` keeps per source `not_connected |
  ok | failed`, presences read, and the source's OWN count for reconciliation.
  A sibling failure marks that source `failed` and the build continues; only a
  crm-service failure fails the build. lead-service answers are cached in
  `lead_standing_observations` (1 h, or until the person's next activity).
- **The first `GET /orgs/people` for a brand opens the scope** and kicks the
  build in the background: it answers `scope.status = "building"`, never an
  empty list posing as an answer. `POST /orgs/people/sync` forces a rebuild.
- **The timeline** (`timeline.ts`): Gmail per-address conversation,
  Instantly conversation per (campaign, address) — campaigns from the engaged
  row AND from lead-service, so a person cold-emailed but not engaged still
  shows the sends — Matrix raw events, GoHighLevel funnel events. Per source
  `ok | empty | not_connected | failed` + what was `asked`. A Gmail item carries
  `textClean {status, cleaned, original}` (null for other sources):
  google-service's `bodyCleanStatus` verbatim, `cleaned` true only for `cleaned`,
  `original` = `bodyTextOriginal`. google-service owns the cleaning; this only
  forwards it, so an uncleaned fallback is never silent to the reader.
  An Instantly item carries `outreachFact {subjectKey, step, position}` (null
  inbound, unmatched, and every other source): instantly-service's verbatim
  statement of WHICH `email_sent` fact the email is; `subjectKey` = lead-service's
  fact id / source ref, so the Unibox pairs email and label by identity, never by
  clock (the two stamps of one send differ by ~1 min). Stored items predating
  `STORE_FORMAT` 3 serve null until their background re-read.
- **Search = `GET /orgs/people?q=`** (`search.ts`), same order/paging/filters,
  plain case-insensitive substring, no model. Matches name, company (person +
  presences), any email (domain works), phone (4+ digits), and message text.
  Gmail + cold-email text is copied into OUR index (`people_message_texts`,
  trigram GIN; `people_message_units` = one per Gmail address / campaign x
  address, re-read only when the person's activity moved, the read failed, or
  it is a day old), refreshed right after each build; a failed read keeps the
  old text and shows in `search.messageIndex.failed`. Matrix text is searched
  in place. Each person gets `matches` (field + value, or message excerpt);
  blank `q` = the list byte for byte. The gateway forwards the query verbatim.
- **The timeline serves Gmail + cold email FROM THAT STORE** (`readStoredTimeline`,
  each stored row carries the full item, `format` 2): no sibling call on a read.
  A never-read address is read once on the spot; a store older than 60s
  (`PEOPLE_TIMELINE_REFRESH_MS`) is re-read in the background after the answer;
  lead-service campaign discovery runs there too. Sources carry
  `servedFrom: store|mirror` + `readAt`.
  ⚠️ **One message is stored ONCE per (scope, source, address)**
  (`people_message_texts_address_message_uq`): instantly-service answers a
  campaign's WHOLE family, so two campaign units of one lead read the same
  thread (18% of stored cold emails were twins, the Unibox showed each send
  twice, 2026-10-10). A cold email's key is `direction|at|from|to`
  (`instantlyMessageKey`, never the unit or the position), which splits prod
  exactly as the outreach fact's `subjectKey` does; the unit read second skips
  what another unit of the address already holds (advisory lock per address).
  The serve recomputes that key from the item, so a row an older build wrote
  (a rolled-back deploy did, 2026-10-10) never doubles; store format 4 makes
  such a unit due for a re-read.

## WhatsApp send — a campaign writes from the brand's linked number (`src/lib/whatsapp/send.ts`)

Owner 2026-10-12: a campaign (workflow-service, Windmill) writes first on WhatsApp.

**Contract:** `POST /orgs/whatsapp/messages`, `x-api-key` + `x-org-id` (+ `x-brand-id` or
body `brandId`; `x-campaign-id` recorded), body `{ email?, phone?, text, idempotencyKey,
fromAccount?, skipIfReplied? }`. 200 `{ sendId, status: "sent", duplicate, to, phoneSource,
fromAccount, roomId, eventId, sentAt, previousSends }`. Refusals 422 `{ type: "refused",
code, error }`: `whatsapp_not_linked` | `whatsapp_not_connected` | `no_phone_known` |
`not_on_whatsapp` | `person_replied` (only with `skipIfReplied`); 409 `send_in_progress`;
400 `invalid_request`; 502 `bridge_error`. `GET /orgs/whatsapp/messages?brandId=&email=|phone=`
lists the person's sends. No cost.
- Phone = `phone` if given, else the person's first phone from `people` (looked up by email).
- Account = the brand's `matrix_links` whatsapp `linked` rows whose bridge login is
  `CONNECTED` (`/whoami`), oldest first; one already in a DM with the number wins.
- Bridge `GET resolve_identifier/+<digits>?login_id=` (404 = not on WhatsApp), `POST
  create_dm` when no room, then `PUT rooms/{room}/send/m.room.message/{txnId}` as the
  account (join first). txnId = hash(org, brand, key): Matrix itself dedupes a retry.
- Idempotent: `whatsapp_sends` UNIQUE (org, brand, key); sent → same answer `duplicate: true`;
  refused → same refusal; failed or stuck `sending` > 2 min → retried.
- Into the thread: WhatsApp names counterparts by opaque LID ghosts (all 514 prod WhatsApp
  contacts had no phone). The send records `matrix_ghost_phones` (ghost → phone, the
  bridge's own answer); Matrix silver reads it, so the contact carries the phone. A sent
  row with email + phone is merge evidence `whatsapp_send`. After a send the connection is
  synced and the people scope rebuilt (unawaited), so the Unibox shows it within a minute.

- **Which account writes** (owner 2026-10-12: the pro number, not the personal one,
  unless a conversation already exists there): the account whose conversation with the
  ghost HAS MESSAGES (latest), else the link marked `outreach_default` (`PATCH
  /orgs/matrix/links/{linkId} {brandId, outreachDefault: true}`, one per brand+channel),
  else the oldest linked. An empty DM room is not a conversation.
- **WhatsApp threads merge into their person** (`lib/whatsapp/phone-resolution.ts`):
  WhatsApp names counterparts by LID ghosts (514/514 mirrored contacts had no phone, so 6
  of the first 13 people a campaign wrote to looked "never answered" while they had
  dozens of WhatsApp messages with the owner). Each people build first asks the bridge
  `resolve_identifier` ONCE per international phone the CRM knows outside Matrix
  (`whatsapp_phone_lookups`, global: LIDs are the same from every account; not-found
  re-asked after 30 days; ≤150 per pass, 400 ms apart), records `matrix_ghost_phones`
  and writes the phone on the brand's mirrored contacts of that ghost, so the build
  merges the thread on the phone key. `BuildSummary.whatsappPhones` reports it.

**Signup phones:** Clerk `derive` reads Clerk phone numbers THEN profile metadata
(`public_metadata` / `unsafe_metadata` keys `phone|phoneNumber|phone_number`; distribute.you
onboarding writes `public_metadata.phone`: 12 of 96 users, 0 Clerk phone numbers),
tagged `phoneSources [{phone, via}]`. brand-service sales-rep phones (5 phones fleet-wide,
1 matching a signup) are NOT read.

## Form trigger — a new CRM form fill starts the AI meeting booking (`src/lib/form-trigger/`)

Owner 2026-10-12 (Doc Dinners' Meta Ads form, FORM-TRIGGER-1012): every NEW form submission
in a brand's CRM is reported to campaign-service's generic trigger door
(`POST /internal/trigger-events`, trigger `form_submitted`) within ~1 min, naming the person.

- **Poll, not webhook**: a GoHighLevel Private Integration Token cannot subscribe webhooks
  (marketplace apps only). In-process loop every 60s (`FORM_WATCH_INTERVAL_MS`, first pass 60s
  after boot, one at a time): per connection not paused, `GET /forms/submissions` for the last
  1-2 days (one page, ~0.9s). Writes NOTHING to bronze: the 15-min sync still sees each submission
  as changed and derives it.
- **New, once, never history**: `ghl_connections.form_watch_since` set at the first look (the
  baseline, nothing reported); only submissions made after it count. One `form_trigger_reports`
  row per submission (UNIQUE org, brand, source, submission id). campaign-service gets
  `idempotencyKey = crm:<source>:form_submission:<id>` (replay = its first event).
- **Skipped, recorded, never sent**: a calendar's own booking form (`calendar_booking_form`:
  a mirrored calendar's `formId`, or the record's `others.internalSource.type = "calendars"`),
  a fill with no email (`no_email`, logged: campaign-service files a person by email only).
- **Body** (campaign-service's `RecordTriggerEventBody`, strict): `person {email, name?, phone?,
  crmContact {provider, contactId}}` (absent values OMITTED, never null) + opaque `item {source,
  submissionId, formId, formName, submittedAt, answers [{key, label, value}], crmContactId}`
  handed verbatim to the workflow. `answers` = `others.fieldsOriSequance` order minus identity
  keys and GoHighLevel's fixed non-answer elements; labels from `GET /locations/{id}/customFields`.
- **Offer**: stated per form (`PUT /orgs/gohighlevel/form-offers {brandId, formId?, offerId}`,
  omitted formId = every form) > the brand's ONLY active offer > `offer_unknown` (not sent, loud).
- **Detection kicks the brand's GoHighLevel sync + people build** (unawaited) and reports at
  once: lead-service only serves a person it knows from our fact feed; campaign-service holds a
  `person_not_known` event `pending` and retries it 60 min.
- Retries: 5xx / unreachable / offer unknown with backoff 1→60 min for 24h after the submission;
  400/422 = final `campaign_refused`. One ORG run per (org, brand) per delivery batch.
- Reads: `GET /orgs/gohighlevel/form-triggers?brandId=` (submittedAt / detectedAt / reportedAt /
  campaign event). `POST /internal/form-triggers/watch` runs a pass now.

## Reply trigger — a person answering a thread our campaign opened gets the AI responder (`src/lib/reply-trigger/`)

Owner 2026-10-12 (WA-RESPONDER-1012): a person who answers, on a personal channel we mirror, a
thread one of our campaigns wrote to THROUGH OUR SEND ROUTE is reported to campaign-service's
trigger door as `positive_reply_received` (what the email path fires for an answer) for the
offer of the campaign that wrote (`GET /campaigns/{id}` `offerId`). Same door as the form trigger
(`lib/trigger-door.ts`, the one client of `POST /internal/trigger-events`).

- **Runs inside the Matrix sync pass** (cron 5 min + right after each of our sends), after bronze +
  silver: `detectReplies` per connection, `deliverDueReplies` at the end of `runSyncPass`. The
  timeline serves Matrix live from bronze, so it holds the message when we report; delivery waits
  until the brand's `people` hold the conversation (`person_not_built` → rebuild → deliver).
- **Rules = `thread.ts`, pure, channel-agnostic** (a room + our sends in it, `whatsapp_sends`
  today): no campaign send in the room = never read (personal chats); only what follows the FIRST
  campaign send counts; the person's human words since our last outbound = ONE burst = ONE row
  (`reply_trigger_reports`, UNIQUE on its first message, `idempotencyKey crm:matrix:reply:<event>`);
  any outbound of ours ends it; an account message that is NOT one of our sends after the campaign
  wrote (typed on the phone) = `human_took_over`, for good; bridge notices / uncaptioned media /
  edits are no answer; any brand send `sending` < 2 min holds the pass (its event would read as
  hand-typed). Jev (`person|automated`, one call per burst, >= 0.75 silences; Jev down = person)
  drops auto-replies (`automated_reply`; a person writing after it in the burst is still reported).
- **Never history**: `matrix_connections.reply_watch_since` set at first look; a burst none of whose
  messages was mirrored after it = `before_watch`. Rooms re-read = campaign rooms with a message
  ingested in 24h, so a failed pass heals on the next.
- **Body**: `person {email, name?, phone?}` (email = the address the campaign sent to when the
  person holds it, else their first; none = `no_email`, logged by name, not sent) + `item {kind:
  "reply", source, channel, campaignId, personId, conversationId, roomId, firstMessageAt,
  lastMessageAt, messages [{eventId, at, text}]}` (burst re-read at delivery, 2000 chars/message).
  Retries 1→60 min for 24h; 400/422 final `campaign_refused`. Read: `GET /orgs/matrix/reply-triggers?brandId=`.
- A LinkedIn (or any) send route only has to land its sends in the lookup `thread.ts` reads.

## Boot: the port binds BEFORE migrations

`src/index.ts` listens first, then migrates; until migrations finish every
route but `/health` / `/openapi.json` answers 503. A data migration that held
the old pre-listen boot past deploy.sh's 60s window rolled the deploy back,
and the OLD code then wrote onto the NEW schema (0020, 2026-10-10).
- **The freshness watch keeps the store current BEFORE an open** (`freshness.ts`,
  in-process, every 60s, first pass 60s after boot). Per scope it reads what MOVED:
  instantly-service's outreach fact feed (cursor `people_scopes.outreach_facts_cursor`,
  facts recorded > 1 day ago only walked past) and Gmail correspondents (most recent
  first, `change_mark` = last `lastMessageAt` seen). A moved unit gets `changed_at`,
  is re-read now and once more 5 min later (sibling read trailing its signal). An
  open re-reads inline ONLY a unit stored before its `changed_at`; an unchanged
  thread never waits. Why: the build's activity date ignores replies WE send
  (written-to `lastSentAt` = last sequence step), so Robert Burke's automated
  follow-up stayed out of his thread 10 h (2026-10-10). Our own replies reach the
  fact feed only once instantly-service states them (UNIBOX-OUR-REPLIES-FACT-1010).
- **Family filters (Unibox Won / Hot / Lost / Cold, `families.ts`)**: `GET /orgs/people?family=won|hot|lost|cold`
  (combines with `q`, `source`, paging). Each person carries `family` + `familyLostReason`
  = features-service's verdict (`GET /brands/{brandId}/lead-families`, read verbatim, matched on
  email; several lead addresses → strongest, features' own union rule). Null = not our lead.
  `families.counts` = per family over the list's population with `family` NOT applied (the
  buttons), sum = `withFamily`; `producerCounts` = features' own over ALL leads. One read
  (~4 MB, ~1s warm / ~25s cold) shared 60s per (org, brand), failures not cached. Every sibling GET
  (`siblings.ts`) retries a CONNECT failure (refused/reset, a sibling mid-deploy: ~2s) at
  250/500/1000/2000 ms; an answered 4xx/5xx or our own timeout is never retried. Read fails →
  `families.status=failed` + `error`, All still lists, `family=` answers 502
  `lead_families_unavailable`. Env `FEATURES_SERVICE_URL` + `_API_KEY`. Moves with the list to
  lead-service's conversation gold (#61).
- Cron on the box, every 15 min: `/root/distribute/people-sync-cron.sh` →
  `POST /internal/people/sync` (platform run = the trigger; one ORG run per
  scope). Env: `GOOGLE_/INSTANTLY_/LEAD_/BRAND_SERVICE_URL` + `_API_KEY`.
- Gateway: api-service proxies `/v1/orgs/people*` (explicit routes; the crm
  proxy forwards per route, not by prefix).

## The people fact feed — what happened, untagged (`src/lib/people/facts.ts`, contract #61)

lead-service owns the tags (one per timeline item + one overall per
conversation); crm-service is the ONE door from the client's own accounts and
serves it a dated, UNTAGGED fact feed. `people.state` / `state.ts` stay until
lead-service serves the overall tag, then go.

- `GET /internal/people/facts?since=&limit=&orgId=&brandId=` (apiKeyAuth,
  platform run) → `{ facts, nextCursor, hasMore }`, total order on
  `people_facts.feed_seq`. Fact = `factId, seq, orgId, brandId, personKey,
  emails, phones, fullName, sourceContactId, crmContactId, type, occurredAt,
  dateBasis, source, sourceRef, payload, withdrawnOf?`. `sourceContactId` = the
  vendor's contact id; `crmContactId` = OUR `contacts.id` (what funnel-events
  serves as `contactId`, and what lead-service's pairings are keyed on). A
  disconnect + reconnect re-mints row ids: every live fact whose vendor contact
  now sits on a new row is `withdrawn` (`crm_contact_reminted`) and re-stated
  with the new id, history facts included, so the id always names a row the
  contacts reads still serve. A snapshot record counts as gone only once its
  connection has finished a full sync (`last_synced_at`).
- **Emitted after every people build** (`emitScopeFacts`, recorded as
  `sourceReads.facts`; a failure never undoes the build). Candidates are
  re-derived from silver + the Gmail store and DIFFED on a natural key (vendor
  id + what about it) and a content hash: new key → fact; same hash → nothing (a
  re-sync emits 0); changed hash → `withdrawn` + a new fact. The first pass is
  the backfill. One global advisory lock per emission so seqs commit in order.
- Types: GoHighLevel `added_to_crm` (contact, dated `created_at`), funnel facts
  `form_submitted | meeting_booked | meeting_attended | meeting_not_held | sale
  | deal_lost` built from `eventsQuery` (THE funnel-events evidence: payload
  `via` = its `source`, `sourceRef` = its `sourceId`, same date + basis, so the
  two cannot disagree), `deal_status_changed` (every history row); Matrix and
  Gmail `message_in/out` (Gmail `other` = a third party, skipped); PostHog
  `signup` (person created) + `website_visit`; Stripe `payment | refund`
  (minor units verbatim) + `subscription_changed` (one per status observed);
  CSV `added_to_crm` (once per email, dated `uploaded_at`); crm
  `person_merged | person_split | withdrawn`. GoHighLevel `sale.amountMinor` =
  deal value × 100 (GoHighLevel states no currency; `amountVerbatim` beside it).
- OUT: our own outreach (Instantly, self-send) — lead-service reads it directly.
- **`withdrawn` only when the vendor record changed or vanished**, and a
  vanished record is withdrawn only in a SNAPSHOT family (GoHighLevel contacts
  + funnel, PostHog, Stripe money) while that source is still connected.
  **Disconnect stops the feed, never withdraws**: no FK to any connection, so
  emitted facts survive a delete. History families (stage history, messages,
  subscription statuses, CSV) never withdraw on absence.
- `occurredAt` is the vendor's date or NULL; `dateBasis` names it. Never now().
- A fact's subject is re-found by the vendor's id (`<source>:<externalId |
  channelHandle | email>`), so a reconnect re-finds the person. A subject the
  build holds as nobody (the brand's own address) is HELD: not emitted, not
  withdrawn. After each build, every fact already emitted is re-owned: an old
  key whose facts now sit under 2+ keys → `person_split` (every fact in exactly
  one part; a fact nobody holds stays under the old key); all moved to one key
  → `person_merged`. Order inside a pass: splits, merges, withdrawals, new facts.
- Bookkeeping columns (`live`, `owner_person_key`, `subject_*`, `natural_key`,
  `content_hash`) are never served; every served column is append-only.
  ⚠️ **Never UPDATE a served column, not even in a migration that adds a new
  served field**: lead-service's bronze copies each fact once and never re-reads
  it. A new field reaches old facts as `withdrawn` + re-emit. (v0.18.0 backfilled
  `crmContactId` in place before lead-service read the feed; lead-service had to
  empty and re-pull. Allowed once, never again.)

## Outcomes — every person who reached a step, any source (`src/lib/people/outcomes.ts`)

Dashboard v2 Outcomes page. lead-service's buckets cover only leads WE contacted;
this answers the same steps for everyone the brand's own tools state.

- `GET /orgs/people/outcomes?brandId=` → `steps[]` (all six, funnel order):
  `{ step, people, sources: [{source, people}], contactedByUs }`.
  `GET /orgs/people/outcomes/people?brandId=&step=&limit=&offset=` → `{ total,
  people: [{ personId, personKey, displayName, company, emails, phones,
  reachedAt, sources: [{source, reachedAt}], contactedByUs, state, stateSource }] }`,
  earliest first, total order on person key; `total` == that step's `people`.
- Step tokens = lead-service's buckets: `website_visit`, `signup`,
  `form_submission` (fact `form_submitted`), `meeting_booked`,
  `meeting_attended`, `sale` (fact `sale` OR a `payment` that STANDS: succeeded,
  net of refunds > 0 — lead-service's `paymentStands`).
- Read off LIVE `people_facts`, person = `owner_person_key` (re-owned on merge /
  split), so Clerk + PostHog signups of one human count once and withdrawn facts
  count for nothing. `contactedByUs` = Instantly presence or lead-service state.
- **PLUS source `campaigns`**: lead-service's bucket of the same token
  (`GET /orgs/leads?bucket=&view=compact`, every page), matched onto people by
  email (else its own `email:<addr>` person). All sources ⊇ "from our
  campaigns" on every step (prod 2026-10-11: PostHog knew 83 visitors,
  lead-service 189 clickers). Undated (lead-service states no bucket date).
  lead-service unreadable → 502 `campaign_outcomes_unavailable`, never a lower
  figure posing as all sources.
- Gateway: api-service `/v1/orgs/people/outcomes[/people]` (explicit proxies).

## Leg reach — how the brand's OWN team converts on one leg (`src/lib/people/leg-reach.ts`)

features-service fills every "your team" pipe (meeting booking, attendance, closing,
signup conversion...) off this. Service-auth, org-less, read-only on our gold: NEVER
opens a scope or builds, no vendor call, no model, no cost.

- `GET /internal/people/leg-reach?brandId=&from=&to=[&orgId=]` → `{ brandId, orgId,
  fromStep, toStep, scope, connectedSources, stepSources {from,to}, available, reason,
  reasons[], reachedFrom, reachedTo (+ toBeforeFrom), excluded {contactedByUs,
  automated, notBusiness} }`. Each end = `{ people, undated, byDay [{day (UTC),
  people}], sources [{source, people}] }`; `byDay` sum + `undated` = `people`.
- `GET /internal/people/leg-reach/brands` → every people scope with `connectedSources`
  + `recordedSteps` (the steps a leg can start or end on): the fleet scope.
- **`lead_found`** (FROM only; TO = `to_step_not_recorded`): every person the people
  index HOLDS for the brand (any source; the "Your CRM Contacts" origin), plus live fact
  owners no longer indexed; dated on the person's EARLIEST live non-meta fact (CRM
  creation, CSV upload, first message...), else undated; same exclusions and TO rule.
  In `recordedSteps` whenever the scope holds a person; NOT used to pick the answering
  org of a multi-org brand (that stays on fact-recorded steps). Doc Dinners: the base of
  its "Lead found -> Paid client" team leg.
- Steps: `conversation` (NEW: a live `message_in` fact, Gmail / Matrix = the person
  WROTE to the brand), `website_visit`, `signup`, `form_submission`, `meeting_booked`,
  `meeting_attended`, `sale` (same evidence as Outcomes, payment must stand). Aliases
  `form_submitted`, `paid_client`. Recording sources per step = `STEP_SOURCES`.
- **A calendar's own booking form is the BOOKING, never `form_submission`**
  (`NOT_CALENDAR_BOOKING_FORM`, outcomes.ts, used by leg reach AND Outcomes): a
  `form_submitted` fact whose `formId` a mirrored calendar states as its `formId`
  is dropped. Structural, every brand; never a form name. `form_origin` (a contact
  a form / survey created, no form named) stays a form step: GoHighLevel tags a
  contact a calendar created with medium `calendar`, never `form` (Doc Dinners:
  304 of 308 form_origin = the Meta Ads form's own mediumId, 3 a survey).
- **Population** = people (fact owner) who reached FROM, minus `CONTACTED` (Instantly
  presence / lead-service lead), minus `automated` and `not_business` people. A fact
  owner no longer in `people` is kept. TO counts only on or after the UTC DAY of the
  first FROM (same day either order counts; undated end counts); TO only before =
  `toBeforeFrom`, not counted. `reachedTo.byFromDay` (+ `undatedFrom`) = the same TO
  people filed on their first-FROM UTC day (cohort: per period TO ⊆ FROM); `byDay` keeps the TO day.
- **Reasons, never 0**: `no_people_scope` | `not_synced` (scope never built, or every
  recording source of an end connected but never read OK) | `no_connected_source` |
  `from_step_not_recorded` | `to_step_not_recorded` (with `step` + `recordedBy`).
  "Connected" = the scope's last build `source_reads` status `ok|failed`.
- A brand with several org scopes (Doc Dinners has an empty second one): the scope
  whose sources record a step answers; two such → 409 `orgIds`, pass `orgId`.
- `conversation` is NOT on `/orgs/people/outcomes`: that read keys lead-service's
  bucket tokens, whose campaigns twin is `positive_reply` (a reply to OUR email),
  a narrower thing; the dashboard maps it on its own.

## PostHog + Stripe — what a person DID and what they PAID (`src/lib/posthog/`, `src/lib/stripe/`)

Same contract as GoHighLevel: credential in key-service (provider `posthog` /
`stripe`, brand-scoped, NO org fallback), connection written only once the key
is PROVEN against the vendor, refusal = `{ type: "vendor", vendorStatus,
vendorError }` in the vendor's words, no write path, bronze `*_raw_records`
(vendor id + content-hash no-churn) → silver, one ORG run per connection, cron
`*/15` on `/internal/{posthog,stripe}/sync`, `/internal/{posthog,stripe}/rebuild`
re-derives silver with no vendor call. API reads are free → no cost declared.

- **PostHog**: body `{brandId, projectId, region: us|eu}`; the host is derived
  from `region`, never taken from the caller (no SSRF). Reads go through the
  HogQL query API (a POST that only needs `query:read`). ⚠️ PostHog REFUSES
  `OFFSET` on personal-API-key queries → keyset pagination only. Only
  identified persons (`properties.email`) are read; anonymous visitors never
  leave PostHog. Silver: `contacts` (source `posthog`) + `posthog_activities`
  (`visit` = one session aggregated over ALL its pageviews, `event` = custom
  non-`$` event). Window = `synced_through - 1h`; a capped stream resumes from
  its last row.
- **Stripe, N accounts per brand**: each connection names the key-service
  provider holding its key (`credential_provider`: `stripe` = first account,
  `stripe-<label>` each further one; key-service registers any provider name,
  so no change there). `account` = `GET /v1/account` id + name when the key may
  read it. The same account twice → 409 (account id, or its newest objects
  already mirrored). Disconnecting ONE account withdraws none of its facts (a
  Stripe record counts as gone only while some account still mirrors it), and
  a not-yet-synced account never hides the others (`connectionHealth`).
- **Stripe**: only a RESTRICTED key (`rk_live_`/`rk_test_`) is accepted; `sk_`
  is refused before any call. Silver: `contacts` (source `stripe`) +
  `stripe_transactions` (`payment` | `refund` | `subscription`, amount in MINOR
  units verbatim + currency + Stripe status). Passes re-list the last 30 days;
  a full re-list runs daily (`last_full_sync_at`).
- **Person layer**: both are `PEOPLE_SOURCES`; a Stripe customer with email +
  phone is merge evidence (`stripe_customer`). State precedence: lead_service >
  **stripe** (`subscription_<active|trialing|past_due|unpaid>` > `paid` >
  `refunded` > `subscription_canceled`) > gohighlevel > matrix > instantly.
  A connection whose first sync has not succeeded reads `failed`, never 0.
- **Dogfood**: Distribute.you's own Stripe is connected like any client
  (restricted key in key-service under its brand), NOT read from
  stripe-service: one path for every brand.

## Auth providers — every signup of the brand's product (`src/lib/auth/`)

Clerk today; Supabase Auth / Auth0 / Firebase Auth are siblings to come: ONE
adapter file implementing `AuthProviderAdapter` (`provider.ts`: `countUsers`,
`listUsers`, `derive`, `rejectKey`) + one line in `AUTH_PROVIDERS`. Routes
(`/orgs/<p>/connections` POST/GET/PATCH/DELETE, `/internal/<p>/sync|rebuild`),
sync, people source and fact feed iterate the registry; the people source /
fact source literal (`"clerk"`) is the one per-provider line in `identity.ts` /
`facts.ts` / `build.ts` / `timeline.ts`.

- Same contract as PostHog/Stripe: secret key in key-service (provider = the
  provider's name, brand-scoped, NO org fallback), connection written only once
  the key PROVED it can count the users, refusal in the vendor's words. Connect
  kicks the first sync at once; cron `*/15` on `/internal/clerk/sync`.
- Bronze `auth_connections` (one per (org, brand, provider)) + `auth_raw_records`
  (user verbatim, content-hash no-churn). ⚠️ Clerk `private_metadata` is NEVER
  stored (brands keep server secrets there). Silver = `contacts` (source = the
  provider), `raw_attributes.emails` = every VERIFIED address (unverified =
  possibly a typo = never a merge key), primary first.
- Full re-list every pass (500/page, oldest first). A pass that listed at least
  the provider's own count is COMPLETE: users it did not list are deleted from
  bronze + silver (a deleted account is no signup; its fact is withdrawn).
  Fewer listed (page cap, mid-pass delete) removes nothing.
- People: source `clerk`, presence `userIds = [Clerk user id]`. Fact: `signup`,
  dateBasis `user_created_at`, family `clerk_user` (snapshot) — the vocabulary
  PostHog signups use; lead-service reads `source` as a free string.
- **The `uid:` identity key** (`identity.ts`): the brand's own user id. Clerk
  states it; a PostHog person states every distinct id. Two tools of one brand
  naming the same id is positive evidence — it is what ties a PostHog person
  PostHog holds no email for to the signed-up user. A cluster of PostHog
  presences alone with no email and no phone is nobody (`isUnnamedPosthogOnly`),
  its facts are held until the auth provider names it.

### PostHog "identified" (fixed 2026-10-11)

The PostHog mirror used to read persons WITH an email property only: on
distribute.you's own project that was 56 of 136 signed-up users (151 persons,
136 carrying a Clerk `user_…` distinct id). Now: `is_identified` OR an email
(107), plus every NOT-identified person carrying one of the brand's auth user
ids as a distinct id (29: server-side captures keyed on the Clerk id never set
`is_identified`), plus up to 50 distinct ids per person. ⚠️ HogQL:
`notEmpty(toString(NULL))` is NULL, so `NOT (a OR notEmpty(...))` silently drops
every email-less person — `IDENTIFIED` is built strictly boolean. ⚠️ A HogQL
query without LIMIT answers 100 rows. A person mirrored for the FIRST time on a
later pass gets its whole activity history read (the window would miss it).

## Copilot chat — the staff Unibox's chat source (`src/lib/copilot/messages.ts`)

The distribute.you Copilot (chat-service's agent) is a member of OUR staff (owner
2026-10-11: « l'AI Chat fait partie de notre staff »): every chat turn is a staff
conversation with that person, shown on their Unibox thread like a staff Gmail.

**Contract (chat-service conforms to it):** `POST /internal/copilot/messages`,
`x-api-key: CRM_SERVICE_API_KEY`, after each Copilot turn, body
`{ orgId, userId, email, displayName?, sessionId, messages: [{ messageId, role: "user"|"assistant", text, at }] }`
(org/user = chat-service's internal uuids of who chatted; `email` = the match key;
`messageId` = chat-service's message id; `at` = ISO time it was written; 1-50 messages).
200 `{ stored, duplicates }`; 400 validation; 401 key; 502 run tracking down (nothing
stored, retry); 503 `not_configured` (staff scope unset, nothing stored). Retrying is
always safe.

- **PRIVACY is structural:** the filing scope is NOT in the request. It is
  `COPILOT_UNIBOX_ORG_ID` + `COPILOT_UNIBOX_BRAND_ID` (staff org f0420eb5… +
  distribute.you brand f4d73dab…). `readCopilot` / `copilotItems` answer
  `not_connected` for every other (org, brand), org AND brand compared (the brand id
  is also attached to test orgs). Never add a scope field to the request.
- **Idempotent on `messageId`** (unique index): a turn pushed twice shows once; the
  first text wins. A chat the user deletes on chat-service STAYS (staff record).
- **Thread:** source `copilot`, channel `chat`, `role=user` → inbound `from` the
  user's email, `role=assistant` → outbound `from` `"AI Copilot"`. Read on the spot by
  the person's addresses, so a turn shows on the next open; the people LIST picks up a
  brand-new chatter at the next build (cron 15 min). Chatters on the brand's own
  domain (staff) are own addresses: nobody, like any source.
- No cost (DB only, platform run), no customer org billed, no facts emitted (not in
  the lead-service fact feed yet), not in the message search index yet.

## API / MCP calls — the staff Unibox's API source (`src/lib/api-calls/calls.ts`)

A client talking to us in person, through the Copilot, or through their own
assistant calling our API / MCP server is ONE kind of exchange: a conversation
(owner 2026-10-12). api-service pushes every call made with a client's own key.

**Contract (api-service conforms to it):** `POST /internal/api-calls`, `x-api-key`,
body `{ calls: [ApiCall] }` (1-100, see openapi; the route has its own 16 MB JSON
limit, the sender keeps batches under 8 MB). api-service has ALREADY redacted every
secret (no auth header, no key: a sha256 fingerprint; secret-named fields and
key-looking values replaced) and cut each body at 256 KB. 200 `{ stored, duplicates,
skippedNoEmail }`; 503 when the staff scope is unset. Idempotent on `callId`.

- **Same structural privacy as the Copilot:** filed ONLY under `COPILOT_UNIBOX_ORG_ID`
  + `COPILOT_UNIBOX_BRAND_ID`; every other (org, brand) reads `not_connected` / 404.
- **Thread:** source `api`, channel `api` (their code/assistant) or `mcp` (our MCP
  server, it sends `x-distribute-client: mcp`). Each call = 2 messages: inbound from
  the caller's email with a plain-words summary (`describeRequest`: "Listed emails for
  brand AscendQE", brand names read from brand-service, cached 1 h), outbound from
  `"distribute.you API"` (`describeResponse`: "Answered: 12 emails (200, 120 ms)",
  "Refused (403): …"). `ref.callId` opens the whole call
  (`GET /orgs/people/api-calls/{callId}?brandId=`), `ref.sessionId` = first call of a
  burst (same channel, gaps under 30 min).
- No cost (platform run), no facts, not in the message search index.

## Owner Telegram ping at each conversation START (`src/lib/conversation-pings.ts`)

Owner 2026-10-12: a Telegram message each time someone starts a conversation with
us through the Copilot or our API / MCP. Same bot and chat as the fleet's owner
alerts (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`); names and the Unibox
link come from client-service (`CLIENT_SERVICE_URL` / `_API_KEY`).

- **One conversation** = one Copilot session (again after 30 min of silence in
  it), or one person's API / MCP calls on one channel, gaps under 30 min (same as
  `sessionsOf`). One ping per START, never per message or call.
- **Staff never pings:** a staff address (`isStaffEmail`, mirrored from
  client-service / billing) or a user id EVER stored with one (copilot_messages or
  api_calls), so a session of a person ever him stays silent under any address.
- **Never twice:** the start is written to `conversation_pings` under
  `pg_advisory_xact_lock` per conversation BEFORE the send; a candidate is skipped
  when the conversation had activity in the 30 min before it OR a ping within
  30 min either side (out-of-order and concurrent batches). At most once: a failed
  send is marked `failed` with the error, never retried.
- **Never slows the push:** the routes answer, then run the announce unawaited; it
  never throws. Each lookup (org name, user name, brand names, link) fails alone:
  its line is dropped and logged, the ping still goes.
- **The link** opens the person's thread in the staff Unibox
  (`/v2/orgs/<staff Clerk org>/brands/<brand>/unibox?person=<personId>`). A brand-new
  person has no id until the next people build, so the id is minted into
  `person_ids` exactly as the build would (the build adopts it).
- **Logged-out visitors** have no AI chat and no API access: the only chat open to
  them is the landing live chat (human, apps/landing `/api/chat`), which already
  relays EVERY visitor message to the same Telegram chat. Nothing to add here.

## Brand transfer (`POST /internal/transfer-brand`, fleet contract)

brand-service moves a brand to another org by calling this route on every
service. Body `{sourceBrandId, sourceOrgId, targetOrgId, targetBrandId?}`,
apiKeyAuth, response `{ updatedTables: [{ tableName, count }] }`
(`src/lib/transfer-brand.ts`).

- **Every table carrying `brand_id` moves** (all 31: CSV, serves, Matrix,
  GoHighLevel incl. history + stage meanings, PostHog, Stripe, the fact feed). Only `org_id` / `brand_id` change;
  FKs are on row ids so the graph stays wired. Provenance (`run_id`,
  `created_by_user_id`) stays as recorded.
- **ONE transaction** — all or nothing. A unique collision in the target (it
  already has its own CRM for that brand) rolls back and answers 409.
- **Idempotent**: a row already at (target org, final brand) is not matched, so a
  re-run reports 0 everywhere; a half-move from an earlier call without
  `targetBrandId` is finished.
- ⚠️ **A new table with `brand_id` must be added to `TRANSFER_TABLES`** —
  `tests/unit/transfer-brand.test.ts` fails otherwise.
- The GoHighLevel credential lives in key-service, which moves it in its own
  transfer; the sync resolves it under the connection's (new) org.
- ⚠️ **Registering the route is not enough to be CALLED.** brand-service finds
  participants through api-registry, which only indexes services listed in its
  env (`CRM_SERVICE_URL`), and calls each with `CRM_SERVICE_API_KEY` from its
  OWN env. crm-service was in neither until 2026-09-27, so the fan-out would
  have skipped the CRM silently. Both now live in `env/api-registry-service.env`
  and `env/brand-service.env` on the box.

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

**Each integration file owns its OWN id prefix** (`grep -rhoE "[a-f]{8}-1111" tests`
before picking one) and TRUNCATEs what it seeded in `afterAll`: the suites run
serially on ONE database and each only wipes its own tables, so a second suite
reusing a brand id inherits leftover connections (2026-10-08: the fact-feed
suite reused `eeeeeeee-…` and posthog-stripe's timeline read GoHighLevel and
Matrix as connected — green alone, red in CI).

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

## Local tests: integration files SKIP silently without `CRM_TEST_DB=1`

`npx vitest run` with no env prints `7 skipped` and green: every integration
file is `describe.skipIf(!RUN)`. To run them, create a scratch DB, export the
`env:` block of `.github/workflows/*.yml` (`CRM_TEST_DB=1`, fake service URLs,
`CRM_SERVICE_DATABASE_URL` → the scratch DB), `npm run db:migrate`, then
`npx vitest run`. A run with any `skipped` file is not the gate. (Set 2026-10-08.)

## Release: there is no `staging` branch here

crm-service ships straight to `main`: open a PR with `--base main`, merge it
once CI is green, then tag the next version by hand at the merge commit
(`gh release create vX.Y.0 --target <mergeCommit sha>`). `release.sh hotfix` /
`promote` assume a `staging` branch to sync to, so do not use them here. The box deploys
`main` within ~5 minutes. Verify against the SERVED `openapi.json` inside
`distribute-crm-service-1`, not the clone.

## Env vars

`CRM_SERVICE_DATABASE_URL`, `CRM_SERVICE_API_KEY`, `RUNS_SERVICE_URL`, `RUNS_SERVICE_API_KEY`,
`CHAT_SERVICE_URL`, `CHAT_SERVICE_API_KEY`, `MATRIX_HOMESERVER_URL`,
`MATRIX_ACCESS_TOKEN`, `MATRIX_INGESTION_FLOOR`, `CRM_LEAD_READING_CHAT_CONFIG`,
`KEY_SERVICE_URL`, `KEY_SERVICE_API_KEY`, `GOOGLE_SERVICE_URL`, `GOOGLE_SERVICE_API_KEY`,
`INSTANTLY_SERVICE_URL`, `INSTANTLY_SERVICE_API_KEY`, `LEAD_SERVICE_URL`, `LEAD_SERVICE_API_KEY`,
`BRAND_SERVICE_URL`, `BRAND_SERVICE_API_KEY`, `FEATURES_SERVICE_URL`, `FEATURES_SERVICE_API_KEY`, `MATRIX_APPSERVICE_TOKEN`,
`COPILOT_UNIBOX_ORG_ID`, `COPILOT_UNIBOX_BRAND_ID` (the staff Unibox scope Copilot turns are filed under; unset = 503),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `CLIENT_SERVICE_URL`, `CLIENT_SERVICE_API_KEY` (the owner's conversation pings; unset = logged, nothing sent),
`CAMPAIGN_SERVICE_URL`, `CAMPAIGN_SERVICE_API_KEY` (the form-trigger reports; unset = detected, not reported),
`MATRIX_WHATSAPP_PROVISIONING_URL`, `MATRIX_WHATSAPP_PROVISIONING_SECRET`
(+ `MATRIX_TELEGRAM_*` once its bridge runs).
See `.env.example`. The four Matrix ones are REQUIRED for the sync to run at all —
without them `/internal/matrix/sync` fails loud instead of silently no-op-ing.
The two `KEY_SERVICE_*` ones are REQUIRED for GoHighLevel — they are how the
brand's credential is resolved, and crm-service holds no copy of it.
