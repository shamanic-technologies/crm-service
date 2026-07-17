import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { COLUMN_FIELDS } from "./lib/column-typing.js";

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
      mappingProvenance: z.enum(["llm", "override"]),
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
      sourceUploadId: z.string().uuid(),
      sourceRowId: z.string().uuid(),
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
          "True when no un-served sendable contacts remain for the brand after this serve.",
      }),
    })
    .openapi("ServeNextResponse"),
);

export const ServeStatsResponseSchema = registry.register(
  "ServeStatsResponse",
  z
    .object({
      served: z.number().int().openapi({ description: "Distinct contacts already served." }),
      remainingSendable: z
        .number()
        .int()
        .openapi({ description: "Sendable contacts not yet served." }),
      totalSendable: z.number().int().openapi({ description: "All sendable contacts (served + remaining)." }),
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
    "empty list with `exhausted: true`. Requires x-api-key, x-org-id.",
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
  summary: "Served vs remaining sendable counts for a brand",
  request: {
    query: z.object({ brandId: z.string().uuid() }),
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
