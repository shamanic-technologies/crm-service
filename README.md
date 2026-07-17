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
