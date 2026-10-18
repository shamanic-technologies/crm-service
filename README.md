# crm-service

Ingests a client's own B2C CRM CSV exports as contacts, for email outreach that
bypasses Apollo lead-gen. Lead-provider sibling of `apollo-service` and
`apify-service` in the chain `lead-service -> human-service -> {apollo | apify | crm}`.

This service owns **only the ingestion side**: upload a CSV, store it with
Bronze/Silver/Gold data layering. Serving contacts to human-service, the
api-service proxy, and the dashboard UI are separate later tasks.

## Endpoints

| Method | Path | Tier | Auth |
|--------|------|------|------|
| `GET` | `/health`, `/openapi.json` | public | none |
| `POST` | `/internal/contacts/promote` | internal | `x-api-key` |
| `POST` | `/orgs/contacts/upload` | org | `x-api-key` + `x-org-id` + `x-user-id` |
| `GET` | `/orgs/contacts?brandId=` | org | `x-api-key` + `x-org-id` |
| `GET` | `/orgs/contacts/uploads?brandId=` | org | `x-api-key` + `x-org-id` |
| `POST` | `/internal/copilot/messages` | internal | `x-api-key` |
| `POST` | `/internal/api-calls` | internal | `x-api-key` |
| `GET` | `/orgs/people/api-calls/{callId}?brandId=` | org | `x-api-key` + `x-org-id` + `x-user-id` |

`POST /internal/copilot/messages` is how chat-service files each Copilot chat turn
(user message + answer) on the staff Unibox: body `{ orgId, userId, email,
displayName?, sessionId, messages: [{ messageId, role: "user"|"assistant", text, at }] }`,
idempotent on `messageId`, filed ONLY under `COPILOT_UNIBOX_ORG_ID` /
`COPILOT_UNIBOX_BRAND_ID` (never the chatting org). Full contract in `CLAUDE.md`
("Copilot chat") and `openapi.json`.

The other way round, a person writing on the Copilot's own WhatsApp line (the
automation-on account of the Copilot's brand) is handed to chat-service
`POST /internal/copilot/channel-messages` instead of firing a reply trigger; the
Copilot answers through `POST /orgs/whatsapp/messages`. A sender whose number is a
WhatsApp account linked in Integrations carries `sender.linkedBy {orgId, userId}`
(who linked it), so the Copilot answers with that user's access. The brand's own
linked numbers are never "taken over by a human", so the owner testing from
his own numbers is always answered. See `CLAUDE.md`
("Reply trigger", SOPHIE-COPILOT-WA-1018).

`POST /orgs/contacts/upload` is `multipart/form-data`: `file` (CSV), `brandId`
(required), `columnMapping` (optional JSON override). Bronze is written in chunked
batches; silver promotion is kicked off asynchronously after the response returns.

## Data layering

- **Bronze** — `contact_uploads` (one row per upload, natural key = content hash)
  + `contact_rows_raw` (one row per CSV row, `UNIQUE(upload_id, row_number)`).
- **Silver** — `contacts`, deterministically projected from bronze, deduped on
  `(org_id, brand_id, lower(primary_email))`. Zero per-row LLM.
- **Gold** — `sendable_contacts` view: valid email, not unsubscribed, consent not denied.

Column typing (which column is email/phone/name) is one chat-service `/complete`
call per upload, or a caller-supplied override. See `CLAUDE.md` for details.

## Development

```bash
pnpm install
pnpm db:generate      # generate migrations from src/db/schema.ts
pnpm build            # tsc + generate openapi.json
pnpm test
pnpm dev              # tsx watch
```

Env: see `.env.example`.
