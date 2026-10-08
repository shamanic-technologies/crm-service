import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { COLUMN_FIELDS } from "./lib/column-typing.js";
import { MATRIX_CHANNELS } from "./lib/matrix/events.js";
import { LEAD_STATUSES } from "./lib/matrix/leads.js";
import { PEOPLE_SOURCES } from "./lib/people/identity.js";
import { STATE_SOURCES } from "./lib/people/state.js";
import { SOURCE_STATUSES } from "./lib/people/sources.js";
import { TEXT_CLEAN_STATUSES, TIMELINE_SOURCE_STATUSES } from "./lib/people/timeline.js";

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
      source: z.enum(["csv", "matrix", "gohighlevel"]).openapi({
        description:
          "Which source this contact came from. Only 'csv' contacts are sendable. A 'matrix' " +
          "contact wrote in first and is already in conversation; a 'gohighlevel' contact is the " +
          "client's own person, mirrored from their CRM. Neither ever reaches serve-next.",
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

// ─── Brand transfer (fleet contract) ─────────────────────────────────────────

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(z.object({ tableName: z.string(), count: z.number().int() })),
  })
  .openapi("TransferBrandResponse");

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Move every CRM row of a brand from one org to another",
  description:
    "Moves the brand's whole CRM (CSV uploads and contacts, serves, GoHighLevel connection, mirror, pipelines, opportunities, appointments, form submissions, stage history and meanings, Matrix connection, events, conversations and leads) from sourceOrgId to targetOrgId, rewriting the brand id to targetBrandId when given. One transaction: all or nothing. Idempotent: a second call moves nothing. 409 when the target already holds conflicting CRM data (nothing moved).",
  request: {
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Rows moved per table",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: { description: "Validation error" },
    409: { description: "Target already holds conflicting CRM data; nothing was moved" },
    502: { description: "Run tracking unavailable" },
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

// ─── Matrix self-serve linking (/orgs/matrix/links) ─────────────────────────

const LinkMethodSchema = z.enum(["qr", "phone"]);

export const MatrixLinkStartRequestSchema = registry.register(
  "MatrixLinkStartRequest",
  z
    .object({
      brandId: z.string().uuid(),
      channel: MatrixChannelSchema,
      method: LinkMethodSchema.openapi({
        description:
          "'qr' = scan a QR code in WhatsApp › Linked devices. 'phone' = get an 8-character pairing " +
          "code to type under Linked devices › Link with phone number instead.",
      }),
      phoneNumber: z.string().optional().openapi({
        description: "Required for 'phone'. International format.",
        example: "+33612345678",
      }),
    })
    .openapi("MatrixLinkStartRequest"),
);

export const MatrixLinkSchema = registry.register(
  "MatrixLink",
  z
    .object({
      channel: MatrixChannelSchema,
      available: z.boolean().openapi({
        description: "False while the channel's bridge is not running (Telegram today).",
      }),
      unavailableReason: z.string().nullable(),
      methods: z.array(LinkMethodSchema),
      status: z.enum(["not_linked", "waiting", "linked", "failed"]),
      method: LinkMethodSchema.nullable(),
      qr: z
        .object({
          data: z.string().openapi({ description: "The QR payload, to render as a QR code." }),
          imageDataUrl: z.string().openapi({ description: "The same QR as a PNG data URL." }),
        })
        .nullable()
        .openapi({ description: "Present while waiting on a QR scan. Refreshes every 20-60s: poll." }),
      pairingCode: z
        .string()
        .nullable()
        .openapi({ description: "Present while waiting on a pairing code entry.", example: "ABCD-EFGH" }),
      instructions: z.string().nullable(),
      codeIssuedAt: z.string().nullable(),
      account: z
        .object({ id: z.string(), name: z.string().nullable() })
        .nullable()
        .openapi({ description: "The linked account (WhatsApp: its phone number)." }),
      bridgeState: z
        .object({ state: z.string().nullable(), reason: z.string().nullable() })
        .nullable()
        .openapi({ description: "Linked only: the bridge's live state, e.g. CONNECTED or BAD_CREDENTIALS." }),
      bridgeStateError: z.string().nullable(),
      connection: z
        .object({
          id: z.string().uuid(),
          status: z.string(),
          synced: z.boolean(),
          lastSyncedAt: z.string().nullable(),
          lastError: z.string().nullable(),
        })
        .nullable(),
      error: z
        .object({ code: z.string(), message: z.string() })
        .nullable()
        .openapi({ description: "Failed only: the bridge's (or WhatsApp's) own code + message." }),
      startedAt: z.string().nullable(),
      linkedAt: z.string().nullable(),
    })
    .openapi("MatrixLink"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/matrix/links",
  summary: "Start linking a brand's WhatsApp (or Telegram) account, self-serve",
  description:
    "Creates the brand's dedicated bridge account and starts a login. Answers with the first QR code " +
    "or pairing code; poll GET /orgs/matrix/links for refreshed codes and completion. Once linked, the " +
    "brand's Matrix connection exists and syncs with no further step. Read-only: nothing is ever sent " +
    "on the linked account. Needs x-user-id.",
  request: { body: { content: { "application/json": { schema: MatrixLinkStartRequestSchema } } } },
  responses: {
    200: {
      description: "Link started (or already linked)",
      content: { "application/json": { schema: z.object({ link: MatrixLinkSchema }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: {
      description: "Channel not available yet",
      content: {
        "application/json": {
          schema: z.object({ type: z.literal("channel_unavailable"), channel: MatrixChannelSchema, error: z.string() }),
        },
      },
    },
    422: { description: "The bridge (or WhatsApp) refused, in its own words; `link` shows the failed state" },
    502: { description: "The bridge is unreachable or broke" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/matrix/links",
  summary: "Every channel's link status for a brand, with the current code",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "One entry per channel",
      content: { "application/json": { schema: z.object({ links: z.array(MatrixLinkSchema) }) } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/orgs/matrix/links/{channel}",
  summary: "Unlink a channel: logout, stop syncing, drop what was mirrored",
  request: { params: z.object({ channel: MatrixChannelSchema }), query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Unlinked",
      content: {
        "application/json": {
          schema: z.object({
            unlinked: z.literal(true),
            contactsRemoved: z.number().int(),
            connectionRemoved: z.boolean(),
            link: MatrixLinkSchema,
          }),
        },
      },
    },
    404: { description: "No link", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "The bridge could not log the account out" },
  },
});

// ─── GoHighLevel (third CRM source) ──────────────────────────────────────────

export const GhlConnectionSchema = registry.register(
  "GhlConnection",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      locationId: z.string().openapi({
        description:
          "The GoHighLevel sub-account ('location') id this connection mirrors. Supplied by the " +
          "customer: a Private Integration Token is opaque and GoHighLevel publishes no way to " +
          "read the target sub-account out of it.",
      }),
      status: z.enum(["active", "paused", "error"]),
      synced: z.boolean().openapi({ description: "True once a sync has completed." }),
      lastSyncedAt: z.string().nullable(),
      lastError: z
        .string()
        .nullable()
        .openapi({ description: "Why the last sync failed, verbatim. Null when healthy." }),
      lastRunId: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi("GhlConnection"),
);

export const GhlConnectionRequestSchema = registry.register(
  "GhlConnectionRequest",
  z.object({ brandId: z.string().uuid(), locationId: z.string() }).openapi("GhlConnectionRequest"),
);

export const GhlConnectionResponseSchema = registry.register(
  "GhlConnectionResponse",
  z.object({ connection: GhlConnectionSchema }).openapi("GhlConnectionResponse"),
);

export const GhlConnectionsListResponseSchema = registry.register(
  "GhlConnectionsListResponse",
  z.object({ connections: z.array(GhlConnectionSchema) }).openapi("GhlConnectionsListResponse"),
);

export const GhlVendorErrorSchema = registry.register(
  "GhlVendorError",
  z
    .object({
      type: z.literal("vendor"),
      error: z.string(),
      vendorStatus: z.number().int().openapi({ description: "GoHighLevel's own HTTP status." }),
      vendorError: z.string().openapi({ description: "GoHighLevel's own message, verbatim." }),
    })
    .openapi("GhlVendorError"),
);

export const GhlContactSchema = registry.register(
  "GhlContact",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      externalId: z.string().nullable().openapi({ description: "GoHighLevel's own contact id." }),
      primaryEmail: z.string().nullable(),
      phoneE164: z.string().nullable(),
      fullName: z.string().nullable(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      unsubscribed: z
        .boolean()
        .openapi({ description: "GoHighLevel's do-not-disturb flag on this contact." }),
      lastRebuiltAt: z.string(),
      company: z
        .object({
          name: z.string().nullable(),
          website: z.string().nullable(),
        })
        .openapi({
          description:
            "The company GoHighLevel attaches to this person. Null fields mean the " +
            "vendor holds nothing there — never a default. On the first customer " +
            "455 of 2,694 contacts carry a company name and 454 of those carry no " +
            "email, so this is the only non-name signal most of them have.",
        }),
      location: z
        .object({
          city: z.string().nullable(),
          stateRegion: z
            .string()
            .nullable()
            .openapi({ description: "State, province or county, in the vendor's own words." }),
          country: z
            .string()
            .nullable()
            .openapi({ description: "Verbatim. ISO-3166 alpha-2 in practice; not validated." }),
          postalCode: z.string().nullable(),
          streetAddress: z.string().nullable(),
        })
        .openapi({ description: "Where GoHighLevel places this person. Verbatim, unnormalized." }),
      record: z
        .object({
          type: z
            .string()
            .nullable()
            .openapi({
              description:
                "GoHighLevel's own classification of the record ('lead', 'customer', …). " +
                "Free text per customer, served verbatim and mapped to nothing.",
            }),
          leadSource: z
            .string()
            .nullable()
            .openapi({
              description:
                "Where the customer says this record came from. Arbitrary free text " +
                "per account; never mapped onto a vocabulary of ours.",
            }),
          tags: z
            .array(z.string())
            .nullable()
            .openapi({
              description:
                "The customer's own labels. Null when GoHighLevel reports no tags " +
                "field at all; [] when it reports an empty one — those differ.",
            }),
          createdAt: z
            .string()
            .nullable()
            .openapi({ description: "When GoHighLevel created its record, not when we mirrored it." }),
          updatedAt: z.string().nullable(),
          origin: z
            .object({
              medium: z.string().nullable(),
              url: z.string().nullable(),
              referrer: z.string().nullable(),
            })
            .openapi({
              description:
                "First-touch attribution, when GoHighLevel recorded one. Only where " +
                "the person came FROM is served; the IPs and user agents the vendor " +
                "attaches to the same entry stay in the raw mirror.",
            }),
        })
        .openapi({ description: "Where this record came from, in the customer's own vocabulary." }),
    })
    .openapi("GhlContact"),
);

export const GhlContactsListResponseSchema = registry.register(
  "GhlContactsListResponse",
  z.object({ contacts: z.array(GhlContactSchema) }).openapi("GhlContactsListResponse"),
);

const GhlOriginBucketSchema = z.object({
  value: z
    .string()
    .nullable()
    .describe("The customer's own value, verbatim and unmapped. null = the contacts carrying none."),
  count: z.number().int(),
});

export const GhlContactOriginsResponseSchema = registry.register(
  "GhlContactOriginsResponse",
  z
    .object({
      brandId: z.string().uuid(),
      totalContacts: z.number().int().describe("The brand's mirrored GoHighLevel contacts, at read time."),
      leadSource: z
        .array(GhlOriginBucketSchema)
        .describe("By GoHighLevel's `source` field. Buckets (including the null one) sum to totalContacts."),
      originMedium: z
        .array(GhlOriginBucketSchema)
        .describe("By first-touch attribution medium. Buckets sum to totalContacts."),
      contactType: z
        .array(GhlOriginBucketSchema)
        .describe("By GoHighLevel's contact `type`. Buckets sum to totalContacts."),
      tags: z
        .object({
          tagged: z.number().int(),
          untagged: z.number().int(),
          labels: z
            .array(z.object({ value: z.string(), count: z.number().int() }))
            .describe("Contacts per label. OVERLAPPING — a contact counts under each of its tags."),
        })
        .describe("tagged + untagged = totalContacts; label counts do not sum to anything."),
    })
    .openapi("GhlContactOriginsResponse"),
);

export const GhlOpportunitySchema = registry.register(
  "GhlOpportunity",
  z
    .object({
      id: z.string().uuid(),
      externalId: z.string(),
      name: z.string(),
      status: z
        .string()
        .nullable()
        .openapi({ description: "GoHighLevel's own status: open | won | lost | abandoned." }),
      monetaryValue: z
        .string()
        .nullable()
        .openapi({ description: "Amount as GoHighLevel reports it, unrounded." }),
      assignedTo: z.string().nullable(),
      pipelineId: z.string().nullable(),
      pipelineName: z.string().nullable(),
      stageId: z.string().nullable(),
      stageName: z.string().nullable(),
      contactId: z
        .string()
        .uuid()
        .nullable()
        .openapi({ description: "The mirrored contact, when GoHighLevel named one we hold." }),
      externalContactId: z.string().nullable(),
      contactName: z.string().nullable(),
      contactEmail: z.string().nullable(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
    .openapi("GhlOpportunity"),
);

export const GhlPipelineStageSchema = registry.register(
  "GhlPipelineStage",
  z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      position: z.number().int().nullable(),
      count: z.number().int(),
      totalValue: z.string(),
      opportunities: z.array(GhlOpportunitySchema),
    })
    .openapi("GhlPipelineStage"),
);

export const GhlPipelineSchema = registry.register(
  "GhlPipeline",
  z
    .object({
      id: z.string(),
      name: z.string(),
      count: z.number().int(),
      totalValue: z.string(),
      stages: z.array(GhlPipelineStageSchema),
    })
    .openapi("GhlPipeline"),
);

export const GhlOpportunitiesResponseSchema = registry.register(
  "GhlOpportunitiesResponse",
  z
    .object({
      pipelines: z.array(GhlPipelineSchema),
      ungrouped: z.array(GhlOpportunitySchema).openapi({
        description:
          "Opportunities GoHighLevel placed in no pipeline, or in one we have not mirrored. " +
          "Returned rather than dropped so the counts add up to what the customer sees.",
      }),
      totalOpportunities: z.number().int(),
    })
    .openapi("GhlOpportunitiesResponse"),
);

export const GhlSyncRequestSchema = registry.register(
  "GhlSyncRequest",
  z
    .object({
      connectionId: z
        .string()
        .uuid()
        .optional()
        .openapi({ description: "Sync one connection. Omit for every active connection." }),
    })
    .openapi("GhlSyncRequest"),
);

const FUNNEL_STEP_VALUES = [
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "sale",
  "deal_lost",
  "form_submitted",
] as const;

export const GhlFunnelEventSchema = registry.register(
  "GhlFunnelEvent",
  z
    .object({
      step: z.enum(FUNNEL_STEP_VALUES).openapi({
        description:
          "The funnel step the CRM evidences. `meeting_not_held` = a scheduled meeting did not " +
          "take place (no-show or cancelled). `form_submitted` = the person submitted one of the " +
          "customer's forms (a funnel opt-in, a Meta Ads lead form relayed into GoHighLevel, a " +
          "booking form).",
      }),
      occurredAt: z.string().nullable().openapi({
        description:
          "When it happened, as GoHighLevel recorded it (ISO 8601). NULL when GoHighLevel gave " +
          "no date — never a guessed one.",
      }),
      dateBasis: z
        .enum([
          "booked_at",
          "scheduled_start",
          "stage_entered_at",
          "status_changed_at",
          "submitted_at",
          "contact_created_at",
        ])
        .openapi({
          description:
            "Which GoHighLevel date `occurredAt` is: when the appointment was created, its " +
            "scheduled start, when the opportunity entered the stage, when its status changed, " +
            "when the form submission was recorded, or when the contact was created (a contact " +
            "whose first touch is a form is created by that submission).",
        }),
      source: z
        .enum([
          "appointment",
          "stage_entry",
          "won_status",
          "lost_status",
          "form_submission",
          "form_origin",
        ])
        .openapi({
          description:
            "Where the evidence came from: a calendar appointment, an opportunity entering a " +
            "stage whose recorded meaning is this step, the opportunity's won / lost status, a " +
            "form submission GoHighLevel recorded, or GoHighLevel's first-touch attribution " +
            "saying the contact came in through a form (medium `form` or `survey`). The same " +
            "form fill can be evidenced by both of the last two; both are served.",
        }),
      sourceId: z.string().openapi({
        description:
          "GoHighLevel's appointment, opportunity or form-submission id; for `form_origin`, its " +
          "contact id.",
      }),
      detail: z.object({
        calendarName: z.string().nullable(),
        appointmentStatus: z.string().nullable().openapi({
          description: "GoHighLevel's appointment status, verbatim (appointments only).",
        }),
        scheduledStart: z.string().nullable(),
        pipelineName: z.string().nullable(),
        stageName: z.string().nullable().openapi({
          description: "The customer's own stage name, verbatim (stage entries only).",
        }),
        observedAt: z.string().nullable().openapi({
          description: "When crm-service observed the stage / status (opportunity evidence only).",
        }),
        meaningConfidence: z.number().nullable().openapi({
          description:
            "The judgment model's confidence (0..1) in what the stage means (stage entries only). " +
            "Stages below 0.5 are never served as evidence.",
        }),
        formId: z.string().nullable().openapi({
          description: "GoHighLevel's id of the form submitted (form submissions only).",
        }),
        formName: z.string().nullable().openapi({
          description: "The customer's own name for the form, verbatim (form submissions only).",
        }),
        attributionMedium: z.string().nullable().openapi({
          description:
            "GoHighLevel's first-touch attribution medium, verbatim (form origins only).",
        }),
      }),
    })
    .openapi("GhlFunnelEvent"),
);

export const GhlFunnelEventsResponseSchema = registry.register(
  "GhlFunnelEventsResponse",
  z
    .object({
      brandId: z.string().uuid(),
      contacts: z.array(
        z.object({
          contactId: z.string().uuid().openapi({
            description: "crm-service contact id — the `id` served by /orgs/gohighlevel/contacts.",
          }),
          externalContactId: z.string(),
          primaryEmail: z.string().nullable(),
          fullName: z.string().nullable(),
          events: z.array(GhlFunnelEventSchema).openapi({
            description: "Oldest first; events with an unknown date last.",
          }),
        }),
      ),
      totalContacts: z.number().int().openapi({
        description: "Contacts of the brand carrying at least one event (the paging population).",
      }),
      limit: z.number().int(),
      offset: z.number().int(),
      nextOffset: z.number().int().nullable(),
      undecidedStages: z.number().int().openapi({
        description:
          "Stage names observed but not yet given a meaning; their entries appear once decided " +
          "(the next sync decides them).",
      }),
      hesitantStages: z.number().int().openapi({
        description:
          "Stages whose recorded meaning fell below the 0.5 confidence floor. Their entries are " +
          "never served: the stage name does not say what it means.",
      }),
    })
    .openapi("GhlFunnelEventsResponse"),
);

const REACH_SOURCE_VALUES = [
  "appointment",
  "stage_entry",
  "won_status",
  "lost_status",
  "form_submission",
  "form_origin",
] as const;

const GhlFunnelReachCoverageSchema = z
  .object({
    connectionStatus: z.string().openapi({ description: "`active` | `paused` | `error`." }),
    lastSyncedAt: z.string().nullable(),
    totalContacts: z.number().int().openapi({
      description: "GoHighLevel contacts mirrored for the brand: the whole CRM population.",
    }),
    contactsWithEvidence: z.number().int().openapi({
      description: "Contacts carrying at least one funnel event.",
    }),
    appointmentsSince: z.string().nullable().openapi({
      description: "Earliest calendar booking GoHighLevel holds. Appointments reach back years.",
    }),
    stageHistorySince: z.string().nullable().openapi({
      description:
        "When crm-service first observed the brand's pipeline. GoHighLevel keeps no stage " +
        "history: before this date an opportunity is known only by the stage it sat in then.",
    }),
    undecidedStages: z.number().int(),
    hesitantStages: z.number().int().openapi({
      description: "Stages whose meaning was decided below 0.5 confidence: never counted.",
    }),
  })
  .openapi("GhlFunnelReachCoverage");

export const GhlFunnelReachResponseSchema = registry.register(
  "GhlFunnelReachResponse",
  z
    .object({
      brandId: z.string().uuid(),
      available: z.boolean().openapi({
        description:
          "False when the question cannot be answered yet; `reason` says why. Never zeros in " +
          "disguise: `steps` is absent.",
      }),
      reason: z.enum(["no_connection", "not_synced", "stage_meanings_pending"]).optional().openapi({
        description:
          "Only when `available` is false. `no_connection`: the brand has no GoHighLevel " +
          "connection. `not_synced`: connected, no sync completed yet. " +
          "`stage_meanings_pending`: stage names observed but not decided yet (the next sync " +
          "decides them).",
      }),
      steps: z
        .array(
          z.object({
            step: z.enum(FUNNEL_STEP_VALUES),
            contacts: z.number().int().openapi({
              description: "Distinct CRM contacts with DIRECT evidence of the step.",
            }),
            contactsAtOrBeyond: z.number().int().openapi({
              description:
                "Distinct contacts with evidence of the step OR of a later step that implies it: " +
                "`meeting_booked` ⇐ attended, not held, sale; `meeting_attended` ⇐ sale; every " +
                "other step implies nothing. Monotone along booked → attended → sale, so a ratio " +
                "of adjacent values never exceeds 1.",
            }),
            bySource: z.record(z.enum(REACH_SOURCE_VALUES), z.number().int()).openapi({
              description:
                "Distinct contacts per evidence source (a contact can appear under several).",
            }),
          }),
        )
        .optional()
        .openapi({ description: "Every step, zeros included. Only when `available` is true." }),
      coverage: GhlFunnelReachCoverageSchema.nullable().openapi({
        description: "Null only for `no_connection`.",
      }),
    })
    .openapi("GhlFunnelReachResponse"),
);

export const GhlStageMeaningsResponseSchema = registry.register(
  "GhlStageMeaningsResponse",
  z
    .object({
      stageMeanings: z.array(
        z.object({
          pipelineId: z.string().nullable(),
          pipelineName: z.string().nullable(),
          stageId: z.string(),
          stageName: z.string(),
          meaning: z.enum([...FUNNEL_STEP_VALUES, "none"]),
          confidence: z.number().openapi({ description: "The judgment model's confidence, 0..1." }),
          probabilities: z.record(z.string(), z.number()).openapi({
            description: "The model's distribution over every meaning.",
          }),
          servedAsEvidence: z.boolean().openapi({
            description: "False below the 0.5 confidence floor: recorded, never served as evidence.",
          }),
          model: z.string().openapi({ description: "The model that decided it." }),
          runId: z.string(),
          decidedAt: z.string(),
        }),
      ),
    })
    .openapi("GhlStageMeaningsResponse"),
);

export const GhlSyncAcceptedResponseSchema = registry.register(
  "GhlSyncAcceptedResponse",
  z
    .object({ status: z.literal("accepted"), platformRunId: z.string().uuid() })
    .openapi("GhlSyncAcceptedResponse"),
);

export const GhlDisconnectResponseSchema = registry.register(
  "GhlDisconnectResponse",
  z
    .object({ disconnected: z.literal(true), connectionId: z.string().uuid() })
    .openapi("GhlDisconnectResponse"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/gohighlevel/connections",
  summary: "Connect a brand to GoHighLevel",
  description:
    "Resolves the brand's Private Integration Token from key-service, then PROVES it against " +
    "GoHighLevel before the connection is written. A credential that cannot authenticate, or one " +
    "bound to a different sub-account than the locationId supplied, is refused with " +
    "GoHighLevel's own status and message. Requires x-api-key, x-org-id, x-user-id.",
  request: { body: { content: { "application/json": { schema: GhlConnectionRequestSchema } } } },
  responses: {
    200: {
      description: "Connection",
      content: { "application/json": { schema: GhlConnectionResponseSchema } },
    },
    400: {
      description: "Refused — no credential stored, or GoHighLevel rejected it",
      content: { "application/json": { schema: GhlVendorErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/orgs/gohighlevel/connections/{id}",
  summary: "Pause or resume a GoHighLevel connection",
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
      content: { "application/json": { schema: GhlConnectionResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/orgs/gohighlevel/connections/{id}",
  summary: "Disconnect GoHighLevel from a brand",
  description:
    "Removes the connection and everything derived from it. With no connection row there is " +
    "nothing for a sync pass to iterate, so the syncing stops.",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Disconnected",
      content: { "application/json": { schema: GhlDisconnectResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/connections",
  summary: "GoHighLevel connection health for a brand",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Connections",
      content: { "application/json": { schema: GhlConnectionsListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/contacts",
  summary: "List a brand's GoHighLevel contacts",
  request: {
    query: z.object({
      brandId: z.string().uuid(),
      limit: z.coerce.number().int().optional(),
      offset: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "Contacts",
      content: { "application/json": { schema: GhlContactsListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/contacts/origins",
  summary: "Where a brand's GoHighLevel contacts came from, counted over the whole population",
  description:
    "Breaks the brand's mirrored contacts down by lead source, first-touch origin medium, contact " +
    "type and tag, each value in the customer's own words (no mapping, no case folding). Contacts " +
    "carrying no value are their own `null` bucket, always present, so each single-valued " +
    "breakdown sums to totalContacts.",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Origins breakdown",
      content: { "application/json": { schema: GhlContactOriginsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/opportunities",
  summary: "A brand's GoHighLevel sales pipeline, grouped by pipeline then stage",
  description:
    "Grouped the way GoHighLevel groups it: its pipelines, its stage order, its statuses and its " +
    "values, none of them re-bucketed.",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Pipelines",
      content: { "application/json": { schema: GhlOpportunitiesResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/funnel-events",
  summary: "The dated funnel events a brand's GoHighLevel CRM evidences, per contact",
  description:
    "Booked / attended / not-held meetings from calendar appointments, stage entries whose " +
    "recorded meaning is a funnel step, won / lost statuses, and form submissions (a funnel " +
    "opt-in, a Meta Ads lead form relayed into GoHighLevel) — each dated by GoHighLevel's own " +
    "timestamp (null when it gave none) and naming its source. Paged over contacts in a total " +
    "order; pass `contactId` for one contact. Stage history accumulates from the first sync " +
    "onwards: the past before it is not reconstructed.",
  request: {
    query: z.object({
      brandId: z.string().uuid(),
      contactId: z.string().uuid().optional(),
      limit: z.coerce.number().int().optional().openapi({ description: "Contacts per page, max 1000." }),
      offset: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "Funnel events",
      content: { "application/json": { schema: GhlFunnelEventsResponseSchema } },
    },
  },
});

const FUNNEL_REACH_DESCRIPTION =
  "Over the brand's WHOLE GoHighLevel history, how many distinct CRM contacts ever reached " +
  "each funnel step, so a consumer can divide adjacent steps into a conversion rate. Counting " +
  "rules: per CONTACT (never per opportunity or appointment); the evidence is exactly what " +
  "/orgs/gohighlevel/funnel-events serves (calendar appointments, stage entries whose recorded " +
  "meaning is a step, won / lost statuses, form submissions and form-origin contacts), dated or " +
  "not; EVERY pipeline counts, because a stage's recorded meaning (not its pipeline) makes it a " +
  "step; stages decided below 0.5 confidence are left out. Use `contactsAtOrBeyond` for a rate: " +
  "GoHighLevel keeps no stage history, so a contact first seen in a sale stage carries no " +
  "record of the meeting it went through. `available: false` with a `reason` is a distinct " +
  "answer from zeros.";

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/funnel-reach",
  summary: "How many CRM contacts ever reached each funnel step, over the whole CRM",
  description: FUNNEL_REACH_DESCRIPTION,
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Reach counts, or why they are not available",
      content: { "application/json": { schema: GhlFunnelReachResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/gohighlevel/funnel-reach",
  summary: "Funnel reach counts for a server-to-server caller (no org identity)",
  description:
    FUNNEL_REACH_DESCRIPTION +
    " Org-less: the org is resolved from the brand's GoHighLevel connection. Pass `orgId` only " +
    "if two orgs connect the same brand (409 otherwise).",
  request: {
    query: z.object({ brandId: z.string().uuid(), orgId: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "Reach counts, or why they are not available",
      content: { "application/json": { schema: GhlFunnelReachResponseSchema } },
    },
    409: { description: "Several orgs connect this brand; pass orgId" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/stage-meanings",
  summary: "What each of a brand's GoHighLevel pipeline stages was decided to mean",
  description:
    "Decided once per stage name by a judgment model (TypeSafe Jev, through chat-service " +
    "/orgs/judgments) and recorded with its confidence, distribution and model; re-decided only " +
    "when a new stage name appears.",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Stage meanings",
      content: { "application/json": { schema: GhlStageMeaningsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/gohighlevel/sync",
  summary: "Run a GoHighLevel sync pass (bronze → silver)",
  description:
    "Driven by a cron on the box. Opens one ORG run per connection and returns immediately; the " +
    "pass runs in the background. Re-running it over unchanged records writes nothing.",
  request: { body: { content: { "application/json": { schema: GhlSyncRequestSchema } } } },
  responses: {
    202: {
      description: "Sync started",
      content: { "application/json": { schema: GhlSyncAcceptedResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/gohighlevel/rebuild",
  summary: "Rebuild GoHighLevel silver from bronze (no vendor call)",
  description:
    "Reproduces contacts, pipelines and opportunities from the mirrored records alone — no call " +
    "to GoHighLevel and no credential needed.",
  request: { body: { content: { "application/json": { schema: GhlSyncRequestSchema } } } },
  responses: {
    202: {
      description: "Rebuild started",
      content: { "application/json": { schema: GhlSyncAcceptedResponseSchema } },
    },
  },
});

// ─── People: one person, every channel, one thread (gold) ────────────────────

const PeopleSourceSchema = z.enum(PEOPLE_SOURCES);

const PersonPresenceSchema = z
  .object({
    source: PeopleSourceSchema,
    sourceRef: z.string().openapi({ description: "The record's id in its source: an email (gmail, instantly) or a crm-service contact id (matrix, gohighlevel)." }),
    displayName: z.string().nullable(),
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    firstActivityAt: z.string().nullable(),
    lastActivityAt: z.string().nullable(),
    messageCount: z.number().int().nullable().openapi({ description: "Null when the source does not count messages in its list read (instantly, gohighlevel)." }),
    inboundCount: z.number().int().nullable(),
    outboundCount: z.number().int().nullable(),
    channel: z.string().openapi({ example: "whatsapp", description: "email | whatsapp | telegram | discord | crm" }),
  })
  .openapi("PersonPresence");

const PersonSchema = registry.register(
  "Person",
  z
    .object({
      personKey: z.string().openapi({
        example: "email:alice@acme.com",
        description:
          "The person's public id: their smallest email key, else smallest phone key, else a source-local key. Stable while they keep that address. Any of `identityKeys` opens the same person.",
      }),
      identityKeys: z.array(z.string()).openapi({ example: ["email:alice@acme.com", "phone:+33612345678"] }),
      displayName: z.string().nullable(),
      company: z.string().nullable(),
      emails: z.array(z.string()),
      phones: z.array(z.string()),
      sources: z.array(PeopleSourceSchema),
      firstActivityAt: z.string().nullable(),
      lastActivityAt: z.string().nullable(),
      state: z.string().openapi({
        example: "sales_interest",
        description:
          "The ONE state, set by `stateSource` (first that applies): lead_service = lead-service's standing verbatim (unresolved | not_contacted | contacted | engaged | sales_interest | customer | disqualified | opted_out, or `unavailable` when lead-service could not be asked); stripe = subscription_active | subscription_trialing | subscription_past_due | subscription_unpaid | paid | refunded | subscription_canceled; gohighlevel = deal_won | deal_open | deal_lost | deal_abandoned; matrix = new | qualifying | negotiating | won | lost | unresponsive; instantly = replied | clicked; none = in_conversation. Render it; never recompute it.",
      }),
      stateSource: z.enum(STATE_SOURCES),
      stateDetail: z.record(z.string(), z.unknown()).nullable(),
      presences: z.array(PersonPresenceSchema),
      mergeEvidence: z.array(z.unknown()).openapi({
        description: "The records that tied two keys of this person together (a Google / GoHighLevel / Stripe / CSV contact holding both, a lead-service accepted ruling). Empty when the person rests on a single key.",
      }),
      automated: z.boolean().openapi({
        description: "True when Jev (chat-service judgments) judged EVERY address of the person an automated sender (digest, notification, no-reply, newsletter) with confidence >= 0.5 and the person has no phone. Hidden from GET /orgs/people unless includeAutomated=true.",
      }),
      automatedVerdict: z
        .array(z.object({ email: z.string(), verdict: z.enum(["human", "automated"]).nullable(), confidence: z.number().nullable() }))
        .nullable()
        .openapi({ description: "Jev's verdict per address (null verdict = not judged yet, read as human). Null for a person with no email." }),
    })
    .openapi("Person"),
);

const PeopleSourceReadSchema = z
  .object({
    source: PeopleSourceSchema,
    status: z.enum(SOURCE_STATUSES).nullable().openapi({
      description: "not_connected = the brand (org, for gmail) has no such source; ok = read (people may be 0); failed = could not be read (see error). Null before the first build.",
    }),
    scope: z.enum(["org", "brand"]).openapi({ description: "Gmail is connected per org, so every brand of the org shares it." }),
    people: z.number().int().openapi({ description: "Merged people carrying this source." }),
    presences: z.number().int().openapi({ description: "Source records read (one per address / contact). people <= presences when two records of one source are the same person." }),
    sourceCount: z.number().int().nullable().openapi({ description: "What the source itself counts, for reconciliation." }),
    sourceCountBasis: z.string().nullable(),
    excludedOwn: z.number().int().openapi({ description: "Source records dropped because they are the brand itself: one of our sending mailboxes (instantly-service accounts) or an address on the brand's own domain (brand-service). presences + excludedOwn reconciles with sourceCount." }),
    error: z.string().nullable(),
  })
  .openapi("PeopleSourceRead");

const PeopleListResponseSchema = registry.register(
  "PeopleListResponse",
  z
    .object({
      brandId: z.string().uuid(),
      scope: z.object({
        status: z.enum(["building", "pending", "built", "error"]).openapi({
          description: "building = the first build is running (people is not an answer yet); built = served from the last build; error = the last build failed (lastError), people are from the build before.",
        }),
        lastBuiltAt: z.string().nullable(),
        lastError: z.string().nullable(),
      }),
      sources: z.array(PeopleSourceReadSchema),
      mergeEvidence: z.array(z.unknown()),
      ownAddresses: z
        .object({ status: z.enum(["ok", "failed"]), addresses: z.number().int(), domain: z.string().nullable(), error: z.string().nullable() })
        .nullable()
        .openapi({ description: "What the build knew of the brand's own addresses. status=failed means nothing was excluded on this build (see error)." }),
      senderVerdicts: z
        .object({
          status: z.enum(["ok", "failed"]),
          reused: z.number().int(),
          judged: z.number().int(),
          pending: z.number().int(),
          automatedPeople: z.number().int(),
          model: z.string().nullable(),
          error: z.string().nullable(),
        })
        .nullable()
        .openapi({ description: "Jev's human-vs-automated verdicts on the last build: addresses reused from the record, judged now, still pending (shown as human until judged), people hidden. Null before a build that judged." }),
      automatedHidden: z.number().int().openapi({ description: "People hidden from this list because they are automated senders (0 when includeAutomated=true)." }),
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
      nextOffset: z.number().int().nullable(),
      people: z.array(PersonSchema),
    })
    .openapi("PeopleListResponse"),
);

const TimelineItemSchema = z
  .object({
    at: z.string().nullable().openapi({ description: "When it was sent / happened. Null = the source gave no date; undated items sort last." }),
    source: PeopleSourceSchema,
    channel: z.string().openapi({ example: "email" }),
    kind: z.enum(["message", "event"]),
    direction: z.enum(["inbound", "outbound", "other"]).nullable().openapi({ description: "inbound = the person wrote; outbound = the brand did; null on an event." }),
    subject: z.string().nullable(),
    text: z.string().nullable(),
    from: z.string().nullable(),
    to: z.array(z.string()),
    ref: z.record(z.string(), z.string().nullable()),
    event: z
      .object({ step: z.string(), dateBasis: z.string(), detail: z.record(z.string(), z.unknown()) })
      .nullable(),
    textClean: z
      .object({
        status: z.enum(TEXT_CLEAN_STATUSES).openapi({
          description:
            "google-service bodyCleanStatus, verbatim. cleaned = only the sender's own lines; nothing_kept = no line was judged the sender's words, text is the ORIGINAL; pending / judge_failed = structural clean only (judged on a later read); not_applicable = no readable body (text is the snippet); not_cleaned = never cleaned.",
        }),
        cleaned: z.boolean().openapi({
          description: "True only when text is the cleaned version (status cleaned). False = show the reader that this message is not cleaned.",
        }),
        original: z.string().nullable().openapi({ description: "The full original body, verbatim (null when the message has no readable body)." }),
      })
      .nullable()
      .openapi({ description: "Gmail messages only; null for every other source. How `text` was derived, and the full original." }),
  })
  .openapi("PersonTimelineItem");

const PersonTimelineResponseSchema = registry.register(
  "PersonTimelineResponse",
  z
    .object({
      brandId: z.string().uuid(),
      person: PersonSchema,
      builtAt: z.string(),
      sources: z.array(
        z.object({
          source: PeopleSourceSchema,
          status: z.enum(TIMELINE_SOURCE_STATUSES).openapi({
            description: "ok = items served; empty = connected, nothing with this person; not_connected; failed = could not be read (error).",
          }),
          items: z.number().int(),
          error: z.string().nullable(),
          asked: z.array(z.string()).openapi({ description: "What was asked (addresses, campaign:address pairs, conversations, contacts), so an empty answer is auditable." }),
        }),
      ),
      itemCount: z.number().int(),
      items: z.array(TimelineItemSchema),
    })
    .openapi("PersonTimelineResponse"),
);

const IDENTITY_HEADERS = z.object({ "x-org-id": z.string(), "x-user-id": z.string() });

registry.registerPath({
  method: "get",
  path: "/orgs/people",
  summary: "Every person the brand is in conversation with, merged across channels, with one state",
  description:
    "Gold person layer over Gmail (google-service correspondents: addresses the org's mailbox wrote to), " +
    "cold email (instantly-service engaged leads: replied or clicked), WhatsApp / Telegram / Discord (Matrix) " +
    "and GoHighLevel. People are merged on email / phone only on positive evidence (a record holding both, " +
    "or a lead-service accepted ruling); never on a name. Most recent activity first. Served from the last " +
    "build (rebuilt by cron every 15 minutes); the FIRST read for a brand opens its scope, starts the build " +
    "and answers scope.status=building. Per source: not_connected / ok / failed, people vs the source's own count.",
  request: {
    headers: IDENTITY_HEADERS,
    query: z.object({
      brandId: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(500).optional().openapi({ description: "Default 100." }),
      offset: z.coerce.number().int().min(0).optional(),
      source: PeopleSourceSchema.optional().openapi({ description: "Only people present on this source." }),
      includeAutomated: z.enum(["true", "false"]).optional().openapi({ description: "Also return automated senders (person.automated = true). Default false: hidden." }),
    }),
  },
  responses: {
    200: { description: "People page", content: { "application/json": { schema: PeopleListResponseSchema } } },
    400: { description: "Invalid query", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/timeline",
  summary: "One person's whole exchange, every channel merged into one thread, oldest first",
  description:
    "Read live from where each exchange lives: Gmail (google-service per-address conversation), cold email " +
    "(instantly-service conversation per campaign the address is a lead on), Matrix DMs and GoHighLevel " +
    "funnel events (appointments, stage entries, won/lost, form submissions). Each source answers ok / empty " +
    "/ not_connected / failed. `personKey` may be any of the person's identity keys.",
  request: {
    headers: IDENTITY_HEADERS,
    query: z.object({
      brandId: z.string().uuid(),
      personKey: z.string().openapi({ example: "email:alice@acme.com" }),
    }),
  },
  responses: {
    200: { description: "The merged thread", content: { "application/json": { schema: PersonTimelineResponseSchema } } },
    404: { description: "reason=person_not_found: no person of this brand holds that key" },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/people/sync",
  summary: "Rebuild the brand's people now (async)",
  request: {
    headers: IDENTITY_HEADERS,
    body: { content: { "application/json": { schema: z.object({ brandId: z.string().uuid() }) } } },
  },
  responses: { 202: { description: "Build started; read GET /orgs/people for the result" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/people/sync",
  summary: "Rebuild every people scope (cron)",
  description: "Driven by a cron on the box every 15 minutes. Each scope's build opens its own ORG run, attributed to the user who opened the scope.",
  request: {
    body: { content: { "application/json": { schema: z.object({ scopeId: z.string().uuid().optional() }) } } },
  },
  responses: { 202: { description: "Pass started" } },
});

// ─── PostHog + Stripe (read-only sources of the person thread) ───────────────

const VendorConnectionStatus = z.enum(["active", "paused", "error"]);

export const PosthogConnectionSchema = registry.register(
  "PosthogConnection",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      projectId: z.string().openapi({ description: "PostHog's numeric project id." }),
      region: z.enum(["us", "eu"]).openapi({ description: "PostHog Cloud region (us.posthog.com / eu.posthog.com)." }),
      status: VendorConnectionStatus,
      synced: z.boolean().openapi({ description: "True once a sync has completed." }),
      lastSyncedAt: z.string().nullable(),
      syncedThrough: z.string().nullable().openapi({ description: "Start of the last successful pass; the next one re-reads activity from one hour before it." }),
      lastError: z.string().nullable().openapi({ description: "Why the last sync failed, verbatim. Null when healthy." }),
      lastRunId: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi("PosthogConnection"),
);

export const StripeConnectionSchema = registry.register(
  "StripeConnection",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      keyMode: z.enum(["live", "test"]).openapi({ description: "Read off the restricted key's own prefix (rk_live_ / rk_test_)." }),
      status: VendorConnectionStatus,
      synced: z.boolean(),
      lastSyncedAt: z.string().nullable(),
      lastFullSyncAt: z.string().nullable().openapi({ description: "Last pass that re-listed every object (daily); other passes re-list the last 30 days." }),
      lastError: z.string().nullable(),
      lastRunId: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi("StripeConnection"),
);

const VendorDisconnectSchema = z.object({ disconnected: z.literal(true), connectionId: z.string().uuid() });
const vendorPatchBody = { content: { "application/json": { schema: z.object({ status: z.enum(["active", "paused"]) }) } } };

for (const v of [
  {
    slug: "posthog",
    label: "PostHog",
    schema: PosthogConnectionSchema,
    body: z.object({
      brandId: z.string().uuid(),
      projectId: z.string().openapi({ example: "171095" }),
      region: z.enum(["us", "eu"]),
    }),
    extra: { identifiedPersons: z.number().int().openapi({ description: "PostHog's own count of identified persons (email known) in the project, at connect time." }) },
    description:
      "Resolves the brand's PostHog personal API key from key-service (provider `posthog`, brand-scoped, no org fallback; only the `query:read` scope is needed), then PROVES it by counting the project's identified persons through PostHog's query API. A key PostHog refuses (invalid, missing scope, wrong project or region) comes back 400 with PostHog's own status and message. Read-only: nothing is ever written to PostHog. Requires x-api-key, x-org-id, x-user-id.",
  },
  {
    slug: "stripe",
    label: "Stripe",
    schema: StripeConnectionSchema,
    body: z.object({ brandId: z.string().uuid() }),
    extra: {},
    description:
      "Resolves the brand's Stripe key from key-service (provider `stripe`, brand-scoped, no org fallback). Only a RESTRICTED key (rk_live_… / rk_test_…) with READ permission on Customers, Charges, Refunds and Subscriptions is accepted: a secret key can move money and is refused before any call. The key is proven by one read of each resource; a missing permission comes back 400 with Stripe's own status and message. Read-only: nothing is ever written to Stripe. Requires x-api-key, x-org-id, x-user-id.",
  },
] as const) {
  registry.registerPath({
    method: "post",
    path: `/orgs/${v.slug}/connections`,
    summary: `Connect a brand to ${v.label} (read-only)`,
    description: v.description,
    request: { headers: IDENTITY_HEADERS, body: { content: { "application/json": { schema: v.body } } } },
    responses: {
      200: {
        description: "Connection",
        content: { "application/json": { schema: z.object({ connection: v.schema, ...v.extra }) } },
      },
      400: {
        description: `Refused — no credential stored, not a read-only key, or ${v.label} rejected it (vendorStatus, vendorError)`,
        content: { "application/json": { schema: GhlVendorErrorSchema } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: `/orgs/${v.slug}/connections`,
    summary: `${v.label} connection health for a brand`,
    request: { query: z.object({ brandId: z.string().uuid() }) },
    responses: {
      200: { description: "Connections", content: { "application/json": { schema: z.object({ connections: z.array(v.schema) }) } } },
    },
  });
  registry.registerPath({
    method: "patch",
    path: `/orgs/${v.slug}/connections/{id}`,
    summary: `Pause or resume a ${v.label} connection`,
    request: { params: z.object({ id: z.string().uuid() }), body: vendorPatchBody },
    responses: {
      200: { description: "Connection", content: { "application/json": { schema: z.object({ connection: v.schema }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    },
  });
  registry.registerPath({
    method: "delete",
    path: `/orgs/${v.slug}/connections/{id}`,
    summary: `Disconnect ${v.label} from a brand`,
    description: "Removes the connection, its mirror and the contacts/activity derived from it; the syncing stops.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: "Disconnected", content: { "application/json": { schema: VendorDisconnectSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: `/internal/${v.slug}/sync`,
    summary: `Run a ${v.label} sync pass (cron)`,
    description: `Driven by a cron on the box every 15 minutes. Opens one ORG run per connection. Read-only toward ${v.label}; API reads are free, so no cost is declared.`,
    request: { body: { content: { "application/json": { schema: z.object({ connectionId: z.string().uuid().optional() }) } } } },
    responses: { 202: { description: "Pass started" } },
  });
  registry.registerPath({
    method: "post",
    path: `/internal/${v.slug}/rebuild`,
    summary: `Re-derive ${v.label} silver from the mirror alone`,
    description: `No call to ${v.label}, no credential.`,
    request: { body: { content: { "application/json": { schema: z.object({ connectionId: z.string().uuid().optional() }) } } } },
    responses: { 200: { description: "Rebuilt" } },
  });
}
