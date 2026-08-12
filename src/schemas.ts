import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { COLUMN_FIELDS } from "./lib/column-typing.js";
import { MATRIX_CHANNELS } from "./lib/matrix/events.js";
import { LEAD_STATUSES } from "./lib/matrix/leads.js";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const ColumnFieldSchema = z.enum(COLUMN_FIELDS);

export const ErrorResponseSchema = registry.register(
  "ErrorResponse",
  z
    .object({
      type: z.string().openapi({ example: "validation" }),
      error: z.string().openapi({ example: "x-org-id header required" }),
    })
    .openapi("ErrorResponse"),
);

// ─── Upload ──────────────────────────────────────────────────────────────────

export const UploadResponseSchema = registry.register(
  "UploadResponse",
  z
    .object({
      uploadId: z.string().uuid(),
      rowCount: z.number().int(),
      status: z.string().openapi({ example: "uploaded" }),
      mappingProvenance: z.enum(["llm", "override", "heuristic"]),
    })
    .openapi("UploadResponse"),
);

/** Optional column-mapping override: { headerName: enumField }. */
export const ColumnMappingSchema = registry.register(
  "ColumnMapping",
  z.record(z.string(), ColumnFieldSchema).openapi("ColumnMapping", {
    description: "Map of CSV header name to typed field. Supplying it skips the LLM typing step.",
    example: { Email: "email", "First Name": "first_name", Notes: "other" },
  }),
);

// ─── Silver contact ──────────────────────────────────────────────────────────

export const ContactSchema = registry.register(
  "Contact",
  z
    .object({
      id: z.string().uuid(),
      orgId: z.string().uuid(),
      brandId: z.string().uuid(),
      primaryEmail: z.string().nullable(),
      phoneE164: z.string().nullable(),
      fullName: z.string().nullable(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      rawAttributes: z.record(z.string(), z.string()),
      consentStatus: z.string(),
      unsubscribed: z.boolean(),
      source: z.enum(["csv", "matrix"]).openapi({
        description:
          "Which source this contact came from. Only 'csv' contacts are sendable — a 'matrix' " +
          "contact wrote in first and is already in conversation, so it never reaches serve-next.",
      }),
      channel: z
        .enum(MATRIX_CHANNELS)
        .nullable()
        .openapi({ description: "Matrix contacts only. Null for CSV contacts." }),
      channelHandle: z
        .string()
        .nullable()
        .openapi({ description: "Matrix contacts only: the counterpart's bridged Matrix user id." }),
      sourceUploadId: z.string().uuid().nullable(),
      sourceRowId: z.string().uuid().nullable(),
      lastRebuiltAt: z.string(),
    })
    .openapi("Contact"),
);

export const ContactsListResponseSchema = registry.register(
  "ContactsListResponse",
  z.object({ contacts: z.array(ContactSchema) }).openapi("ContactsListResponse"),
);

export const UploadSummarySchema = registry.register(
  "UploadSummary",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      filename: z.string(),
      rowCount: z.number().int(),
      status: z.string(),
      mappingProvenance: z.string().nullable(),
      columnMapping: z.record(z.string(), z.string()).nullable(),
      uploadedAt: z.string(),
    })
    .openapi("UploadSummary"),
);

export const UploadsListResponseSchema = registry.register(
  "UploadsListResponse",
  z.object({ uploads: z.array(UploadSummarySchema) }).openapi("UploadsListResponse"),
);

// ─── Serve ─────────────────────────────────────────────────────────────────

export const ServeNextRequestSchema = registry.register(
  "ServeNextRequest",
  z
    .object({
      brandId: z.string().uuid(),
      limit: z
        .number()
        .int()
        .positive()
        .max(5000)
        .optional()
        .openapi({ description: "Max contacts to serve this call. Defaults to 100.", example: 100 }),
      uploadIds: z
        .array(z.string().uuid())
        .min(1)
        .max(200)
        .optional()
        .openapi({
          description:
            "Restrict the serve to these imported CRM files (ids from GET /orgs/contacts/uploads). " +
            "Omit for the whole brand. Suppression stays brand-wide: a contact already served " +
            "through another file is never returned again, whichever file is used.",
        }),
    })
    .openapi("ServeNextRequest"),
);

export const ServeNextResponseSchema = registry.register(
  "ServeNextResponse",
  z
    .object({
      contacts: z.array(ContactSchema),
      served: z.number().int().openapi({ description: "How many contacts this call served." }),
      exhausted: z.boolean().openapi({
        description:
          "True when no un-served sendable contacts remain after this serve — for the brand, or " +
          "for the restricted files when `uploadIds` was supplied.",
      }),
    })
    .openapi("ServeNextResponse"),
);

export const ServeStatsResponseSchema = registry.register(
  "ServeStatsResponse",
  z
    .object({
      served: z.number().int().openapi({
        description:
          "Contacts already served. Whole-brand scope: every suppression row for the brand. " +
          "File scope (`uploadIds`): sendable contacts of those files that are already served.",
      }),
      remainingSendable: z
        .number()
        .int()
        .openapi({ description: "Sendable contacts not yet served, in the requested scope." }),
      totalSendable: z
        .number()
        .int()
        .openapi({ description: "All sendable contacts in the requested scope." }),
    })
    .openapi("ServeStatsResponse"),
);

export const PromoteResponseSchema = registry.register(
  "PromoteResponse",
  z
    .object({
      status: z.literal("accepted"),
      platformRunId: z.string().uuid(),
      uploadId: z.string().uuid().optional(),
    })
    .openapi("PromoteResponse"),
);

export const PromoteRequestSchema = registry.register(
  "PromoteRequest",
  z
    .object({
      uploadId: z
        .string()
        .uuid()
        .optional()
        .openapi({ description: "Reprocess a single upload. Omit to reprocess all uploads." }),
    })
    .openapi("PromoteRequest"),
);

// ─── Paths ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/orgs/contacts/upload",
  summary: "Upload a CSV of contacts (bronze ingest + async silver promotion)",
  description:
    "Multipart upload. Field `file` = the CSV; field `brandId` (required); optional field " +
    "`columnMapping` = JSON override. Requires x-api-key, x-org-id, x-user-id. Idempotent on " +
    "re-upload of the same file bytes (content hash).",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.string().openapi({ type: "string", format: "binary" }),
            brandId: z.string().uuid(),
            columnMapping: z.string().optional().openapi({
              description: "JSON string of a ColumnMapping override.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Upload ingested",
      content: { "application/json": { schema: UploadResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/contacts",
  summary: "List silver contacts for a brand",
  request: {
    query: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Contacts",
      content: { "application/json": { schema: ContactsListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/contacts/serve-next",
  summary: "Serve the next batch of not-yet-served sendable contacts for a brand",
  description:
    "Returns up to `limit` sendable contacts for the brand that have not yet been served, and " +
    "ATOMICALLY marks them served so no concurrent or subsequent call ever returns them again. " +
    "Suppression is permanent and per (brand, contact). When the brand is drained, returns an " +
    "empty list with `exhausted: true`. Optionally restrict the pool to a subset of the brand's " +
    "imported CRM files with `uploadIds` (per-file ON/OFF): the restriction narrows the candidate " +
    "pool only — suppression stays brand-wide, so a person present in two files is served at most " +
    "once for the brand, whichever file is used. Requires x-api-key, x-org-id.",
  request: {
    body: {
      content: { "application/json": { schema: ServeNextRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Served contacts",
      content: { "application/json": { schema: ServeNextResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/contacts/serve-stats",
  summary: "Served vs remaining sendable counts for a brand, or for given imported files",
  description:
    "Whole-brand by default. Pass `uploadIds` (comma-separated, or repeated) to read progress for " +
    "one or several imported CRM files instead — for a file scope, " +
    "`served + remainingSendable == totalSendable`.",
  request: {
    query: z.object({
      brandId: z.string().uuid(),
      uploadIds: z
        .string()
        .optional()
        .openapi({
          description:
            "Comma-separated upload ids (from GET /orgs/contacts/uploads). Scopes the counts to " +
            "those files. May also be repeated. Omit for whole-brand counts.",
        }),
    }),
  },
  responses: {
    200: {
      description: "Serve stats",
      content: { "application/json": { schema: ServeStatsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/contacts/uploads",
  summary: "List uploads and their status for a brand",
  request: {
    query: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Uploads",
      content: { "application/json": { schema: UploadsListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/contacts/promote",
  summary: "Re-run silver promotion over bronze (background, idempotent)",
  request: {
    body: {
      content: { "application/json": { schema: PromoteRequestSchema } },
    },
  },
  responses: {
    202: {
      description: "Promotion started",
      content: { "application/json": { schema: PromoteResponseSchema } },
    },
  },
});

// ─── Matrix (direct-message ingestion) ───────────────────────────────────────

export const MatrixChannelSchema = z.enum(MATRIX_CHANNELS);

export const MatrixConnectionSchema = registry.register(
  "MatrixConnection",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      channel: MatrixChannelSchema,
      matrixUserId: z.string().openapi({
        description: "The MXID of the user's OWN bridged account (sender == this → outbound).",
      }),
      counterpartPrefix: z.string().openapi({
        description:
          "Bridge ghost-user MXID prefix identifying this channel's rooms (e.g. '@whatsapp_').",
        example: "@whatsapp_",
      }),
      status: z.enum(["active", "paused", "error"]),
      synced: z
        .boolean()
        .openapi({ description: "True once the connection holds a /sync cursor." }),
      lastSyncedAt: z.string().nullable(),
      lastError: z.string().nullable(),
      lastRunId: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi("MatrixConnection"),
);

export const MatrixConnectionResponseSchema = registry.register(
  "MatrixConnectionResponse",
  z.object({ connection: MatrixConnectionSchema }).openapi("MatrixConnectionResponse"),
);

export const MatrixConnectionsListResponseSchema = registry.register(
  "MatrixConnectionsListResponse",
  z
    .object({ connections: z.array(MatrixConnectionSchema) })
    .openapi("MatrixConnectionsListResponse"),
);

export const MatrixConnectionRequestSchema = registry.register(
  "MatrixConnectionRequest",
  z
    .object({
      brandId: z.string().uuid(),
      channel: MatrixChannelSchema,
      matrixUserId: z.string(),
      counterpartPrefix: z.string(),
    })
    .openapi("MatrixConnectionRequest"),
);

export const MatrixLeadSchema = registry.register(
  "MatrixLead",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      status: z.enum(LEAD_STATUSES),
      nextStep: z.string(),
      estimatedValueUsd: z.number().int(),
      summary: z.string(),
      model: z.string().openapi({ description: "Versioned model that produced this reading." }),
      computedAt: z.string(),
      computedThroughEventId: z.string().openapi({
        description:
          "The conversation watermark this reading was computed through. The lead is recomputed " +
          "only when the conversation's last event id moves past it.",
      }),
      contactId: z.string().uuid(),
      contactName: z.string().nullable(),
      channel: MatrixChannelSchema,
      channelHandle: z.string().nullable(),
      phoneE164: z.string().nullable(),
      conversationId: z.string().uuid(),
      firstMessageAt: z.string(),
      lastMessageAt: z.string(),
      messageCount: z.number().int(),
      inboundCount: z.number().int(),
      outboundCount: z.number().int(),
    })
    .openapi("MatrixLead"),
);

export const MatrixLeadsListResponseSchema = registry.register(
  "MatrixLeadsListResponse",
  z.object({ leads: z.array(MatrixLeadSchema) }).openapi("MatrixLeadsListResponse"),
);

export const MatrixSyncRequestSchema = registry.register(
  "MatrixSyncRequest",
  z
    .object({
      connectionId: z
        .string()
        .uuid()
        .optional()
        .openapi({ description: "Sync a single connection. Omit for every active connection." }),
    })
    .openapi("MatrixSyncRequest"),
);

export const MatrixSyncResponseSchema = registry.register(
  "MatrixSyncAcceptedResponse",
  z
    .object({ status: z.literal("accepted"), platformRunId: z.string().uuid() })
    .openapi("MatrixSyncAcceptedResponse"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/matrix/connections",
  summary: "Register (or update) a Matrix DM connection for a brand + channel",
  description:
    "One connection per (org, brand, channel). Requires x-api-key, x-org-id, x-user-id — the " +
    "creating user is persisted, because the sync cron has no inbound identity and the org run " +
    "it opens must still be attributed.",
  request: {
    body: { content: { "application/json": { schema: MatrixConnectionRequestSchema } } },
  },
  responses: {
    200: {
      description: "Connection",
      content: { "application/json": { schema: MatrixConnectionResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/orgs/matrix/connections/{id}",
  summary: "Pause or resume a Matrix connection",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ status: z.enum(["active", "paused"]) }) },
      },
    },
  },
  responses: {
    200: {
      description: "Connection",
      content: { "application/json": { schema: MatrixConnectionResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/matrix/connections",
  summary: "Connection health for a brand",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Connections",
      content: { "application/json": { schema: MatrixConnectionsListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/matrix/leads",
  summary: "List inbound DM leads for a brand",
  description:
    "The gold layer: one row per conversation, carrying the LLM's reading of the thread (status, " +
    "next step, estimated value, summary) plus the deterministic conversation counters.",
  request: {
    query: z.object({
      brandId: z.string().uuid(),
      status: z.enum(LEAD_STATUSES).optional(),
      limit: z.coerce.number().int().optional(),
      offset: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "Leads",
      content: { "application/json": { schema: MatrixLeadsListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/matrix/sync",
  summary: "Run a Matrix sync pass (bronze → silver → gold)",
  description:
    "Driven by a 5-minute cron. Opens one ORG run per connection (the spend belongs to the org " +
    "that owns it) and returns immediately; the pass runs in the background.",
  request: { body: { content: { "application/json": { schema: MatrixSyncRequestSchema } } } },
  responses: {
    202: {
      description: "Sync started",
      content: { "application/json": { schema: MatrixSyncResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/matrix/rebuild",
  summary: "Rebuild silver + gold from bronze (no /sync call)",
  description:
    "Reproduces conversations and leads from the mirrored events alone — the path that makes gold " +
    "fully rebuildable after a truncate or a prompt change.",
  request: { body: { content: { "application/json": { schema: MatrixSyncRequestSchema } } } },
  responses: {
    202: {
      description: "Rebuild started",
      content: { "application/json": { schema: MatrixSyncResponseSchema } },
    },
  },
});
