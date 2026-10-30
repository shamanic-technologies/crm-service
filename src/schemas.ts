import { CONNECTION_TAGS } from "./lib/people/connection-tags.js";
import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { COLUMN_FIELDS } from "./lib/column-typing.js";
import { MATRIX_CHANNELS } from "./lib/matrix/events.js";
import { ACCOUNT_TYPES, LINE_ROLES, SENDING_ACCOUNT_TYPES } from "./lib/matrix/account-types.js";
import { LEAD_STATUSES } from "./lib/matrix/leads.js";
import { PEOPLE_SOURCES } from "./lib/people/identity.js";
import { STATE_SOURCES } from "./lib/people/state.js";
import { SOURCE_STATUSES } from "./lib/people/sources.js";
import { TEXT_CLEAN_STATUSES, TIMELINE_SOURCE_STATUSES } from "./lib/people/timeline.js";
import { FACT_SOURCES, FACT_TYPES } from "./lib/people/facts.js";
import { RELATIONSHIP_POLICIES } from "./lib/people/relationships.js";
import { OUTCOME_STEPS } from "./lib/people/outcomes.js";
import { SEGMENT_STEPS } from "./lib/people/segment.js";
import { LEG_STEPS } from "./lib/people/leg-reach.js";
import {
  GAP_REASONS,
  LATEST_MESSAGE_STATUSES,
  LATEST_MESSAGE_TEXT_MAX,
  LATEST_MESSAGES_MAX_RELATIONS,
  TEXT_BASES,
  UNKNOWN_REASONS,
} from "./lib/people/latest-messages.js";

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
      companyName: z.string().nullable().optional().openapi({ description: "The company the person works for, as stated (CSV column, CRM, or added one by one)." }),
      companyDomain: z.string().nullable().optional().openapi({ description: "The company's bare web domain (ntt.com)." }),
      jobTitle: z.string().nullable().optional(),
      linkedinUrl: z.string().nullable().optional().openapi({ description: "The person's LinkedIn profile, canonical (https://www.linkedin.com/in/<slug>)." }),
      note: z.string().nullable().optional().openapi({ description: "The client's own words about the person (contacts added one by one), for the email writer." }),
      emailStatus: z.enum(["known", "unknown", "not_found"]).optional().openapi({
        description:
          "known = the contact holds an email (sendable like any CSV contact); unknown = not known yet: serve-next with includeEmailUnknown hands it out for the email to be looked up; not_found = a lookup found none (never handed out again).",
      }),
    })
    .openapi("Contact"),
);

export const AddContactRequestSchema = registry.register(
  "AddContactRequest",
  z
    .object({
      brandId: z.string().uuid(),
      email: z.string().email().nullish(),
      phone: z.string().nullish().openapi({ description: "International form preferred (+33...)." }),
      firstName: z.string().nullish(),
      lastName: z.string().nullish(),
      fullName: z.string().nullish(),
      companyName: z.string().nullish(),
      companyDomain: z.string().nullish().openapi({ description: "A domain or a URL (ntt.com, https://www.ntt.com/...)." }),
      jobTitle: z.string().nullish(),
      linkedinUrl: z.string().nullish().openapi({ description: "The person's LinkedIn profile URL." }),
      note: z.string().max(5000).nullish().openapi({ description: "What the client knows about the person (\"I met him at X\"), stored with the contact for the email writer." }),
    })
    .openapi({ description: "Needs an email, a LinkedIn URL, or a name with a company (companyName or companyDomain)." }),
);

export const AddContactResponseSchema = registry.register(
  "AddContactResponse",
  z.object({
    contactId: z.string().uuid().openapi({ description: "The contact's id (stable across later adds of the same person)." }),
    created: z.boolean().openapi({ description: "false = the brand already held this person (same email or LinkedIn): the same contact, updated, never a second one." }),
    matchedOn: z.enum(["email", "linkedin"]).nullable(),
    emailStatus: z.enum(["known", "unknown", "not_found"]).openapi({ description: "known = sendable now; unknown = the email is looked up when a campaign serves the person; not_found = a lookup found none." }),
    contact: ContactSchema,
  }),
);

export const EmailLookupRequestSchema = registry.register(
  "EmailLookupRequest",
  z.object({
    brandId: z.string().uuid(),
    status: z.enum(["found", "not_found"]),
    email: z.string().email().optional().openapi({ description: "Required with found, refused with not_found." }),
  }),
);

export const EmailLookupResponseSchema = registry.register(
  "EmailLookupResponse",
  z.object({
    contactId: z.string().uuid(),
    status: z.enum(["found", "not_found"]),
    email: z.string().nullable(),
    emailStatus: z.enum(["known", "not_found"]),
    duplicateOf: z.string().uuid().nullable().openapi({ description: "Another contact of the brand already held the found address: that contact is the person (the address is not copied)." }),
    served: z.boolean().openapi({ description: "true = the found address is marked served for the brand: no serve ever hands it out again (the hand-out was its serve)." }),
  }),
);

const EmailUnknownCountsSchema = z.object({
  remaining: z.number().int().openapi({ description: "Email-unknown contacts that can be handed out now." }),
  handedOut: z.number().int().openapi({ description: "Handed out, not written back yet (handed out again after 24 h)." }),
  found: z.number().int(),
  notFound: z.number().int(),
});

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


// ─── Segment (a part of the brand's own CRM, lib/people/segment.ts) ─────────

const segmentName = z.string().min(1).max(200);
export const SegmentSchema = registry.register(
  "PeopleSegment",
  z
    .object({
      dealStages: z
        .array(z.object({ stage: segmentName, pipeline: segmentName.optional() }))
        .min(1)
        .max(50)
        .optional()
        .openapi({
          description:
            "CRM pipeline stage: the person has a deal CURRENTLY at one of these stages (the customer's own stage name, optionally its pipeline name; trimmed, case-insensitive). Names come from GET /orgs/contacts/segments.",
          example: [{ pipeline: "Sales Pipeline", stage: "Form Filled - No Appointment" }],
        }),
      dealStatuses: z.array(segmentName).min(1).max(10).optional().openapi({
        description: "The deal's CRM status, verbatim (GoHighLevel: open, won, lost, abandoned). With dealStages, the SAME deal must match both.",
        example: ["open"],
      }),
      tags: z.array(segmentName).min(1).max(50).optional().openapi({ description: "The person's CRM contact carries one of these tags (case-insensitive)." }),
      reached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional().openapi({
        description: "The person reached one of these funnel steps, any source the brand connected (form submitted, appointment booked / showed / no-show, signup, website visit, sale).",
      }),
      notReached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional().openapi({ description: "The person reached none of these steps." }),
      includeClients: z.boolean().optional().openapi({ description: "Default false: people who reached `sale` (a deal won, a payment that stands) are out." }),
      includeOptedOut: z.boolean().optional().openapi({ description: "Default false: people the CRM marks do-not-contact are out." }),
    })
    .openapi({
      description:
        "A part of the brand's own CRM. Inside a list any one entry matches; across keys all must match. Clients and opted-out people are always out unless stated.",
    }),
);

export const StepFilterSchema = registry.register(
  "StepFilter",
  z
    .object({
      reached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional().openapi({
        description: "The person reached one of these steps (any source the brand connected).",
        example: ["form_submission", "meeting_booked", "meeting_attended", "meeting_not_held"],
      }),
      notReached: z.array(z.enum(SEGMENT_STEPS)).min(1).optional().openapi({
        description: "The person reached none of these steps.",
        example: ["sale", "disqualified"],
      }),
    })
    .openapi({
      description:
        "The SERVING PIPE's funnel-step filter (stated by the play's workflow, forwarded by lead-service and human-service), " +
        "cross-org words only: never a client's stage or tag name. ANDed with the pool and the audience's own filter, on BOTH pools " +
        "(a CSV row is judged on the person holding its address). Clients are ALWAYS out when it is present. " +
        "`sale` = a deal won, a payment that stands, or a CRM stage / tag Jev judged `client`; `disqualified` = a CRM stage / tag " +
        "Jev judged `disqualified` (unqualified, bad fit, blocked: GET /orgs/gohighlevel/label-verdicts).",
    }),
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
      people: z
        .object({
          signedUp: z.boolean().optional().openapi({
            description: "true = only people who signed up to the brand's product (its auth provider, e.g. Clerk); false = only people who did not.",
          }),
          replied: z.boolean().optional().openapi({
            description:
              "false = only people who NEVER wrote to the brand on any conversation channel (Gmail / WhatsApp / LinkedIn inbound, any answer to our cold email): never written to, or written to without an answer. true = only people who answered. Copilot / API use is the product being used, not a conversation.",
          }),
          reachableBy: z
            .union([z.enum(["phone", "email"]), z.array(z.enum(["phone", "email"]))])
            .optional()
            .openapi({ description: "Only people holding a phone / an email (a list = all)." }),
          segment: SegmentSchema.optional().openapi({
            description: "Only people in this part of the brand's own CRM (pipeline stage, tag, funnel step...). Scopes a CRM sourcing to a segment.",
          }),
        })
        .optional()
        .openapi({
          description:
            "Serve from the brand's merged PEOPLE (one row per human, every source) instead of its CSV rows. Exclusive with uploadIds. Always excludes automated senders, people not about this brand, anyone without an email, and anyone the CRM marks do-not-contact (unless segment.includeOptedOut). Same brand-wide no-re-serve: every address of a served person is suppressed, and a person any address of whom was served before is never served.",
        }),
      reachableBy: z
        .union([z.enum(["phone", "email"]), z.array(z.enum(["phone", "email"]))])
        .optional()
        .openapi({
          description:
            "The channel(s) the pipe serving writes on (all required): `phone` (WhatsApp, calls, SMS) or `email`. On BOTH pools, a contact or person the pipe cannot reach is SKIPPED and NOT marked served, so it stays available to a pipe that can. Omit = no requirement (unchanged behaviour).",
        }),
      relationships: z.enum(RELATIONSHIP_POLICIES).optional().openapi({
        description:
          "The pipe's relationship policy (its lead strategy, forwarded by human-service). `business_only`: lead-service is asked who each candidate is to the brand (POST /internal/brands/{brandId}/relationships/query); nobody tagged personal, investor, supplier, team, partner or advisor (sure or unsure), nobody lead-service never judged, nobody without a human id is handed out, on BOTH pools. Such a person is NOT marked served (another pipe may still write to them). lead-service unreadable = 502 relationships_unavailable, nothing served. Omit = unchanged behaviour.",
      }),
      stepFilter: StepFilterSchema.optional().openapi({
        description: "The serving pipe's funnel-step filter (see StepFilter). A person outside it is skipped and NOT marked served. Omit = unchanged behaviour.",
      }),
      includeEmailUnknown: z.boolean().optional().openapi({
        description:
          "CSV pool only (refused with people). After the sendable contacts, fill the rest of `limit` with contacts whose email is NOT known yet but that carry a name AND a company domain, company name or LinkedIn: returned in `contacts` with primaryEmail null, emailStatus unknown. Each is recorded handed out (never handed out twice; again after 24 h if nobody wrote back). The caller looks the email up and writes it back: POST /orgs/contacts/{contactId}/email-lookup. Same opt-out, consent, file, reach and step rules. Under relationships=business_only none is handed out (no known person to judge yet). Omit = unchanged behaviour.",
      }),
    })
    .openapi("ServeNextRequest"),
);

export const ServeNextResponseSchema = registry.register(
  "ServeNextResponse",
  z
    .object({
      contacts: z.array(
        ContactSchema.extend({
          pool: z.literal("people").optional().openapi({ description: "Present on a people-pool serve." }),
          personId: z.string().uuid().nullable().optional().openapi({ description: "People pool: the person's opaque id." }),
          humanId: z.string().uuid().nullable().optional().openapi({ description: "People pool: the fleet-wide human (human-service) the person IS; null when not known yet." }),
          emails: z.array(z.string()).optional().openapi({ description: "People pool: every address of the person, lead address first." }),
          phones: z.array(z.string()).optional().openapi({ description: "People pool: every phone of the person, international form." }),
          phoneSources: z
            .array(z.object({ phone: z.string(), source: z.string(), via: z.string().nullable() }))
            .optional()
            .openapi({ description: "People pool: where each phone came from (source = the person's record holding it, via = the field, e.g. clerk_public_metadata.phone)." }),
          sources: z.array(z.string()).optional(),
        }).openapi("ServedContact"),
      ),
      served: z.number().int().openapi({ description: "How many contacts this call served." }),
      exhausted: z.boolean().openapi({
        description:
          "True when no un-served sendable contacts remain after this serve — for the brand, or " +
          "for the restricted files when `uploadIds` was supplied. Under relationships=business_only: nothing left that may ever be served (no allowed person left AND nobody waiting on a first judgment).",
      }),
      relationships: z
        .object({
          policy: z.enum(RELATIONSHIP_POLICIES),
          checked: z.number().int().openapi({ description: "Candidates lead-service was asked about." }),
          skipped: z.record(z.string(), z.number().int()).openapi({ description: "Candidates kept out (not served, not burned), by reason: never_judged, no_human, tagged_<tag>." }),
        })
        .optional()
        .openapi({ description: "Present only when the request set `relationships`." }),
      emailUnknown: EmailUnknownCountsSchema.extend({
        served: z.number().int().openapi({ description: "Email-unknown contacts handed out by this call." }),
        skipped: z.string().optional().openapi({ description: "Why none was handed out (business_only_needs_a_known_person)." }),
      })
        .optional()
        .openapi({ description: "Present only when the request set includeEmailUnknown. With it, `exhausted` = nothing sendable AND nothing left to look up." }),
    })
    .openapi("ServeNextResponse"),
);

export const StillFitsRequestSchema = registry.register(
  "StillFitsRequest",
  z
    .object({
      brandId: z.string().uuid(),
      email: z.string().openapi({ description: "Any address of the person (case-insensitive)." }),
      people: ServeNextRequestSchema.shape.people.openapi({ description: "Judge against the people pool under this filter (the audience's stored filter, verbatim). Exclusive with uploadIds." }),
      uploadIds: ServeNextRequestSchema.shape.uploadIds.openapi({ description: "CSV pool restricted to these imported files. Omit both people and uploadIds for the brand's whole CSV pool." }),
      stepFilter: StepFilterSchema.optional().openapi({ description: "The serving pipe's step filter, as on serve-next (failed codes step_reached, step_not_reached, step_client; CSV: step_filter)." }),
    })
    .openapi("StillFitsRequest"),
);

export const StillFitsResponseSchema = registry.register(
  "StillFitsResponse",
  z
    .object({
      fits: z.boolean().openapi({ description: "true = the person satisfies every rule of the pool right now (the no-re-serve guard is not a rule here)." }),
      pool: z.enum(["people", "csv"]),
      reason: z.string().optional().openapi({ description: "fits=false only: plain English for a staff dashboard, e.g. \"Has written to the brand on WhatsApp\"." }),
      failed: z
        .array(z.object({ code: z.string(), reason: z.string() }))
        .optional()
        .openapi({ description: "fits=false only: every rule the person fails (code: automated, not_business, no_email, staff, signed_up, replied, no_phone, opted_out, segment_deal, segment_tag, segment_reached, segment_not_reached, client, step_reached, step_not_reached, step_client; CSV: opted_out, consent_denied, not_sendable, not_in_file, step_filter)." }),
    })
    .openapi("StillFitsResponse"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/contacts/still-fits",
  summary: "Does ONE person still belong to a serve pool, right now?",
  description:
    "Judges one person (by email) against the SAME rule serve-next applies (people pool + filter, or the CSV pool / files), " +
    "today. A question, not a serve: nothing is marked served. 404 = no person / imported contact of the brand holds the " +
    "address (never a silent fits); 409 = several do. Requires x-api-key, x-org-id.",
  request: { body: { content: { "application/json": { schema: StillFitsRequestSchema } } } },
  responses: {
    200: { description: "The verdict", content: { "application/json": { schema: StillFitsResponseSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Nobody of the brand holds the address", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "Several people hold the address", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

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
      emailUnknown: EmailUnknownCountsSchema.optional().openapi({ description: "CSV pool, with includeEmailUnknown=true." }),
      byStage: z
        .array(
          z.object({
            pipeline: z.string().nullable(),
            stage: z.string(),
            served: z.number().int(),
            remainingSendable: z.number().int(),
            totalSendable: z.number().int(),
          }),
        )
        .optional()
        .openapi({
          description:
            "People pool with a segment naming dealStages: the same counts per stated stage. Entries overlap when a person holds deals at two of them; the top-level counts count them once.",
        }),
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
  path: "/orgs/contacts",
  summary: "Add ONE person to a brand's CRM (no file)",
  description:
    "A client knows one person and wants them reached (Copilot, API, MCP). The person joins the brand's list \"Contacts added one by one\" (an upload of kind manual in GET /orgs/contacts/uploads) and is served like any CSV contact: with an email, sendable at once; without one, handed out by serve-next with includeEmailUnknown for the email to be looked up inside the campaign's caps. Adding the same email or LinkedIn again keeps ONE contact (created false, the new statement merged in; notes kept). A person already in a CSV file of the brand is taken over by this list (their file data kept). Free: no lookup, no model. Requires x-api-key, x-org-id, x-user-id. 201 created, 200 matched an existing contact; 400 validation | not_enough_to_find.",
  request: { body: { content: { "application/json": { schema: AddContactRequestSchema } } } },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: AddContactResponseSchema } } },
    200: { description: "Already in the CRM: the same contact, updated", content: { "application/json": { schema: AddContactResponseSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/contacts/{contactId}/email-lookup",
  summary: "Write back what an email lookup found for a contact handed out with its email unknown",
  description:
    "found + email: the contact gets the email (a normal sendable contact) and the address is marked served for the brand (the hand-out was its serve). not_found: never handed out again. Idempotent, the latest statement wins. 404 contact_not_found; 409 email_already_known.",
  request: {
    params: z.object({ contactId: z.string().uuid() }),
    body: { content: { "application/json": { schema: EmailLookupRequestSchema } } },
  },
  responses: {
    200: { description: "Recorded", content: { "application/json": { schema: EmailLookupResponseSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not a contact of this brand", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The contact already holds an email", content: { "application/json": { schema: ErrorResponseSchema } } },
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
      pool: z.enum(["csv", "people"]).optional().openapi({ description: "people = count the people pool (see ServeNextRequest.people) with the filters below." }),
      signedUp: z.enum(["true", "false"]).optional(),
      replied: z.enum(["true", "false"]).optional(),
      segment: z.string().optional().openapi({
        description: "pool=people only: a PeopleSegment as URL-encoded JSON, e.g. {\"dealStages\":[{\"stage\":\"No-Show for Appointment\"}]}. Adds `byStage` when it names dealStages.",
      }),
      reachableBy: z.string().optional().openapi({
        description: "phone, email, or phone,email: count only what a pipe writing on those channels can reach (both pools).",
      }),
      stepFilter: z.string().optional().openapi({
        description: "The pipe's StepFilter as URL-encoded JSON (both pools), e.g. {\"reached\":[\"form_submission\"],\"notReached\":[\"sale\",\"disqualified\"]}.",
      }),
      includeEmailUnknown: z.enum(["true"]).optional().openapi({ description: "CSV pool: add `emailUnknown` counts (contacts whose email is looked up at serve time)." }),
    }),
  },
  responses: {
    200: {
      description: "Serve stats",
      content: { "application/json": { schema: ServeStatsResponseSchema } },
    },
  },
});

const SegmentCount = { people: z.number().int().openapi({ description: "Merged people holding it." }), inPool: z.number().int().openapi({ description: "Of them, those a segment serve could hand out now: email held, not automated, not off-topic, not opted out, not a client, never served." }) };
export const SegmentCatalogueSchema = registry.register(
  "PeopleSegmentCatalogue",
  z.object({
    brandId: z.string().uuid(),
    dealStages: z.array(z.object({ pipeline: z.string().nullable(), stage: z.string().nullable(), status: z.string().nullable(), ...SegmentCount })),
    tags: z.array(z.object({ tag: z.string(), ...SegmentCount })),
    steps: z.array(z.object({ step: z.enum(SEGMENT_STEPS), ...SegmentCount })),
  }),
);

registry.registerPath({
  method: "get",
  path: "/orgs/contacts/segments",
  summary: "CRM segments of a brand: pipeline stages, tags and funnel steps, with how many people each holds",
  description:
    "What a people-pool `segment` (ServeNextRequest.people.segment, serve-stats `segment`) can name for this brand, read from its own connected tools: every CRM pipeline stage + deal status, every contact tag, every funnel step reached. Counts are merged people. Read-only, no cost. Requires x-api-key, x-org-id.",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: { description: "Segment catalogue", content: { "application/json": { schema: SegmentCatalogueSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorResponseSchema } } },
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

// ─── Copilot chat turns (the staff Unibox's chat source) ─────────────────────

export const CopilotTurnRequestSchema = z
  .object({
    orgId: z.string().uuid().openapi({ description: "chat-service's org id of the user who chatted (internal uuid). Recorded, never used as the filing scope." }),
    userId: z.string().uuid().openapi({ description: "chat-service's user id of the user who chatted (internal uuid)." }),
    email: z.string().email().openapi({ description: "The user's email: the key that matches them to their person, like any source." }),
    displayName: z.string().max(500).nullable().optional().openapi({ description: "The user's name, when known." }),
    sessionId: z.string().min(1).max(200).openapi({ description: "chat-service's chat session id." }),
    messages: z
      .array(
        z.object({
          messageId: z.string().min(1).max(200).openapi({ description: "chat-service's message id. The idempotency key: a message pushed twice is stored once." }),
          role: z.enum(["user", "assistant"]).openapi({ description: "user = the person wrote (inbound); assistant = the Copilot answered (outbound, shown from \"AI Copilot\")." }),
          text: z.string().min(1).max(200_000).openapi({ description: "The message text, verbatim (the answer the user saw)." }),
          at: z.string().datetime({ offset: true }).openapi({ description: "When the message was written (ISO 8601)." }),
        }),
      )
      .min(1)
      .max(50),
  })
  .openapi("CopilotTurnRequest");

const CopilotTurnResponseSchema = z
  .object({
    stored: z.number().int().openapi({ description: "Messages stored by this call." }),
    duplicates: z.number().int().openapi({ description: "Messages already stored (same messageId): ignored, never shown twice." }),
  })
  .openapi("CopilotTurnResponse");

registry.registerPath({
  method: "post",
  path: "/internal/copilot/messages",
  summary: "Store one Copilot chat turn on the staff Unibox",
  description:
    "chat-service calls this after each Copilot turn with the user's message and the Copilot's answer (both, or whichever is new). " +
    "The turn is filed ONLY under the staff Unibox scope configured on crm-service (COPILOT_UNIBOX_ORG_ID + COPILOT_UNIBOX_BRAND_ID), never under the chatting org: " +
    "it then shows on that person's thread (`GET /orgs/people/timeline`, source `copilot`, channel `chat`), the user's messages inbound, the Copilot's outbound from \"AI Copilot\". " +
    "Idempotent on messageId. A chat the user deletes on chat-service stays here (staff record). No cost, no customer org billed.",
  request: { body: { content: { "application/json": { schema: CopilotTurnRequestSchema } }, required: true } },
  responses: {
    200: { description: "Stored", content: { "application/json": { schema: CopilotTurnResponseSchema } } },
    400: { description: "Validation error" },
    401: { description: "Missing or wrong x-api-key" },
    502: { description: "Run tracking unavailable (nothing stored; retry)" },
    503: { description: "The staff Unibox scope is not configured on crm-service (nothing stored)" },
  },
});

// ─── Account activity (what a client DID on their account, the staff Unibox) ─

export const AccountActivityRequestSchema = z
  .object({
    producer: z.string().min(1).max(100).openapi({ description: "The service that performed the action (e.g. `campaign-service`, `billing-service`). With activityId, the idempotency key." }),
    activityId: z.string().min(1).max(300).openapi({ description: "The producer's own id for this fact (an event / audit row id). A fact reported twice (same producer + activityId) is stored, shown and pinged ONCE." }),
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(100)
      .openapi({ description: "Machine word for the action, snake_case, the producer's own vocabulary (e.g. `campaign_created`, `campaign_updated`, `campaign_paused`, `campaign_resumed`, `campaign_budget_changed`). Served as the timeline item's `event.step`; crm-service has no list of types." }),
    title: z.string().min(1).max(200).openapi({ description: "What happened, plain English, as the owner reads it (e.g. `Campaign created`, `Budget changed`, `Campaign paused`). No em / en dash (stripped)." }),
    subject: z
      .object({
        kind: z.string().min(1).max(100).openapi({ description: "What was acted on (e.g. `campaign`)." }),
        id: z.string().max(200).nullable().optional(),
        name: z.string().max(500).nullable().optional().openapi({ description: "Its name as the client sees it (e.g. `ABA Owners Meetings`): quoted in the line." }),
      })
      .nullable()
      .optional(),
    changes: z
      .array(
        z.object({
          label: z.string().min(1).max(200).openapi({ description: "What changed, plain English (e.g. `Daily budget`)." }),
          before: z.string().max(500).nullable().openapi({ description: "The value before, formatted as the client reads it (e.g. `$20/day`); null = none." }),
          after: z.string().max(500).nullable().openapi({ description: "The value after (e.g. `$50/day`); null = none." }),
        }),
      )
      .max(20)
      .optional()
      .openapi({ description: "Each change, shown `label: before to after`. Omit for a create / pause / resume." }),
    via: z.string().max(100).nullable().optional().openapi({ description: "How the client acted, when the producer knows (e.g. `AI Copilot`, `Dashboard`, `API`, `MCP`). Shown on the ping." }),
    brandId: z.string().uuid().nullable().optional().openapi({ description: "The client brand the action was on (internal uuid), when one." }),
    occurredAt: z.string().datetime({ offset: true }).openapi({ description: "When the action committed (ISO 8601). Older than 24 h when filed = shown on the thread, never pinged." }),
  })
  .openapi("AccountActivityRequest");

const AccountActivityResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "crm-service's row id for the fact." }),
    stored: z.boolean().openapi({ description: "true = first report of this fact." }),
    duplicate: z.boolean().openapi({ description: "true = already reported (same producer + activityId): nothing new stored, nothing pinged." }),
  })
  .openapi("AccountActivityResponse");

registry.registerPath({
  method: "post",
  path: "/internal/account-activity",
  summary: "Report one action a client took on their account (staff Unibox line + one owner Telegram)",
  description:
    "Called fire-and-forget by the service that performed a client's action, after its write committed (campaign created / edited / paused / resumed, a campaign budget changed, any later account action: no crm-service change per producer or type). " +
    "Forward the request's identity headers: `x-org-id` (REQUIRED, the client org), `x-user-id` (who acted; absent = stored, filed nowhere), `x-email` (optional, else read from client-service). " +
    "The fact is filed ONLY under the staff Unibox scope (COPILOT_UNIBOX_ORG_ID + COPILOT_UNIBOX_BRAND_ID), on the actor's thread (matched by address, like the Copilot): `GET /orgs/people/timeline` item source `activity`, channel `account`, kind `event`, `event.step` = type, " +
    "`text` = `<name> · <title>: \"<subject name>\" · <label>: <before> to <after>`. One owner Telegram per fact (thread link). " +
    "Staff (a staff address, a user id ever seen with one, kevin@pressbeat.io) or the staff org = stored `skipped`, no line, no Telegram. " +
    "Answers at once; filing and the ping run after the answer (retried for 24 h if client-service is down). Idempotent on (producer, activityId). No cost.",
  request: {
    headers: z.object({
      "x-org-id": z.string().uuid().openapi({ description: "The client org the action happened in (internal uuid)." }),
      "x-user-id": z.string().uuid().optional().openapi({ description: "Who acted (internal uuid). A client acting through the AI Copilot is the client." }),
      "x-email": z.string().optional().openapi({ description: "The actor's email, when the producer holds it." }),
    }),
    body: { content: { "application/json": { schema: AccountActivityRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "Stored (or already stored)", content: { "application/json": { schema: AccountActivityResponseSchema } } },
    400: { description: "Validation error (body, or a missing / malformed x-org-id)" },
    401: { description: "Missing or wrong x-api-key" },
    502: { description: "Run tracking unavailable (nothing stored; retry)" },
    503: { description: "The staff Unibox scope is not configured on crm-service (nothing stored)" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/account-activity",
  summary: "Every reported account action, newest first: where it was filed and its owner ping",
  request: { query: z.object({ limit: z.string().optional() }) },
  responses: { 200: { description: "Reported account actions" }, 401: { description: "Missing or wrong x-api-key" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/account-activity/watch",
  summary: "Retry now every account action still waiting to be filed or pinged (the loop runs every minute)",
  responses: { 200: { description: "Pass done" }, 401: { description: "Missing or wrong x-api-key" }, 502: { description: "Run tracking unavailable" } },
});

// ─── API / MCP calls (the staff Unibox's API source) ─────────────────────────

const ApiCallSchema = z
  .object({
    callId: z.string().min(1).max(200).openapi({ description: "api-service's id for the call. The idempotency key: a call pushed twice is stored once." }),
    channel: z.enum(["api", "mcp"]).openapi({ description: "api = the client's own code or assistant called the API; mcp = our MCP server called it for the client's assistant (it sends `x-distribute-client: mcp`)." }),
    mcpTool: z.string().max(200).nullable().optional().openapi({ description: "The MCP tool the call served, when the MCP server says (`x-distribute-mcp-tool`)." }),
    orgId: z.string().uuid().nullable().openapi({ description: "The org the call acted in (internal uuid); null when it named none. Recorded, never the filing scope." }),
    userId: z.string().uuid().openapi({ description: "The key's user (internal uuid)." }),
    email: z.string().max(320).nullable().openapi({ description: "The key's user's email: the key that matches the call to their person. null (api-service could not resolve the user) or unusable: the call is skipped and counted, the rest of the batch is stored." }),
    displayName: z.string().max(500).nullable().optional(),
    keyFingerprint: z.string().max(64).nullable().optional().openapi({ description: "One-way fingerprint of the key (first 16 hex of sha256). Never the key." }),
    brandIds: z.array(z.string().max(100)).max(50).optional().openapi({ description: "Brand ids the call named (query, header, body, path)." }),
    method: z.string().min(1).max(10),
    path: z.string().min(1).max(2000).openapi({ description: "The path called, without the query string (e.g. /v1/emails)." }),
    query: z.record(z.string(), z.unknown()).optional().openapi({ description: "Query parameters, secrets already redacted by api-service." }),
    requestHeaders: z.record(z.string(), z.string()).optional().openapi({ description: "An allow-list of harmless request headers (content-type, user-agent, x-request-id, x-org-id, x-brand-id, x-distribute-client, x-distribute-mcp-tool). Never Authorization, x-api-key or cookies." }),
    requestBody: z.string().max(300_000).nullable().optional().openapi({ description: "The request body as text, secrets redacted, cut at 256 KB." }),
    requestBodyBytes: z.number().int().min(0).optional(),
    requestBodyTruncated: z.boolean().optional(),
    status: z.number().int().min(100).max(599),
    responseContentType: z.string().max(200).nullable().optional(),
    responseBody: z.string().max(300_000).nullable().optional().openapi({ description: "Our answer as text, secrets redacted, cut at 256 KB." }),
    responseBodyBytes: z.number().int().min(0).optional().openapi({ description: "The answer's real size, cut or not." }),
    responseBodyTruncated: z.boolean().optional(),
    durationMs: z.number().min(0),
    at: z.string().datetime({ offset: true }).openapi({ description: "When the call arrived (ISO 8601)." }),
    requestId: z.string().max(200).nullable().optional(),
    runId: z.string().max(200).nullable().optional().openapi({ description: "api-service's run for the call." }),
  })
  .openapi("ApiCall");

export const ApiCallsRequestSchema = z
  .object({ calls: z.array(ApiCallSchema).min(1).max(100) })
  .openapi("ApiCallsRequest");

const ApiCallsResponseSchema = z
  .object({
    stored: z.number().int(),
    duplicates: z.number().int().openapi({ description: "Calls already stored (same callId): ignored." }),
    skippedNoEmail: z.number().int().openapi({ description: "Calls whose user has no usable email: no person to file them under." }),
  })
  .openapi("ApiCallsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/api-calls",
  summary: "Store calls made to our API / MCP server with a client's own key, on the staff Unibox",
  description:
    "api-service pushes, in batches, every call a client (or their assistant) made with their own key. Each call is filed ONLY under the staff Unibox scope " +
    "(COPILOT_UNIBOX_ORG_ID + COPILOT_UNIBOX_BRAND_ID), never under the calling org, and shows on that person's thread (`GET /orgs/people/timeline`, source `api`, " +
    "channel `api` or `mcp`): what they asked inbound, what we answered outbound from \"distribute.you API\". Idempotent on callId. No cost, no customer org billed.",
  request: { body: { content: { "application/json": { schema: ApiCallsRequestSchema } }, required: true } },
  responses: {
    200: { description: "Stored", content: { "application/json": { schema: ApiCallsResponseSchema } } },
    400: { description: "Validation error" },
    401: { description: "Missing or wrong x-api-key" },
    502: { description: "Run tracking unavailable (nothing stored; retry)" },
    503: { description: "The staff Unibox scope is not configured on crm-service (nothing stored)" },
  },
});

const ApiCallDetailSchema = z
  .object({
    callId: z.string(),
    channel: z.enum(["api", "mcp"]),
    mcpTool: z.string().nullable(),
    callerOrgId: z.string().nullable(),
    callerUserId: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    keyFingerprint: z.string().nullable(),
    brandIds: z.array(z.string()),
    calledAt: z.string(),
    durationMs: z.number().int(),
    summary: z.object({ asked: z.string(), answered: z.string() }).openapi({ description: "The two lines the thread shows." }),
    request: z.object({
      method: z.string(),
      path: z.string(),
      query: z.record(z.string(), z.unknown()),
      headers: z.record(z.string(), z.string()),
      body: z.string().nullable(),
      bodyBytes: z.number().int(),
      bodyTruncated: z.boolean(),
    }),
    response: z.object({
      status: z.number().int(),
      contentType: z.string().nullable(),
      body: z.string().nullable(),
      bodyBytes: z.number().int(),
      bodyTruncated: z.boolean(),
    }),
  })
  .openapi("ApiCallDetail");

registry.registerPath({
  method: "get",
  path: "/orgs/people/api-calls/{callId}",
  summary: "One API / MCP call, whole: the request and our answer as stored",
  description:
    "The raw side of a thread item of source `api` (its `ref.callId`): method, path, query, harmless headers, request body, status and response body, " +
    "secrets already redacted, each body cut at 256 KB (`bodyTruncated`, real size in `bodyBytes`). Served on the staff Unibox scope only; any other (org, brand) is 404.",
  request: {
    headers: z.object({ "x-org-id": z.string(), "x-user-id": z.string() }),
    params: z.object({ callId: z.string() }),
    query: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: { description: "The call", content: { "application/json": { schema: ApiCallDetailSchema } } },
    400: { description: "brandId missing" },
    404: { description: "reason=call_not_found: no such call in this scope" },
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
      resync: z.boolean().optional().openapi({
        description: "Start from an initial sync (each room's latest timeline + full state) to recover messages an earlier pass skipped. Idempotent.",
      }),
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

const LinkMethodSchema = z.enum(["qr", "phone", "password", "cookies"]).openapi({
  description:
    "WhatsApp: 'qr' (scan in WhatsApp › Linked devices) or 'phone' (8-character pairing code). " +
    "LinkedIn: 'password' (email or phone + password; LinkedIn may then email a 6-digit code) or " +
    "'cookies' (values read from a logged-in browser). A channel's `methods` lists what it offers.",
});

const LinkInputSchema = z
  .object({
    type: z.string().openapi({ description: "'user_input' (a form of `fields`) or 'cookies' (see `cookies`)." }),
    stepId: z.string(),
    instructions: z.string().nullable(),
    fields: z.array(
      z.object({
        id: z.string().openapi({ description: "The key to send the value under in `input`." }),
        type: z.string().openapi({ description: "bridgev2 field type: email, phone_number, password, 2fa_code, select, …" }),
        name: z.string().nullable(),
        description: z.string().nullable(),
        pattern: z.string().nullable(),
        options: z.array(z.string()).nullable(),
      }),
    ),
    cookies: z
      .object({
        url: z.string().nullable(),
        userAgent: z.string().nullable(),
        extractJs: z.string().nullable(),
        fields: z.array(
          z.object({
            id: z.string(),
            required: z.boolean(),
            sources: z.array(z.object({ type: z.string(), name: z.string(), cookieDomain: z.string().nullable() })),
            pattern: z.string().nullable(),
          }),
        ),
      })
      .nullable(),
  })
  .openapi("MatrixLinkInput");

export const MatrixLinkStartRequestSchema = registry.register(
  "MatrixLinkStartRequest",
  z
    .object({
      brandId: z.string().uuid(),
      channel: MatrixChannelSchema,
      method: LinkMethodSchema.optional().openapi({ description: "Required to start or relink. Absent when answering `input`." }),
      phoneNumber: z.string().optional().openapi({
        description: "Required for 'phone'. International format.",
        example: "+33612345678",
      }),
      linkId: z.string().uuid().optional().openapi({
        description:
          "With `input`: the link whose waiting step is answered. With `method` alone: relink THAT account " +
          "(expired session, same mirror). Absent: ADD a new account (a fresh flow; linked accounts untouched).",
      }),
      input: z.record(z.string(), z.string()).optional().openapi({
        description: "Answer to the link's waiting step (`link.input`): field id → value. Relayed to the bridge, never stored.",
        example: { identifier: "me@example.com", password: "…" },
      }),
    })
    .openapi("MatrixLinkStartRequest"),
);

const LinkedAccountTypeSchema = z.enum(ACCOUNT_TYPES).openapi("LinkedAccountType", {
  description:
    "The type the brand picks for each linked account (ACCOUNT-TYPES-1028), any number of each per brand and channel: `pro_human` = Pro (human), a person's work line, written from by automation only when a send asks `fromAccountType: \"pro_human\"`; `personal_human` = Personal (human), a private line, mirrored for the Unibox, never written from by automation and never fires an automated reply; `pro_ai` = Pro (AI), automated sends write from it (among several, the one the person last talked with).",
});

const SendingAccountTypeSchema = z.enum(SENDING_ACCOUNT_TYPES).openapi("SendingAccountType", {
  description: "A type an automated send may ask to write from (`personal_human` never writes): `pro_ai` or `pro_human`.",
});

const WhatsappLineRoleSchema = z.enum(LINE_ROLES).openapi("LinkedLineRole", {
  description:
    "Older word for the account type (SOPHIE-SENDS-1028), still read and written: `assistant` = `pro_ai`, `founder` = `pro_human`. Prefer `accountType`.",
});

const SenderPersonaSchema = z
  .object({
    name: z.string().nullable().openapi({ description: "Display first name of whoever writes from this account (e.g. the assistant's name)." }),
    role: z.string().nullable().openapi({ description: "Their role / title." }),
    instructions: z.string().nullable().openapi({ description: "Free-text persona / style instructions for the writer." }),
  })
  .nullable()
  .openapi("SenderPersona", {
    description:
      "The sender persona the brand gave this linked account (null when none stated). A workflow renders \"You are <name>, <role>\" from the account that will send.",
  });

export const MatrixLinkSchema = registry.register(
  "MatrixLink",
  z
    .object({
      channel: MatrixChannelSchema,
      linkId: z.string().uuid().nullable().openapi({ description: "This account's link. Null on a channel with nothing linked or attempted." }),
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
      input: LinkInputSchema.nullable().openapi({
        description: "Present while the bridge waits for the USER (LinkedIn login form, emailed code, cookies): answer with POST {linkId, input}.",
      }),
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
      needsRelink: z.boolean().openapi({
        description: "The bridge says the session is gone (BAD_CREDENTIALS / LOGGED_OUT): POST {channel, method, linkId} to relink it.",
      }),
      linkedAccounts: z.number().int().openapi({ description: "Accounts currently linked on this channel for the brand." }),
      channelAccounts: z
        .array(
          z.object({
            linkId: z.string().uuid(),
            status: z.enum(["waiting", "linked", "failed"]),
            account: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
            phone: z.string().nullable().openapi({ description: "WhatsApp only: the account's own number, E.164." }),
            outreachDefault: z.boolean(),
            automationAllowed: z.boolean(),
            persona: SenderPersonaSchema,
            accountType: LinkedAccountTypeSchema.nullable(),
            lineRole: WhatsappLineRoleSchema.nullable(),
            needsRelink: z.boolean(),
          }),
        )
        .openapi({
          description:
            "Every account of this channel for the brand (linked or in progress), each with its own number / handle and whether it is the outreach default. Same list on every entry of the channel.",
        }),
      outreachDefault: z.boolean().openapi({
        description: "First messages go out from this account when no linked account already has a conversation with the person. Set with PATCH /orgs/matrix/links/{linkId}.",
      }),
      automationAllowed: z.boolean().openapi({
        description:
          "Automated sends (workflows: welcome, follow-ups, auto-replies) may write from this account, and a message received on it may fire an automated reply. Off = mirrored for the Unibox only, never picked by an automated send, even for a person whose conversation is on it. True unless the brand turns it off. Set with PATCH /orgs/matrix/links/{linkId}.",
      }),
      persona: SenderPersonaSchema,
      accountType: LinkedAccountTypeSchema.nullable().openapi({
        description:
          "The type the brand picked for this account (null = not typed yet): `pro_human` | `personal_human` | `pro_ai`. When the brand typed any account `pro_ai`, every automated send writes from one of its `pro_ai` accounts (the one the person last talked with, else the outreach default, else the oldest). Set with PATCH /orgs/matrix/links/{linkId}.",
      }),
      lineRole: WhatsappLineRoleSchema.nullable().openapi({
        description: "Older word for `accountType`: `assistant` = pro_ai, `founder` = pro_human, null otherwise.",
      }),
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
  summary: "Link an account (WhatsApp, LinkedIn), answer its login step, or relink it — self-serve",
  description:
    "Without `linkId`: ADDS an account — a dedicated bridge account and a fresh login (a brand links N " +
    "accounts per channel; accounts already linked are untouched). With `linkId` + `method`: relinks that " +
    "account. With `linkId` + `input`: answers the step it waits on. Answers `{ link }` = that account: " +
    "a QR, a pairing code, or `input` (a form to fill). Poll GET /orgs/matrix/links for refreshed codes, " +
    "the next step and completion. The same remote account linked twice fails with ACCOUNT_ALREADY_LINKED. " +
    "Read-only: nothing is ever sent on a linked account. Needs x-user-id.",
  request: { body: { content: { "application/json": { schema: MatrixLinkStartRequestSchema } } } },
  responses: {
    200: {
      description: "The account's link",
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
    404: { description: "linkId names no link of this brand + channel", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "The bridge (or WhatsApp / LinkedIn) refused, in its own words; `link` shows the failed state" },
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
      description: "`links` = one entry per channel (its tile), each naming every account of its channel in `channelAccounts` (number / handle, status, outreach default); `accounts` = every account linked or in progress, full view",
      content: {
        "application/json": {
          schema: z.object({ links: z.array(MatrixLinkSchema), accounts: z.array(MatrixLinkSchema) }),
        },
      },
    },
  },
});

export const MatrixLinkUpdateRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    outreachDefault: z.literal(true).optional().openapi({ description: "Make this account the brand's outreach default for its channel." }),
    automationAllowed: z.boolean().optional().openapi({
      description: "false = automated sends never write from this account and a message received on it fires no automated reply (it stays mirrored in the Unibox).",
    }),
    persona: z
      .object({
        name: z.string().max(80).nullable().optional(),
        role: z.string().max(120).nullable().optional(),
        instructions: z.string().max(4000).nullable().optional(),
      })
      .nullable()
      .optional()
      .openapi({ description: "Who writes from this account. Omitted fields keep their value; null or \"\" clears one; persona: null clears all." }),
    accountType: LinkedAccountTypeSchema.nullable().optional().openapi({
      description:
        "Pick this account's type: `pro_human` (Pro, human), `personal_human` (Personal, human: also turns automated sends off on it) or `pro_ai` (Pro, AI: needs automated sends allowed). Any number of accounts per type; `null` clears. Needs a linked account.",
    }),
    lineRole: WhatsappLineRoleSchema.nullable().optional().openapi({
      description: "Older word for `accountType` (`assistant` = pro_ai, `founder` = pro_human, null clears). Not with `accountType`.",
    }),
  })
  .refine(
    (b) =>
      b.outreachDefault !== undefined ||
      b.automationAllowed !== undefined ||
      b.persona !== undefined ||
      b.accountType !== undefined ||
      b.lineRole !== undefined,
    { message: "set at least one of outreachDefault, automationAllowed, persona, accountType, lineRole" },
  )
  .refine((b) => !(b.accountType !== undefined && b.lineRole !== undefined), { message: "`accountType` and `lineRole` are exclusive" })
  .openapi("MatrixLinkUpdateRequest");

registry.registerPath({
  method: "patch",
  path: "/orgs/matrix/links/{linkId}",
  summary: "Update a linked account: outreach default, automated sends allowed, sender persona, account type",
  description:
    "Every field but brandId is optional; at least one is required. `outreachDefault: true`: a first message to a person no allowed account already talks with goes out from this account (one per brand and channel: the others lose it). `automationAllowed`: may automated sends write from this account and may a message received on it fire an automated reply (false = Unibox mirror only). `persona`: who writes from it (`null` clears it; a field set to null or \"\" clears that field). `accountType`: `pro_human` | `personal_human` | `pro_ai` (ACCOUNT-TYPES-1028), any number of accounts per type, `null` clears; `personal_human` turns automated sends off on the account; 409 when the account is not linked, when `pro_ai` meets automated sends off, or when automated sends are turned on on a personal account (`lineRole` = the older words, `assistant` = pro_ai, `founder` = pro_human). Requires x-api-key, x-org-id.",
  request: {
    params: z.object({ linkId: z.string().uuid() }),
    body: { content: { "application/json": { schema: MatrixLinkUpdateRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "The account's view", content: { "application/json": { schema: z.object({ link: MatrixLinkSchema }) } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such link for this brand", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The account is not linked", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/orgs/matrix/links/{channel}",
  summary: "Unlink ONE account: logout, stop syncing, drop what was mirrored for it",
  description:
    "`linkId` names the account; every other account is untouched. Without it the channel's only account " +
    "is meant, and a channel holding several answers 409 `link_id_required` with their `linkIds`.",
  request: {
    params: z.object({ channel: MatrixChannelSchema }),
    query: z.object({ brandId: z.string().uuid(), linkId: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "Unlinked",
      content: {
        "application/json": {
          schema: z.object({
            unlinked: z.literal(true),
            linkId: z.string().uuid(),
            contactsRemoved: z.number().int(),
            connectionRemoved: z.boolean(),
            link: MatrixLinkSchema,
          }),
        },
      },
    },
    404: { description: "No link", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "Several accounts on this channel and no linkId (`type: link_id_required`, `linkIds`)" },
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

const FUNNEL_REACH_DESCRIPTION =
  "Over the brand's WHOLE GoHighLevel history, how many distinct CRM contacts ever reached " +
  "each funnel step, so a consumer can divide adjacent steps into a conversion rate. Counting " +
  "rules: per CONTACT (never per opportunity or appointment); the evidence is exactly what " +
  "the people fact feed (GET /internal/people/facts) states as funnel facts (calendar appointments, stage entries whose recorded " +
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
  method: "get",
  path: "/orgs/gohighlevel/label-verdicts",
  summary: "What each of a brand's CRM labels (pipeline stage, contact tag) says about the person: client | disqualified | none",
  description:
    "Decided once per label by TypeSafe Jev (chat-service /orgs/judgments) with the brand's pipelines and tags as context, recorded " +
    "with its confidence; re-decided only when a new label appears. A verdict below `minConfidence` is never served as evidence. " +
    "`client` / `disqualified` labels become `client` / `disqualified` facts on the people fact feed, and the serve's `sale` / " +
    "`disqualified` steps read them (StepFilter, PeopleSegment), so no consumer reads a client's own words.",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Label verdicts",
      content: {
        "application/json": {
          schema: z.object({
            brandId: z.string().uuid(),
            minConfidence: z.number(),
            labelVerdicts: z.array(
              z.object({
                kind: z.enum(["stage", "tag"]),
                label: z.string().openapi({ description: "Stage name verbatim, or the tag trimmed + lower-cased." }),
                pipelineName: z.string().nullable(),
                verdict: z.enum(["client", "disqualified", "none"]),
                confidence: z.number(),
                model: z.string(),
                decidedAt: z.string(),
              }),
            ),
          }),
        },
      },
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

const LeadDisqualificationSchema = z
  .object({
    level: z.string().openapi({ description: "lead-service's verbatim: `lead` (this person at this company: not the right contact, left the role) or `company` (\"not our target\": every lead of the company)." }),
    offerId: z.string().nullable().openapi({ description: "The offer the mark is about, or null = every offer of the brand." }),
    note: z.string().nullable().openapi({ description: "The optional free note: why, in the words of whoever set it.", example: "Runs a construction company, we sell to supermarkets." }),
    source: z.string().openapi({ description: "lead-service's verbatim: `manual` (a person set it) or `reply` (set from a reply judged not the right contact / left the role)." }),
    statedByUserId: z.string().nullable(),
    statedAt: z.string().openapi({ description: "When it was set (ISO 8601)." }),
  })
  .nullable();

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
      personId: z.string().uuid().nullable().openapi({
        example: "7b0f6a52-1c43-4b8e-9d2a-0f5e3c1a9b77",
        description:
          "The person's OPAQUE id: random, carries no personal data (put THIS in a URL, never personKey). Stable across rebuilds " +
          "(same person, same id). Merge: the merged person keeps the id holding most of its keys (tie: the older); the other id is " +
          "retired and still opens the merged person. Split: the part holding most of the old id's keys keeps it, the other gets a new id. " +
          "Null only on a row built before ids existed (gone at the next build). Pass it to GET /orgs/people/timeline as `personId`.",
      }),
      humanId: z.string().uuid().nullable().openapi({ description: "The fleet-wide human (human-service: ONE id per real human across every org and service; it alone decides same-human) this person IS, in this org's view. Null when the person holds no email / phone, or human-service has not answered yet." }),
      personKey: z.string().openapi({
        example: "email:alice@acme.com",
        description:
          "The person's public id: their smallest email key, else smallest phone key, else a source-local key. Stable while they keep that address. Any of `identityKeys` opens the same person.",
      }),
      identityKeys: z.array(z.string()).openapi({ example: ["email:alice@acme.com", "phone:+33612345678"] }),
      displayName: z.string().nullable(),
      company: z.string().nullable(),
      emails: z.array(z.string()).openapi({
        description:
          "Every address of the person. Addresses lead-service serves for one of our leads come FIRST: show `emails[0]` as the person's address.",
      }),
      phones: z.array(z.string()),
      sources: z.array(PeopleSourceSchema),
      firstActivityAt: z.string().nullable(),
      lastActivityAt: z.string().nullable(),
      state: z.string().openapi({
        example: "sales_interest",
        description:
          "The ONE state, set by `stateSource` (first that applies): lead_service = lead-service's standing TAG verbatim (unresolved | not_contacted | contacted | engaged | sales_interest | website_visit | customer | opted_out; the standing's own `state` rides in `stateDetail.standing`; Disqualified is not a state, see `disqualification`), or `unavailable` when lead-service could not be asked; stripe = subscription_active | subscription_trialing | subscription_past_due | subscription_unpaid | paid | refunded | subscription_canceled; gohighlevel = deal_won | deal_open | deal_lost | deal_abandoned; matrix = new | qualifying | negotiating | won | lost | unresponsive; instantly = replied | clicked; none = in_conversation. Render it; never recompute it.",
      }),
      stateSource: z.enum(STATE_SOURCES),
      stateDetail: z.record(z.string(), z.unknown()).nullable(),
      disqualification: LeadDisqualificationSchema.openapi({
        description:
          "lead-service's Disqualified MARK for the lead the state was read from, relayed verbatim (its `disqualification` on the lead row): shown BESIDE `state`, never instead of it (a lead can read \"Positive reply\" AND \"Disqualified\"). lead-service answers the lead's own mark first, else its company's: `level` says which. Null = not disqualified, or the person is not one of our leads (`stateSource` is not lead_service). Never derived here.",
      }),
      companyTags: z
        .object({
          id: z.string().nullable().openapi({ description: "brand-service company id; null for a name-only employer." }),
          key: z.string().openapi({ description: "lead-service's company key: `id`, else `org:<its local organization id>`." }),
          isClient: z.boolean().openapi({ description: "A lead of this company holds a live sale at the brand: the COMPANY is a client." }),
          signedUp: z.boolean().openapi({ description: "A lead of this company holds a live signup at the brand." }),
          disqualification: LeadDisqualificationSchema.openapi({ description: "The COMPANY-level Disqualified mark (\"not our target\"), covering every lead of the company, or null." }),
        })
        .nullable()
        .openapi({
          description:
            "lead-service's COMPANY block for the lead the state was read from, relayed verbatim (its `company` on the lead row): what holds for the person's company as a buyer of the brand (client, signed up, Disqualified \"not our target\"). Null = no company known, or the person is not one of our leads. Never derived here.",
        }),
      humanTags: z
        .object({
          optedOut: z.boolean().openapi({ description: "human-service carries a live opt_out fact on this human: never write to them again, at any company, any brand." }),
          doNotContact: z.boolean().openapi({ description: "A live do_not_contact fact on the human (e.g. a CRM's DND)." }),
        })
        .nullable()
        .openapi({
          description:
            "lead-service's HUMAN block for the lead the state was read from, relayed verbatim (its `human` on the lead row): what holds for the human wherever they work, whichever evidence decided the state (an unsubscribe under this brand reads state opted_out AND optedOut true). Null = the person is not one of our leads, or lead-service could not resolve the standing (never read as false). Never derived here.",
        }),
      presences: z.array(PersonPresenceSchema),
      mergeEvidence: z.array(z.unknown()).openapi({
        description: "The records that tied two keys of this person together (a Google / GoHighLevel / Stripe / CSV contact holding both, a CONFIDENT lead-service pairing: signal, judgment at or above its pair threshold, or human acceptance). Empty when the person rests on a single key.",
      }),
      automated: z.boolean().openapi({
        description: "True when Jev (chat-service judgments) judged EVERY address of the person an automated sender (digest, notification, no-reply, newsletter) with confidence >= 0.75, the person has no phone and Gmail is their only source. Hidden from GET /orgs/people unless includeAutomated=true.",
      }),
      automatedVerdict: z
        .array(z.object({ email: z.string(), verdict: z.enum(["human", "automated"]).nullable(), confidence: z.number().nullable() }))
        .nullable()
        .openapi({ description: "Jev's verdict per address (null verdict = not judged yet, read as human). Null for a person with no email." }),
      notBusiness: z.boolean().openapi({
        description:
          "Jev judged every one of the person's personal-channel conversations not about this brand (personal-channel-only people). Since RELATIONSHIP-TAGS-1014 (2026-10-14) it hides NOBODY from this list, the search or the fact feed: who a person is to the brand is lead-service's `relationship` block. It only keeps a serve without a relationship policy exactly as before.",
      }),
      groupOnly: z.boolean().openapi({
        description: "True when the person is known ONLY as a member of the brand's messaging groups and never wrote a word anywhere: listed only with includeGroupMembers=true.",
      }),
      connectionTags: z
        .array(
          z.object({
            tag: z.enum(CONNECTION_TAGS).openapi({
              description:
                "personal_to_user = speaks personally to the user who connected the account (a friend); personal_not_to_user = personal, but not to that user (chatter in a group); professional_to_brand = in a work role about what this brand sells (prospect, client, user, referral partner); professional_not_to_brand = in a work role about something else (supplier, the owner's other activity, accountant, automated sender).",
            }),
            userIds: z.array(z.string()).openapi({ description: "Personal tags: the users (client-service ids) it is about, the owners of the accounts the exchange is on. Empty on professional tags." }),
            brandId: z.string().nullable().openapi({ description: "Professional tags: the brand it is judged against (this scope's). Null on personal tags." }),
            basis: z
              .array(z.object({ kind: z.string(), ref: z.string(), probability: z.number().nullable() }))
              .openapi({
                description:
                  "What earned the tag: conversation (Jev on a direct thread, ref = gmail:<address> | matrix:<conversation id>), group_posts (Jev on the person's own posts in a group, ref = room id), group (the group's own verdict, for a member who never wrote), direct_thread_no_words (a direct thread holding no word a person wrote), source / evidence (a record of the brand's own tools: CRM, CSV, Stripe, auth provider, PostHog, cold email, Copilot, API), automated_sender. probability = Jev's yes-probability, null when no model decided.",
              }),
          }),
        )
        .openapi({
          description:
            "CONNECTION-TAGS-1017: in what capacity this human speaks, 0 to 4 tags at once (a friend who is also a client carries both). Empty = nothing judged yet (a Gmail thread whose mailbox was unreadable).",
        }),
      relations: z
        .array(
          z.object({
            relationKey: z.string().openapi({ description: "rel:<personId>:personal | rel:<personId>:org:<companyId> | rel:<personId>:pro (professional, company unknown). Stable across rebuilds." }),
            capacity: z.enum(["personal", "professional"]),
            companyId: z.string().nullable(),
            domain: z.string().nullable(),
            tags: z.array(z.object({ tag: z.enum(CONNECTION_TAGS), userIds: z.array(z.string()), brandId: z.string().nullable(), basis: z.array(z.object({ kind: z.string(), ref: z.string(), probability: z.number().nullable() })) })),
            contactPoints: z
              .array(z.object({ id: z.string(), source: z.string(), companyBasis: z.enum(["evidence", "jev", "user"]).nullable() }))
              .openapi({ description: "Its contact points (`<source>:<id>`: an address, a number, a thread, a CRM / Stripe / Clerk / PostHog record) and how each one's company was decided." }),
            emails: z.array(z.string()),
            phones: z.array(z.string()),
            keys: z.array(z.string()).openapi({ description: "Other identity keys of its points (messaging handles, the brand's user ids)." }),
          }),
        )
        .openapi({
          description:
            "PERSON-RELATIONS-1017: the person x capacity rows. Each contact point is read on its own: capacity from its own tags (professional_to_brand wins; else personal if any personal tag; else professional_not_to_brand), company by evidence > Jev reading its content among the person's known companies > the user's correction. A relation carries ONLY its points' emails, phones, keys and tags.",
        }),
      organizations: z
        .array(
          z.object({
            companyId: z.string().openapi({ description: "brand-service's company id (a brand row; same domain = same id, fleet-wide)." }),
            domain: z.string(),
            evidence: z
              .array(z.object({ kind: z.enum(["email", "website", "user"]), value: z.string(), source: z.string() }))
              .openapi({ description: "What names the company: a work address of the person (its domain), the website their CRM record states, or a user's correction (kind user)." }),
            tags: z
              .array(
                z.object({
                  tag: z.enum(CONNECTION_TAGS),
                  userIds: z.array(z.string()),
                  brandId: z.string().nullable(),
                  basis: z.array(z.object({ kind: z.string(), ref: z.string(), probability: z.number().nullable() })),
                }),
              )
              .openapi({ description: "How the person speaks for this company: the PROFESSIONAL tags of the presences giving the evidence (always at least one)." }),
          }),
        )
        .openapi({
          description:
            "PERSON-ORGANIZATIONS-1017: the organizations the person speaks for in a work role. Only domains Jev judged an organization's own (a public mailbox like gmail.com is nobody's company) that brand-service names; a presence judged personal only gives no link. Empty = none known.",
        }),
      offerIds: z.array(z.string()).openapi({
        description: "The brand's offers (brand-service offer ids) Jev tied this person's personal-channel conversations to (yes-probability >= 0.5, on a conversation about the brand). Empty when none or not judged.",
      }),
      relevance: z
        .array(
          z.object({
            conversation: z.string().openapi({ description: "gmail:<address> or matrix:<conversation id>." }),
            content: z.enum(["readable", "none"]).nullable().openapi({
              description:
                "readable = Jev judged it; none = nothing a person wrote in it (only bridge notices, uncaptioned media, empty mails): no Jev call, topic and probabilities null, never keeps the person visible; null = not judged yet (shown).",
            }),
            topic: z.enum(["personal", "other_business", "this_brand"]).nullable().openapi({
              description: "this_brand = the counterpart is a sales lead of this brand (prospect, client, user, referral partner); other_business = any other work; personal = private life.",
            }),
            confidence: z.number().nullable(),
            brandProbability: z.number().nullable().openapi({ description: "Jev's probability the conversation is about this brand." }),
            offerIds: z.array(z.string()),
          }),
        )
        .nullable()
        .openapi({ description: "Jev's verdict per personal-channel conversation (null topic = not judged yet, shown). Null for a person with no Gmail / Matrix conversation." }),
      possibleLeads: z
        .array(
          z.object({
            crmContactId: z.string().openapi({ description: "This person's GoHighLevel contact (crm-service contact id) lead-service paired." }),
            leadId: z.string().nullable().openapi({
              description:
                "lead-service's lead id, as its pairing rulings take it beside crmContactId (confirm / deny). Null on a person built before v0.25.0 until its next build.",
            }),
            email: z.string().nullable().openapi({ description: "The lead's address as lead-service serves it." }),
            fullName: z.string().nullable(),
            company: z.string().nullable(),
          }),
        )
        .openapi({
          description:
            "Leads lead-service paired with this person's CRM contact on a GUESS (`toConfirm`: a judgment between its thresholds). NOT merged: the lead is its own person. Show as \"maybe the same as <fullName> (<email>), to confirm\". Empty when none.",
        }),
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

const SearchMatchSchema = z
  .object({
    field: z.enum(["name", "company", "email", "phone", "message"]).openapi({
      description: "Why the person matched. name / company / email / phone carry `value`; message carries the message fields.",
    }),
    value: z.string().optional().openapi({ description: "The identity value that holds the query (name, company, email, phone)." }),
    source: z.enum(["gmail", "instantly", "matrix"]).optional(),
    at: z.string().nullable().optional(),
    direction: z.string().nullable().optional().openapi({ description: "inbound = the person wrote; outbound = the brand did." }),
    subject: z.string().nullable().optional(),
    excerpt: z.string().optional().openapi({ description: "~120 characters of the message around the first occurrence of the query." }),
    ref: z.record(z.string(), z.string().nullable()).optional().openapi({ description: "The source's ids for the message (gmailMessageId; campaignId; eventId / roomId / conversationId)." }),
  })
  .openapi("PeopleSearchMatch");

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
      relevance: z
        .object({
          status: z.enum(["ok", "failed"]),
          conversations: z.number().int(),
          reused: z.number().int(),
          judged: z.number().int(),
          noContent: z.number().int().openapi({ description: "Conversations this build found holding nothing a person wrote (recorded, no Jev call)." }),
          pending: z.number().int(),
          topics: z.object({ personal: z.number().int(), other_business: z.number().int(), this_brand: z.number().int() }),
          contentFree: z.number().int().openapi({ description: "Recorded conversations holding nothing a person wrote (all, not only this build)." }),
          notBusinessPeople: z.number().int(),
          contextHash: z.string().nullable(),
          model: z.string().nullable(),
          error: z.string().nullable(),
        })
        .nullable()
        .openapi({ description: "Jev's business / brand / offer verdicts on the last build's personal-channel conversations: recorded ones reused, judged now, still pending (shown until judged), verdicts per topic, people hidden. Null before a build that judged." }),
      notBusinessHidden: z.number().int().openapi({ description: "Always 0 since RELATIONSHIP-TAGS-1014: no conversation verdict hides anyone." }),
      offerId: z.string().nullable().openapi({ description: "The offer filter applied (null = every offer)." }),
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
      nextOffset: z.number().int().nullable(),
      search: z
        .object({
          q: z.string(),
          messageIndex: z
            .object({
              units: z.number().int().openapi({ description: "Conversations indexed for search (one per Gmail address, one per cold-email campaign x address)." }),
              indexed: z.number().int(),
              failed: z.number().int().openapi({ description: "Conversations whose last read failed: their newest messages may be missing from the search." }),
              messages: z.number().int(),
              lastIndexedAt: z.string().nullable(),
            })
            .openapi({ description: "Coverage of the Gmail + cold-email message index the search read (WhatsApp / Telegram / Discord text is searched in place, always complete)." }),
          tookMs: z.number().int(),
        })
        .optional()
        .openapi({ description: "Present only when `q` is set." }),
      families: z
        .object({
          status: z.enum(["ok", "failed"]).openapi({ description: "failed = features-service could not be read: every person's family is null for THAT reason, never \"nobody has a family\" (see error)." }),
          error: z.string().nullable(),
          filter: z.enum(["won", "hot", "lost", "cold"]).nullable().openapi({ description: "The family this page is filtered on (null = All)." }),
          counts: z
            .object({ won: z.number().int(), hot: z.number().int(), lost: z.number().int(), cold: z.number().int() })
            .nullable()
            .openapi({ description: "People per family over THIS list's population (source / includeAutomated / q applied, family not): what each filter button returns. Sums to withFamily." }),
          lostBreakdown: z.object({ wentCold: z.number().int(), ruledOut: z.number().int() }).nullable(),
          withFamily: z.number().int().nullable(),
          withoutFamily: z.number().int().nullable().openapi({ description: "People of the population who are not one of our leads (shown under All only)." }),
          producerCounts: z
            .object({ won: z.number().int(), hot: z.number().int(), lost: z.number().int(), cold: z.number().int() })
            .nullable()
            .openapi({ description: "features-service's own counts over ALL the brand's leads, most never in conversation with the brand (for reconciliation)." }),
          readAt: z.string().nullable().openapi({ description: "When crm-service read features-service (a read is shared for up to 60s)." }),
        })
        .openapi({ description: "The Unibox family filters (Won clients, Hot leads, Lost leads, Cold leads)." }),
      groupMembersHidden: z.number().int().openapi({ description: "People hidden because they are known ONLY as members of the brand's messaging groups and never wrote a word (0 when includeGroupMembers=true)." }),
      people: z.array(
        PersonSchema.extend({
          family: z.enum(["won", "hot", "lost", "cold"]).nullable().openapi({
            description: "features-service's verdict on this person as our lead, verbatim; a person with several lead addresses takes the strongest (won > hot > lost > cold). Null = not one of our leads, or families.status = failed.",
          }),
          familyLostReason: z.enum(["went_cold", "ruled_out"]).nullable().openapi({ description: "lost only: went_cold or ruled_out (features-service's reason)." }),
          matches: z.array(SearchMatchSchema).optional().openapi({
            description: "Search only: every identity field holding the query, then up to 3 newest matching messages.",
          }),
          messageMatches: z.number().int().optional().openapi({ description: "Search only: how many of the person's messages hold the query." }),
        }),
      ),
    })
    .openapi("PeopleListResponse"),
);

const TimelineItemSchema = z
  .object({
    at: z.string().nullable().openapi({ description: "When it was sent / happened. Null = the source gave no date; undated items sort last." }),
    source: PeopleSourceSchema.openapi({
      description:
        "A people source. `csv` = the `added_to_crm` event of a contact imported from an uploaded file (channel `file`) or added by hand (channel `manual`); a contact added by hand is a person (source `csv`), a file row is merge evidence only.",
    }),
    channel: z.string().openapi({ example: "email" }),
    kind: z.enum(["message", "event"]),
    direction: z.enum(["inbound", "outbound", "other"]).nullable().openapi({ description: "inbound = the person wrote; outbound = the brand did; null on an event." }),
    subject: z.string().nullable(),
    text: z.string().nullable(),
    from: z.string().nullable(),
    to: z.array(z.string()),
    ref: z.record(z.string(), z.string().nullable()).openapi({
      description:
        "The source's own ids for this item (thread, message, campaign, contact...). " +
        "`factId` (UNIBOX-FACT-ID-1019): on a message that IS one of our facts on the people fact feed (Matrix: WhatsApp / LinkedIn / Telegram..., `message_in` / `message_out` / `group_message`; Gmail `message_in` / `message_out`), " +
        "the id of the LIVE fact (`factId` on GET /internal/people/facts; lead-service's copy keeps it as its message id). " +
        "Absent on anything that is no fact here (cold email, Copilot, API calls) and on an item whose fact is not emitted (held, unattributed, not yet): never a guess. " +
        "UNIBOX-FACT-LAG-1028: events carry it too when they are facts (Stripe payments, refunds, subscriptions; PostHog visits and events; CRM / auth entries), " +
        "with `factKey` = the natural key of the fact the record states, and every item a fact is derived from carries `recordedAt` = when crm-service recorded its source record (read by `factFeed`).",
    }),
    event: z
      .object({ step: z.string(), dateBasis: z.string(), detail: z.record(z.string(), z.unknown()) })
      .nullable()
      .openapi({
        description:
          "Events only. Besides the funnel / web / payment steps, every source record that brought the person in adds ONE entry event, " +
          "only when the source dates it (never invented, never the build time): " +
          "gohighlevel `added_to_crm` (dateBasis `contact_created_at`), csv `added_to_crm` (dateBasis `uploaded_at`, detail filename + uploadId), " +
          "posthog `signup` (dateBasis `person_created_at`), stripe `stripe_customer_created` (dateBasis `customer_created_at`; a customer record is no payment). " +
          "Source `api` (channel `api` or `mcp`) carries messages only: each call the person made to our API (or through our MCP server) with their own key is two messages, " +
          "what they asked (inbound, a plain-words summary) and what we answered (outbound, from \"distribute.you API\"), both with `ref.callId` (whole call: GET /orgs/people/api-calls/{callId}), `ref.sessionId` (calls on one channel less than 30 min apart), method, path, status, mcpTool; staff Unibox scope alone. " +
          "Source `copilot` (channel `chat`) carries messages only: the person's chat with the distribute.you Copilot, served on the staff Unibox scope alone, inbound = the user wrote, outbound = the Copilot answered (`from` \"AI Copilot\"). " +
          "Source `onboarding` (channel `account`, step `onboarding_record`, dateBasis `latest_setup_change`, ONBOARDING-FICHE-1027): WHAT THE PERSON SET UP with us, one event per account (org x brand) they belong to, read on the spot from the services that own each choice (brand-service: brand website, offer name + description + value proposition fields with provenance, client value, booking link; lead-service: qualification signals on / off; human-service: audiences with description and who exactly; campaign-service: funnel campaigns, status, created; billing-service: each campaign's budget / volume cap). " +
          "`text` = the whole record in plain lines, NOTHING cut (read it verbatim, never the PostHog `Get started` lines); `detail` = the same record structured ({orgId, orgName, userId, email, brand {id, name, website}, offers [{offerId, name, description, status, fields [{key, value, provenance}], clientValueUsd, bookingUrl, destinationUrl, signals [{id, title, question, enabled}], audiences [{id, name, description, targetText, status}], campaigns [{id, name, status, stopReason, createdAt, maxBudget {amountCents, period}, maxVolume {count, period, unit}, funnelType}]}], latestChangeAt}); `ref` accountOrgId / accountBrandId / accountUserId. Staff Unibox scope alone; an owner unreadable = source `failed`, never a partial record.",
      }),
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
    outreachFact: z
      .object({
        subjectKey: z.string().openapi({
          description:
            "The email_sent outreach fact's identity (`ievt:<event id>`), the same value lead-service keeps as that fact's id / source ref. Pair the email with its fact on this, never on time.",
          example: "ievt:f2bc3a15-2643-4ed0-a571-a2f65c35cdb8",
        }),
        step: z.number().int().nullable().openapi({ description: "Sequence step (1 = first email). Null where instantly-service's feed serves none (poll-only sends)." }),
        position: z.enum(["first", "followup"]).openapi({ description: "First email or follow-up, always set." }),
      })
      .nullable()
      .openapi({
        description:
          "Cold-email (instantly) OUTBOUND messages only: which email_sent outreach fact this email is, verbatim from instantly-service. Null on inbound mail, on a send instantly-service cannot tie to a fact (a manual reply), and on every other source.",
      }),
    sentBy: z
      .enum(["person", "automation"])
      .nullable()
      .optional()
      .openapi({
        description:
          "WHO sent an outbound message (ONBOARDING-FICHE-1027), on every served item: automation = one of our machines (a transactional email such as the welcome email, a cold-email sequence step, an automated WhatsApp send, the Copilot, the API); person = a human of the brand typed it (a WhatsApp / Telegram message from the brand's account that is none of our sends); null = inbound, an event, or the source does not say (a Gmail send). A Gmail copy of a transactional email we sent is not served (the transactional item is that email).",
      }),
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
            description:
              "ok = items served; empty = connected, nothing with this person; not_connected; failed = could not be read (error). " +
              "Gmail is also failed when its thread could not be re-read for THIS answer (source error, 15s deadline, mailbox gone): " +
              "the stored items are still served beside the error, so a writer never takes a stale thread for a complete one.",
          }),
          items: z.number().int(),
          error: z.string().nullable(),
          asked: z.array(z.string()).openapi({ description: "What was asked (addresses, campaign:address pairs, conversations, contacts), so an empty answer is auditable." }),
          servedFrom: z.enum(["store", "mirror"]).openapi({
            description:
              "store = Gmail / cold email, served from crm-service's message store, READ-THROUGH: every thread of the person read more than 10s ago is re-read " +
              "from its source before the answer (Gmail asking google-service for a fresh mirror), so a message sent seconds ago is on this read. " +
              "mirror = crm-service's own synced data (Matrix, GoHighLevel, PostHog, Stripe), read in place.",
          }),
          readAt: z.string().nullable().openapi({ description: "store only: the oldest source read the served items come from. Null = never read (or a mirror source)." }),
          refreshing: z.boolean().openapi({
            description:
              "store only: a re-read of one of this source's threads was still running when the answer left; it lands in the store, read again in a few seconds. " +
              "On a PAGED read a thread with a good stored copy being re-read is `refreshing`, never `failed`.",
          }),
          joinedAtRead: z.array(z.string()).openapi({
            description:
              "Mirror sources (GoHighLevel, PostHog, Stripe, Clerk): the records (contact ids) that state one of this person's identity keys " +
              "but that the person index had not joined to them yet (built before the record carried the key, e.g. a PostHog person who typed " +
              "their email minutes ago). Their items ARE in this answer, read through; a rebuild is kicked. Empty = the index already held every record. " +
              "If that check itself fails, the source is `failed` (its indexed items still served), never a complete-looking `empty`.",
          }),
        }),
      ),
      indexCurrent: z.boolean().openapi({
        description:
          "false = at least one source served records the person index had not joined yet (`sources[].joinedAtRead`), or that check failed. " +
          "The answer is still complete for those sources; the index catches up on the rebuild this read kicked.",
      }),
      factFeed: z
        .object({
          settled: z.boolean().openapi({
            description:
              "true = every record of this thread that states a fact is on the people fact feed (lead-service's copy follows within its pull interval). " +
              "false = at least one is still in flight: recorded by crm-service, stated by the next fact emission (seconds). " +
              "A WRITER reads again shortly instead of writing on a thread that newer facts (a refused payment, an onboarding step) have not reached the feed yet.",
          }),
          statedThrough: z.string().nullable().openapi({ description: "When the scope's last fact emission began reading (null = never emitted)." }),
          pending: z
            .array(z.object({ source: z.string(), at: z.string().nullable(), step: z.string().nullable(), factKey: z.string(), recordedAt: z.string() }))
            .openapi({ description: "The items whose fact is still in flight (on a paged read: of this page)." }),
        })
        .openapi({ description: "UNIBOX-FACT-LAG-1028: is this person's thread on the people fact feed yet? Generic over every source." }),
      itemCount: z.number().int().openapi({ description: "Items in THIS response (the page, on a paged read)." }),
      totalItems: z.number().int().optional().openapi({ description: "Paged read only: items of the whole thread." }),
      page: z
        .object({
          limit: z.number().int(),
          before: z.string().nullable().openapi({ description: "The cursor this page was read before (null = the latest page)." }),
          hasOlder: z.boolean(),
          olderCursor: z.string().nullable().openapi({ description: "Pass as `before` to read the page just older than this one. Null when none." }),
        })
        .optional()
        .openapi({ description: "Paged read only (`limit` or `before` given)." }),
      items: z.array(TimelineItemSchema).openapi({ description: "Oldest first. On a paged read: the `limit` latest items older than `before`, still oldest first." }),
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
    "cold email (instantly-service written-to leads: everyone we sent at least one email to, answered or not), WhatsApp / Telegram / Discord (Matrix) " +
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
      includeNotBusiness: z.enum(["true", "false"]).optional().openapi({ description: "Kept for compatibility: since RELATIONSHIP-TAGS-1014 no person is notBusiness (who a person is to the brand is lead-service's, which serves the Unibox list), so it changes nothing." }),
      includeGroupMembers: z.enum(["true", "false"]).optional().openapi({ description: "Also return people known ONLY as members of the brand's messaging groups (WhatsApp, LinkedIn...) who never wrote a word (person.groupOnly = true). Default false: hidden." }),
      offerId: z.string().uuid().optional().openapi({ description: "Only people with a conversation Jev tied to this offer of the brand (person.offerIds contains it)." }),
      family: z.enum(["won", "hot", "lost", "cold"]).optional().openapi({
        description:
          "Unibox family filter: only people whose family (features-service's verdict on our lead, read verbatim) is this one. " +
          "won = client won; hot = interested, not won yet; lost = became interested then went cold, or ruled out; cold = contacted, never interested. " +
          "Combines with q, source, includeAutomated and paging. 502 lead_families_unavailable when features-service cannot be read (never an empty list). Absent = All.",
      }),
      q: z.string().max(200).optional().openapi({
        description:
          "Search (case-insensitive substring, whole query): the person's name, any email (a domain works), any phone (4+ digits), " +
          "company, and the subject/body of their Gmail, cold-email and WhatsApp / Telegram / Discord messages. Same order, paging " +
          "and filters as the list; total counts matches. Each person carries `matches` (why) and the response `search` (index coverage). " +
          "Blank = the plain list.",
      }),
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
    "/ not_connected / failed. Name the person with EXACTLY ONE of `personId` (the opaque id on every person, preferred) " +
    "or `personKey` (any of the person's identity keys, kept for existing callers). Every source record that dates how the person " +
    "entered it (GoHighLevel contact created, CSV file uploaded, PostHog person created, Stripe customer created) adds one entry event.",
  request: {
    headers: IDENTITY_HEADERS,
    query: z.object({
      brandId: z.string().uuid(),
      personId: z.string().uuid().optional().openapi({
        example: "7b0f6a52-1c43-4b8e-9d2a-0f5e3c1a9b77",
        description: "The person's opaque id (Person.personId). A retired id (merged away) opens the person it merged into.",
      }),
      personKey: z.string().optional().openapi({ example: "email:alice@acme.com", description: "Any identity key of the person." }),
      relationKey: z.string().optional().openapi({
        example: "rel:7b0f6a52-1c43-4b8e-9d2a-0f5e3c1a9b77:org:3f2b...",
        description:
          "PERSON-RELATIONS-1017: one relation of the person (Person.relations[].relationKey): the thread of ONLY its contact points (a friend's personal WhatsApp never shows in their professional row). 404 relation_not_found.",
      }),
      limit: z.coerce.number().int().min(1).max(500).optional().openapi({
        description:
          "PAGED read: the `limit` latest items (default 10 when only `before` is given). The answer waits at most ~0.15 s for the threads' re-reads, then serves the store " +
          "(`sources[].refreshing`). Absent with `before` absent = the whole thread, read-through as before (writers).",
      }),
      before: z.string().optional().openapi({ description: "PAGED read: the previous page's `page.olderCursor`; returns the items just older than it." }),
    }),
  },
  responses: {
    200: { description: "The merged thread", content: { "application/json": { schema: PersonTimelineResponseSchema } } },
    400: { description: "Neither or both of personId / personKey, a personId that is not a uuid, or a `before` this route did not serve" },
    404: { description: "reason=person_not_found: no person of this brand holds that key / id" },
  },
});

// ─── Outcomes: every person who reached a step, any source ───────────────────

const OutcomeStepSchema = z.enum(OUTCOME_STEPS).openapi({
  description:
    "lead-service's bucket tokens. website_visit / signup / form_submission (crm fact form_submitted) / meeting_booked / " +
    "meeting_attended / sale (a CRM deal won, or a Stripe payment that succeeded and was not wholly refunded).",
});
const ScopeViewSchema = z.object({
  status: z.string().openapi({ description: "building on the first read for a brand (the people index is being built), then the build status." }),
  lastBuiltAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const OutcomesResponseSchema = registry.register(
  "PeopleOutcomes",
  z.object({
    brandId: z.string().uuid(),
    scope: ScopeViewSchema,
    steps: z.array(
      z.object({
        step: OutcomeStepSchema,
        people: z.number().int().openapi({ description: "Distinct people who reached the step, any source; one person once even when two sources state it." }),
        sources: z
          .array(z.object({ source: z.string(), people: z.number().int() }))
          .openapi({ description: "Distinct people per source stating the step (posthog, clerk, stripe, gohighlevel, and campaigns = the people our campaigns brought there, lead-service's bucket). Overlaps: one person on two sources counts in both." }),
        contactedByUs: z.number().int().openapi({
          description:
            "Of `people`, those our campaigns brought to this step: lead-service holds them in the step's bucket under one of the brand's offers (a campaign of ours served them and is credited the step), what the dashboard's Contacted by us tab counts, one person once. A person lead-service merely holds (its brand-wide bucket), or one we wrote to only after they reached the step, is not counted.",
        }),
        months: z
          .array(
            z.object({
              month: z.string().openapi({ description: "UTC month, YYYY-MM." }),
              people: z.number().int().openapi({ description: "People whose earliest dated statement of the step falls in this month (one person once)." }),
              contactedByUs: z.number().int().openapi({ description: "Of `people` this month, those contacted by us (same rule as the step's contactedByUs)." }),
              cumulativePeople: z.number().int().openapi({ description: "Running total of `people` since the first month, this month included. Last month's + undated.people = the step's people." }),
              cumulativeContactedByUs: z.number().int().openapi({ description: "Running total of `contactedByUs`. Last month's + undated.contactedByUs = the step's contactedByUs." }),
            }),
          )
          .openapi({ description: "Every month from the brand's first dated reach (any step, so all steps share one axis) to the current month, empty months as zeros. [] when the brand holds no dated reach. sum(months.people) + undated.people = people." }),
        undated: z
          .object({ people: z.number().int(), contactedByUs: z.number().int() })
          .openapi({ description: "Reaches no source dates (campaigns-only: lead-service states no bucket date), kept apart so the series reconciles with `people`." }),
      }),
    ).openapi({ description: "Always all six steps, in funnel order, zeros included." }),
  }),
);

export const OutcomePeopleResponseSchema = registry.register(
  "PeopleOutcomePeople",
  z.object({
    brandId: z.string().uuid(),
    step: OutcomeStepSchema,
    total: z.number().int().openapi({ description: "Equals that step's `people` in GET /orgs/people/outcomes." }),
    limit: z.number().int(),
    offset: z.number().int(),
    people: z.array(
      z.object({
        personId: z.string().uuid().nullable().openapi({ description: "Opaque person id (pass to GET /orgs/people/timeline). Null only when the person has left the people index since." }),
        personKey: z.string(),
        displayName: z.string().nullable(),
        company: z.string().nullable(),
        emails: z.array(z.string()),
        phones: z.array(z.string()),
        reachedAt: z.string().nullable().openapi({ description: "Earliest dated statement of the step; null when no source dated it." }),
        sources: z.array(z.object({ source: z.string(), reachedAt: z.string().nullable() })),
        contactedByUs: z.boolean().openapi({ description: "In lead-service's bucket of this step under one of the brand's offers: our campaigns brought them here (same rule as the step's contactedByUs)." }),
        state: z.string().nullable(),
        stateSource: z.string().nullable(),
      }),
    ).openapi({ description: "Earliest reachedAt first (undated last), then personKey: a total order, safe to page." }),
  }),
);

const CorrectionSchema = z
  .object({
    correctionId: z.string().uuid(),
    kind: z.enum(["tag_add", "tag_remove", "organization_add", "organization_remove", "domain_kind"]),
    personId: z.string().nullable(),
    target: z.record(z.string(), z.unknown()).openapi({ description: "What it states: {tag} | {domain, companyId, tags} | {companyId} | {domain, domainKind, companyId?}." }),
    reason: z.string().nullable(),
    statedByUserId: z.string(),
    createdAt: z.string(),
    undoneAt: z.string().nullable(),
    undoneByUserId: z.string().nullable(),
  })
  .openapi("PeopleCorrection");

registry.registerPath({
  method: "post",
  path: "/orgs/people/corrections",
  summary: "Correct what the registry worked out about people: a tag, a person's company, a domain",
  description:
    "PEOPLE-CORRECTIONS-1017. A user's statement, recorded with who / when / why, honoured by every people build until undone: a human " +
    "statement always wins over Jev and the sources. Kinds: `tag_add` / `tag_remove` {personId, tag} (one of the four connection tags); " +
    "`organization_add` {personId, domain (or website), tags? (professional tags; default = the person's)} / `organization_remove` {personId, companyId}; " +
    "`domain_kind` {domain, domainKind: mailbox_provider | organization} (overrides the domain verdict for this brand's people). A newer statement " +
    "on the same thing replaces the older; an add takes back an active remove of the same thing (and the other way). Same statement twice = 200 duplicate. " +
    "A rebuild starts at once (~1 min). 404 person_not_found, 422 company_unresolved (brand-service names no company for the domain) | tags_required.",
  request: {
    headers: IDENTITY_HEADERS,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            brandId: z.string().uuid(),
            kind: z.enum(["tag_add", "tag_remove", "organization_add", "organization_remove", "domain_kind"]),
            personId: z.string().uuid().optional(),
            tag: z.enum(CONNECTION_TAGS).optional(),
            domain: z.string().optional(),
            companyId: z.string().uuid().optional(),
            domainKind: z.enum(["mailbox_provider", "organization"]).optional(),
            tags: z.array(z.enum(CONNECTION_TAGS)).optional(),
            contactPoint: z.string().optional().openapi({
              description:
                "PERSON-RELATIONS-1017: one contact point of the person (as served in a relation's contactPoints, `<source>:<id>`): the tag / company correction applies to that point only, so its relation moves (e.g. this Gmail thread is personal; this Stripe account is Acme's). Absent = the whole person.",
            }),
            reason: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: z.object({ correction: CorrectionSchema, duplicate: z.boolean(), rebuild: z.string() }) } } },
    200: { description: "Already stated", content: { "application/json": { schema: z.object({ correction: CorrectionSchema, duplicate: z.boolean(), rebuild: z.string() }) } } },
    400: { description: "Invalid body", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "person_not_found", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "company_unresolved | tags_required", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/corrections",
  summary: "Every correction of the brand, newest first (undone ones included)",
  request: { headers: IDENTITY_HEADERS, query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: { description: "Corrections", content: { "application/json": { schema: z.object({ brandId: z.string(), corrections: z.array(CorrectionSchema) }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/people/corrections/{correctionId}/undo",
  summary: "Take a correction back: the automatic answer applies again from the rebuild that starts now",
  request: {
    headers: IDENTITY_HEADERS,
    params: z.object({ correctionId: z.string().uuid() }),
    body: { content: { "application/json": { schema: z.object({ brandId: z.string().uuid() }) } } },
  },
  responses: {
    200: { description: "Undone", content: { "application/json": { schema: z.object({ correction: CorrectionSchema, duplicate: z.boolean(), rebuild: z.string() }) } } },
    404: { description: "correction_not_found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/organizations",
  summary: "The organizations the brand's people speak for, each with its people and tags",
  description:
    "PERSON-ORGANIZATIONS-1017: one row per company (brand-service id) at least one person of the brand speaks for in a work role, " +
    "most people first. `tags` = the professional connection tags its human x organization links carry, with how many people carry each " +
    "(an organization's tags are the union of its links'). Read off the last people build.",
  request: {
    headers: IDENTITY_HEADERS,
    query: z.object({
      brandId: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Default 100." }),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Organizations",
      content: {
        "application/json": {
          schema: z.object({
            brandId: z.string(),
            scope: z.object({ status: z.string(), lastBuiltAt: z.string().nullable(), lastError: z.string().nullable() }),
            total: z.number().int(),
            links: z.number().int().openapi({ description: "Human x organization links over the brand." }),
            organizations: z.array(
              z.object({
                companyId: z.string(),
                domains: z.array(z.string()),
                people: z.number().int(),
                tags: z.array(z.object({ tag: z.enum(CONNECTION_TAGS), people: z.number().int() })),
              }),
            ),
          }),
        },
      },
    },
    400: { description: "Invalid query", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/outcomes",
  summary: "Per outcome step, how many distinct people of the brand reached it, from any source",
  description:
    "Website visits, signups, form submissions, meetings booked / attended, paid clients: everyone the brand's own tools " +
    "(PostHog, Clerk, Stripe, GoHighLevel) state, not only the leads our campaigns contacted. Read off the live people fact " +
    "feed (withdrawn facts excluded, persons merged across sources), UNION the people our campaigns brought to the step " +
    "(lead-service's bucket of the same token, source `campaigns`, undated): all sources is a superset of our campaigns on every step. " +
    "Anonymous visitors are not people and are not counted. 502 reason=campaign_outcomes_unavailable when lead-service cannot be read.",
  request: { headers: IDENTITY_HEADERS, query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: { description: "Per-step counts", content: { "application/json": { schema: OutcomesResponseSchema } } },
    400: { description: "Invalid query", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/outcomes/people",
  summary: "The people who reached one outcome step, paged",
  request: {
    headers: IDENTITY_HEADERS,
    query: z.object({
      brandId: z.string().uuid(),
      step: OutcomeStepSchema,
      limit: z.coerce.number().int().min(1).max(500).optional().openapi({ description: "Default 100." }),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: { description: "People page", content: { "application/json": { schema: OutcomePeopleResponseSchema } } },
    400: { description: "Invalid query", content: { "application/json": { schema: ErrorResponseSchema } } },
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

// ─── Stated merges (two people of a brand are one human) ─────────────────────

const PersonMergeSchema = registry.register(
  "PersonMerge",
  z.object({
    mergeId: z.string().uuid(),
    brandId: z.string().uuid(),
    personIds: z.array(z.string().uuid()).openapi({ description: "The two person ids as stated. After the rebuild one of them names the merged person and the other is retired into it (it still opens the merged person)." }),
    keys: z.object({ a: z.array(z.string()), b: z.array(z.string()) }).openapi({ description: "Every identity key each person held when the merge was stated; the builder ties them all together on every rebuild." }),
    reason: z.string().nullable(),
    statedByUserId: z.string().openapi({ description: "Who stated it (the x-user-id of the call)." }),
    statedAt: z.string(),
    runId: z.string().nullable(),
    active: z.boolean().openapi({ description: "false once undone." }),
    undoneAt: z.string().nullable(),
    undoneByUserId: z.string().nullable(),
  }),
);

const MergeRefusalSchema = z.object({
  type: z.literal("refused"),
  reason: z.enum(["person_not_found", "different_brand", "same_person", "already_one_person", "merge_not_found"]),
  personId: z.string().optional(),
  error: z.string(),
});

registry.registerPath({
  method: "post",
  path: "/orgs/people/merges",
  summary: "Merge two people into one (state they are the same human)",
  description:
    "Merge two people of a brand into ONE person: one merged thread (every channel of both), every identity key and source kept. Use it when two people are the same human but no source record says so (a WhatsApp chat with a number nobody saved, and the same person on Gmail or in the CRM). The statement is recorded with who stated it and when, and every later people rebuild honours it until it is undone (POST /orgs/people/merges/{mergeId}/undo). A rebuild starts at once: the merged person shows on GET /orgs/people within about a minute. The merged person keeps one of the two person ids; the other id still opens it. Idempotent: the same two people stated again answer the existing merge (200, duplicate: true). Refused with a reason: an unknown id (404 person_not_found), an id of another brand (422 different_brand), the same id twice (422 same_person), two ids already naming one person (409 already_one_person). Any two people of a brand, any channels.",
  request: {
    headers: IDENTITY_HEADERS,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            brandId: z.string().uuid(),
            personIds: z.array(z.string().uuid()).length(2).openapi({ description: "The two personId values from GET /orgs/people." }),
            reason: z.string().max(1000).optional().openapi({ description: "Why they are the same human (kept with the statement)." }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Merge stated; rebuild started",
      content: {
        "application/json": {
          schema: z.object({
            merge: PersonMergeSchema,
            duplicate: z.boolean(),
            applied: z.boolean().nullable().openapi({ description: "Whether the people list already shows them as one (false right after stating: the rebuild is running)." }),
            personId: z.string().uuid().nullable().openapi({ description: "The merged person's id once applied." }),
            rebuild: z.enum(["started", "not_needed"]),
          }),
        },
      },
    },
    200: { description: "Already stated (duplicate: true), same body" },
    400: { description: "Invalid body" },
    404: { description: "person_not_found", content: { "application/json": { schema: MergeRefusalSchema } } },
    409: { description: "already_one_person", content: { "application/json": { schema: MergeRefusalSchema } } },
    422: { description: "different_brand | same_person", content: { "application/json": { schema: MergeRefusalSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/merges",
  summary: "List the merges stated on a brand's people",
  description: "Every merge stated on the brand (two people said to be one), newest first, undone ones included, each with `applied` (the latest build shows them as one person) and the merged `personId`.",
  request: { headers: IDENTITY_HEADERS, query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "The brand's merges",
      content: {
        "application/json": {
          schema: z.object({
            brandId: z.string().uuid(),
            merges: z.array(PersonMergeSchema.extend({ applied: z.boolean().nullable(), personId: z.string().uuid().nullable() })),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/people/merges/{mergeId}/undo",
  summary: "Unmerge two people (undo a stated merge)",
  description: "Take a stated merge back: the two people come back apart, each with its own person id, at the rebuild that starts now (unless a source record ties them on its own). The statement stays listed with who undid it and when. Idempotent: undoing twice answers duplicate: true.",
  request: {
    headers: IDENTITY_HEADERS,
    params: z.object({ mergeId: z.string().uuid() }),
    body: { content: { "application/json": { schema: z.object({ brandId: z.string().uuid() }) } } },
  },
  responses: {
    200: {
      description: "Undone",
      content: { "application/json": { schema: z.object({ merge: PersonMergeSchema, duplicate: z.boolean(), rebuild: z.enum(["started", "not_needed"]) }) } },
    },
    404: { description: "merge_not_found", content: { "application/json": { schema: MergeRefusalSchema } } },
  },
});

const SamePersonVerdictSchema = z.object({
  verdictId: z.string().uuid(),
  name: z.string().openapi({ description: "The full name both people carry (folded, lower-cased)." }),
  verdict: z.enum(["same", "different"]).openapi({ description: "same = Jev judged them one human (P >= 0.5): they show as ONE person." }),
  probabilitySame: z.number(),
  keysA: z.array(z.string()).openapi({ description: "Identity keys of the first person when asked (email:, phone:, ...)." }),
  keysB: z.array(z.string()),
  judgedAt: z.string(),
  rejected: z.object({ at: z.string(), byUserId: z.string().nullable(), reason: z.string().nullable() }).nullable(),
});

registry.registerPath({
  method: "get",
  path: "/orgs/people/same-person-verdicts",
  summary: "List the automatic same-person checks of a brand",
  description:
    "Two people of a brand carrying the same full name (a work address and a personal Gmail, a CRM record and a chat) are asked once to Jev: one human or two. `same` ones show as ONE person (merge evidence kind `name_twin`, ref = verdictId, on GET /orgs/people). Newest first, rejected ones included.",
  request: { headers: IDENTITY_HEADERS, query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: { description: "The brand's verdicts", content: { "application/json": { schema: z.object({ brandId: z.string().uuid(), verdicts: z.array(SamePersonVerdictSchema) }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/people/same-person-verdicts/{verdictId}/reject",
  summary: "Not the same person (undo an automatic merge)",
  description:
    "Say two people merged automatically because they share a name are NOT the same human. The verdict is rejected for good (never asked again) and a rebuild starts now: the two come back apart within about a minute. Idempotent: rejecting twice answers duplicate: true.",
  request: {
    headers: IDENTITY_HEADERS,
    params: z.object({ verdictId: z.string().uuid() }),
    body: { content: { "application/json": { schema: z.object({ brandId: z.string().uuid(), reason: z.string().max(1000).optional() }) } } },
  },
  responses: {
    200: {
      description: "Rejected",
      content: { "application/json": { schema: z.object({ verdict: SamePersonVerdictSchema, duplicate: z.boolean(), rebuild: z.enum(["started", "not_needed"]) }) } },
    },
    404: { description: "verdict_not_found" },
  },
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

// ─── The people fact feed (lead-service) ─────────────────────────────────────

export const PeopleFactSchema = registry.register(
  "PeopleFact",
  z.object({
    factId: z.string().uuid().openapi({ description: "Stable, never reused." }),
    seq: z.string().openapi({ description: "feed_seq (bigint as a string): the total order of the feed." }),
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    personKey: z.string().openapi({ description: "crm-service person key AT EMISSION. Not stable: follow person_merged / person_split." }),
    emails: z.array(z.string()).openapi({ description: "Every email of the person at emission (lower-case)." }),
    phones: z.array(z.string()).openapi({ description: "Every international phone of the person at emission (+digits)." }),
    fullName: z.string().nullable(),
    sourceContactId: z.string().nullable().openapi({ description: "The vendor's CONTACT id at that source (GoHighLevel contactId, Stripe customer id, PostHog person id, Matrix handle); null when the source has no contact record (Gmail, CSV, crm)." }),
    crmContactId: z.string().uuid().nullable().openapi({ description: "crm-service's own contact row id for that source at emission (the `id` of /orgs/gohighlevel/contacts, the `contactId` of funnel-events); null when there is no contact row (Gmail, crm meta facts). A disconnect + reconnect mints new row ids; CSV row ids change when a file is re-promoted." }),
    type: z.enum(FACT_TYPES),
    occurredAt: z.string().nullable().openapi({ description: "The vendor's own date; null when it gave none. Never the time we observed it." }),
    dateBasis: z.string().openapi({ description: "Which date occurredAt is (created_at, booked_at, scheduled_start, stage_entered_at, status_changed_at, submitted_at, contact_created_at, sent_at, created, start_date, canceled_at, visit_started_at, person_created_at, uploaded_at; none on crm meta facts)." }),
    source: z.enum(FACT_SOURCES),
    sourceRef: z.string().openapi({ description: "The vendor's own record id (appointment, opportunity, submission, contact, message, charge...)." }),
    payload: z.record(z.string(), z.unknown()).openapi({ description: "Type-specific, see crm-service CLAUDE.md (people fact feed)." }),
    withdrawnOf: z.string().uuid().optional().openapi({ description: "type=withdrawn only: the factId it withdraws." }),
    contactPoint: z.string().nullable().openapi({
      description:
        "PERSON-RELATIONS-1017: the contact point the fact is about (`<source>:<id>`: gmail:<address>, matrix:<handle>, stripe:<customer>, clerk:<user>...), byte-equal to a `relation` fact's contactPoints[].id, so it files under its relation. Null for a CSV row, a registry fact (connection_tag / organization_link / relation) and bookkeeping (withdrawn / person_merged / person_split). Served on old facts too.",
    }),
    humanId: z.string().uuid().nullable().openapi({
      description:
        "The fleet-wide human (human-service) the fact's person was at emission; pair a CRM contact with a lead by it. Null on a fact emitted " +
        "before the person's human was known: once known (or changed by a merge / split in human-service), every live fact of the person is " +
        "re-stated (`withdrawn` reason `human_identified` + the same fact carrying humanId).",
    }),
  }),
);

registry.registerPath({
  method: "get",
  path: "/internal/people/facts",
  summary: "The people fact feed: dated, untagged facts from the client's own accounts",
  description:
    "Every fact after `since` (exclusive) in one total order. Facts are immutable; a correction is a `withdrawn` fact plus a new one. " +
    "A cursor never skips a fact: writers commit seqs in order under one lock and a page is read under it, shared. " +
    "A fact is stated within seconds of crm-service recording its source record (UNIBOX-FACT-LAG-1028). An empty page opens no run. " +
    "Disconnecting a source stops its facts and never withdraws them. Out of the feed: our own outreach (Instantly, self-send).",
  request: {
    query: z.object({
      since: z.string().optional().openapi({ description: "Opaque cursor (nextCursor of the previous page). Absent = from the start." }),
      limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Default 500." }),
      orgId: z.string().uuid().optional(),
      brandId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: {
      description: "One page",
      content: {
        "application/json": {
          schema: z.object({
            facts: z.array(PeopleFactSchema),
            nextCursor: z.string().openapi({ description: "Pass as `since` next time (equals `since` when the page is empty)." }),
            hasMore: z.boolean(),
          }),
        },
      },
    },
    400: { description: "Invalid cursor / limit / ids" },
    502: { description: "Run tracking unavailable" },
  },
});

// ─── Leg reach (the brand's own team, per funnel leg) ───────────────────────

const LegStepSchema = z.enum(LEG_STEPS);

const LegEndSchema = z.object({
  people: z.number().int().openapi({ description: "Distinct people who reached this end (TO: a subset of FROM's people)." }),
  undated: z.number().int().openapi({ description: "Of `people`, those no source dated (not in `byDay`)." }),
  byDay: z
    .array(z.object({ day: z.string().openapi({ example: "2026-09-24" }), people: z.number().int() }))
    .openapi({ description: "Dated people per UTC day they FIRST reached this end, ascending. Sum + `undated` = `people`." }),
  sources: z
    .array(z.object({ source: z.string(), people: z.number().int() }))
    .openapi({ description: "Distinct people per source evidencing this end (overlaps: one person on two sources counts in both)." }),
});

const LegReachReasonSchema = z.object({
  code: z.enum(["no_people_scope", "not_synced", "no_connected_source", "from_step_not_recorded", "to_step_not_recorded"]),
  message: z.string(),
  step: LegStepSchema.optional(),
  recordedBy: z.array(z.string()).optional().openapi({ description: "The sources that would record `step`." }),
});

const LegReachResponseSchema = z.object({
  brandId: z.string().uuid(),
  orgId: z.string().uuid().nullable(),
  fromStep: LegStepSchema,
  toStep: LegStepSchema,
  scope: z.object({ status: z.string(), lastBuiltAt: z.string().nullable() }).nullable(),
  connectedSources: z.array(z.string()),
  stepSources: z.object({ from: z.array(z.string()), to: z.array(z.string()) }).openapi({
    description: "The sources that can record each end (connected or not).",
  }),
  available: z.boolean(),
  reason: LegReachReasonSchema.shape.code.nullable().openapi({ description: "The first of `reasons`; null when available." }),
  reasons: z.array(LegReachReasonSchema),
  reachedFrom: LegEndSchema.optional().openapi({ description: "Present when available." }),
  reachedTo: LegEndSchema.extend({
    toBeforeFrom: z.number().int().openapi({ description: "Population members who reached TO only on a UTC day BEFORE reaching FROM: not counted." }),
    byFromDay: z
      .array(z.object({ day: z.string().openapi({ example: "2026-09-24" }), people: z.number().int() }))
      .openapi({
        description:
          "COHORT view of the same TO people: each filed on the UTC day they FIRST reached FROM (not the day they reached TO), ascending. For any period, its TO cohort is a subset of `reachedFrom.byDay` that period's people. Sum + `undatedFrom` = `people`.",
      }),
    undatedFrom: z.number().int().openapi({ description: "Of `people`, those whose FROM no source dated (not in `byFromDay`)." }),
  })
    .optional()
    .openapi({ description: "Present when available. TO counted on or after the UTC day of first reaching FROM (an undated end counts)." }),
  excluded: z
    .object({ contactedByUs: z.number().int(), automated: z.number().int(), notBusiness: z.number().int(), groupOnly: z.number().int() })
    .optional()
    .openapi({ description: "People who reached FROM but are out of the population, each counted once (first matching reason)." }),
});

registry.registerPath({
  method: "get",
  path: "/internal/people/leg-reach",
  summary: "How the brand's OWN team converts on one funnel leg (FROM -> TO), from its own tools",
  description:
    "Population: the brand's people (one person once across sources) who reached `from` on any source we mirror, MINUS " +
    "those our campaigns contacted (at least one real cold email, or held by lead-service as our lead) and those the people " +
    "layer holds as nobody (automated senders, threads judged not about the business). Of them, how many reached `to` on or " +
    "after the UTC day they first reached `from` (an undated end counts). Steps: lead_found (FROM only: every person the brand " +
    "holds in its tools, any source, dated on their earliest live fact = when they first appeared, else undated), conversation (the person WROTE to the brand " +
    "on Gmail / Matrix and the thread was kept as business), website_visit (PostHog), signup (PostHog, auth providers), " +
    "form_submission (GoHighLevel), meeting_booked, meeting_attended (GoHighLevel), sale (GoHighLevel deal won, Stripe payment " +
    "that stands). Aliases accepted: form_submitted, paid_client. `available: false` + `reason` is distinct from zeros. " +
    "Never opens a people scope, no vendor call, no model, no cost. Org-less: pass `orgId` only if several orgs hold " +
    "answerable people for the brand (409 otherwise).",
  request: {
    query: z.object({
      brandId: z.string().uuid(),
      from: LegStepSchema,
      to: LegStepSchema,
      orgId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: { description: "Counts, or why they are not available", content: { "application/json": { schema: LegReachResponseSchema } } },
    400: { description: "Invalid brandId / orgId / step, or from == to" },
    409: { description: "Several orgs hold answerable people for this brand; pass orgId" },
    502: { description: "Run tracking unavailable" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/people/leg-reach/brands",
  summary: "Every (org, brand) the leg-reach read can be asked about, with the steps each can answer",
  responses: {
    200: {
      description: "All people scopes",
      content: {
        "application/json": {
          schema: z.object({
            steps: z.array(LegStepSchema),
            brands: z.array(
              z.object({
                orgId: z.string().uuid(),
                brandId: z.string().uuid(),
                scopeStatus: z.string(),
                lastBuiltAt: z.string().nullable(),
                connectedSources: z.array(z.string()),
                recordedSteps: z.array(LegStepSchema).openapi({ description: "Steps a leg can start or end on. Empty = nothing answerable." }),
              }),
            ),
          }),
        },
      },
    },
    502: { description: "Run tracking unavailable" },
  },
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
      credentialProvider: z.string().openapi({
        description: "The key-service provider this account's key is stored under: 'stripe' (first account) or 'stripe-<label>'.",
        example: "stripe",
      }),
      account: z
        .object({ id: z.string(), name: z.string().nullable() })
        .nullable()
        .openapi({ description: "The Stripe account the key reads (GET /v1/account). Null when the key may not read it." }),
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

export const AuthConnectionSchema = registry.register(
  "AuthConnection",
  z
    .object({
      id: z.string().uuid(),
      brandId: z.string().uuid(),
      provider: z.string().openapi({ description: "The auth provider: 'clerk'.", example: "clerk" }),
      status: VendorConnectionStatus,
      synced: z.boolean().openapi({ description: "True once a sync has completed." }),
      lastSyncedAt: z.string().nullable(),
      providerUserCount: z.number().int().nullable().openapi({ description: "The provider's own user count at the last pass (reconcile with the people served)." }),
      lastError: z.string().nullable().openapi({ description: "Why the last sync failed, verbatim. Null when healthy." }),
      lastRunId: z.string().nullable(),
      createdAt: z.string(),
    })
    .openapi("AuthConnection"),
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
    extra: { identifiedPersons: z.number().int().openapi({ description: "PostHog's own count of identified persons in the project at connect time: `is_identified` or an email property. Persons named by one of the brand's auth user ids (Clerk) are mirrored on top." }) },
    description:
      "Resolves the brand's PostHog personal API key from key-service (provider `posthog`, brand-scoped, no org fallback; only the `query:read` scope is needed), then PROVES it by counting the project's identified persons through PostHog's query API. The sync mirrors every identified person (is_identified or an email), plus every person carrying one of the brand's auth-provider user ids as a distinct id (a server-side capture keyed on the Clerk user id); a person PostHog holds no email for joins the signed-up user on that shared id. A key PostHog refuses (invalid, missing scope, wrong project or region) comes back 400 with PostHog's own status and message. Read-only: nothing is ever written to PostHog. Requires x-api-key, x-org-id, x-user-id.",
  },
  {
    slug: "stripe",
    label: "Stripe",
    schema: StripeConnectionSchema,
    body: z.object({
      brandId: z.string().uuid(),
      credentialProvider: z.string().regex(/^stripe(-[a-z0-9][a-z0-9_-]{0,47})?$/).optional().openapi({
        description:
          "Which key-service provider holds THIS account's key. Default 'stripe' (the first account). Store each further " +
          "account's key under its own name ('stripe-<label>') and pass it here: a brand connects N accounts.",
        example: "stripe-eu",
      }),
    }),
    extra: {},
    description:
      "A brand connects N Stripe accounts, one connection per key-service provider name (`stripe`, `stripe-<label>`); every Stripe read (payments, customers matched to people) covers all of them. The same account connected twice answers 409 `stripe_account_already_connected`. Resolves the account's Stripe key from key-service (brand-scoped, no org fallback). Only a RESTRICTED key (rk_live_… / rk_test_…) with READ permission on Customers, Charges, Refunds and Subscriptions is accepted: a secret key can move money and is refused before any call. The key is proven by one read of each resource; a missing permission comes back 400 with Stripe's own status and message. Read-only: nothing is ever written to Stripe. Requires x-api-key, x-org-id, x-user-id.",
  },
  {
    slug: "clerk",
    label: "Clerk",
    schema: AuthConnectionSchema,
    body: z.object({ brandId: z.string().uuid() }),
    extra: { userCount: z.number().int().openapi({ description: "Clerk's own count of the instance's users, at connect time." }) },
    description:
      "Connects the brand's AUTH PROVIDER: every person who signed up to the brand's product, past and future. Store the Clerk instance's SECRET key (sk_live_… / sk_test_…) in key-service first (provider `clerk`, brand-scoped, no org fallback); this route PROVES it by counting the users through Clerk's Backend API, writes the connection, and starts the first sync at once (then a cron every 15 minutes). Every user becomes a person (verified emails, phones, name) with a dated `signup` fact (dateBasis `user_created_at`) on the people fact feed; a user deleted in Clerk leaves, and its signup is withdrawn. A key Clerk refuses comes back 400 with Clerk's own status and message. Read-only: nothing is ever written to Clerk; `private_metadata` is never stored. Requires x-api-key, x-org-id, x-user-id.",
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

// ─── WhatsApp send ───────────────────────────────────────────────────────────

export const WhatsappSendRequestSchema = registry.register(
  "WhatsappSendRequest",
  z
    .object({
      brandId: z.string().uuid().optional().openapi({ description: "The brand whose linked WhatsApp sends. Or the x-brand-id header." }),
      email: z.string().optional().openapi({ description: "The person, by email. Their phone is read from the brand's CRM people when `phone` is absent." }),
      phone: z.string().optional().openapi({ description: "The number to write to, international form (+<country><number>). Wins over the CRM's." }),
      text: z.string().min(1).max(4096).optional().openapi({ description: "ONE message. Exactly one of `text` or `messages`." }),
      messages: z
        .array(z.string().min(1).max(4096))
        .min(1)
        .max(5)
        .optional()
        .openapi({
          description:
            "SEVERAL short messages (1 to 5), delivered as separate WhatsApp messages in this order, a few seconds apart with \"typing...\" shown between them (2 to 6 s scaled to length, plus jitter). Every check is decided once before the first; each message is its own send row (listed by GET /orgs/whatsapp/messages). A retry with the same key never re-sends a message already sent and sends the rest. Exactly one of `text` or `messages`. (WA-BUBBLES-1023)",
        }),
      idempotencyKey: z.string().min(1).max(200).openapi({ description: "One per person per step. A retry with the same key answers the first outcome and never sends twice." }),
      fromAccount: z.string().optional().openapi({ description: "Send from this linked account (its own number). Default: when the brand typed accounts `pro_ai` (PATCH /orgs/matrix/links/{linkId} `accountType`), one of them, even when another linked account already talks with the person; else any account. Among the candidates: the one with a conversation (with messages) with the person, latest first, else the brand's outreach default, else the oldest linked. A `personal_human` account never writes. Not with `fromAccountType` / `fromLine`." }),
      fromAccountType: SendingAccountTypeSchema.optional().openapi({
        description:
          "Send only from the brand's accounts of this type, e.g. `pro_human` for a hello from the founder next to the assistant's messages (among several: the one the person last talked with). None of that type = refused `whatsapp_not_linked`. Not with `fromAccount` / `fromLine`. (ACCOUNT-TYPES-1028)",
      }),
      fromLine: WhatsappLineRoleSchema.optional().openapi({
        description: "Older word for `fromAccountType`: `founder` = pro_human, `assistant` = pro_ai. (SOPHIE-SENDS-1028)",
      }),
      skipIfReplied: z.boolean().optional().openapi({ description: "Refuse with `person_replied` when the person has written to the brand on any channel (use on follow-ups)." }),
    })
    .refine((b) => (b.text === undefined) !== (b.messages === undefined), { message: "exactly one of `text` or `messages` is required" })
    .refine((b) => [b.fromAccount, b.fromAccountType, b.fromLine].filter(Boolean).length <= 1, {
      message: "`fromAccount`, `fromAccountType` and `fromLine` are exclusive",
    })
    .openapi("WhatsappSendRequest"),
);

export const WhatsappSendResponseSchema = registry.register(
  "WhatsappSendResponse",
  z
    .object({
      sendId: z.string().uuid(),
      status: z.literal("sent"),
      duplicate: z.boolean().openapi({ description: "True when this idempotency key had already sent: nothing was sent again." }),
      to: z.string(),
      phoneSource: z.string().openapi({ description: "`request`, or `crm:<source>` (the person's record holding the phone)." }),
      fromAccount: z.string(),
      persona: SenderPersonaSchema,
      roomId: z.string(),
      eventId: z.string(),
      sentAt: z.string(),
      previousSends: z.number().int().openapi({ description: "WhatsApp messages sent to this number through this route before this one." }),
      messages: z
        .array(
          z.object({
            index: z.number().int().openapi({ description: "0-based position in the request's `messages`." }),
            sendId: z.string().uuid(),
            eventId: z.string(),
            sentAt: z.string(),
            duplicate: z.boolean().openapi({ description: "Already sent under this key by an earlier call: not sent again." }),
          }),
        )
        .optional()
        .openapi({
          description:
            "Only when the request carried `messages`: every message, in order, all sent. The top-level `sendId`/`eventId`/`sentAt` are the first message's; top-level `duplicate` is true only when every message had already been sent.",
        }),
    })
    .openapi("WhatsappSendResponse"),
);

const WhatsappRefusalSchema = z.object({
  type: z.literal("refused"),
  code: z.enum([
    "whatsapp_not_linked",
    "whatsapp_not_connected",
    "automation_not_allowed",
    "no_phone_known",
    "not_on_whatsapp",
    "person_replied",
    "human_in_conversation",
    "send_in_progress",
    "wrong_room",
  ]).openapi({
    description:
      "`human_in_conversation`: someone of the brand typed a message by hand to this person on WhatsApp (any linked account); the conversation is theirs and automation never writes into it. Brand-side, not the number's fault.",
  }),
  error: z.string(),
});

registry.registerPath({
  method: "post",
  path: "/orgs/whatsapp/messages",
  summary: "Send one WhatsApp message (or several paced ones) from the brand's linked WhatsApp account",
  description:
    "Writes `text` to the person on WhatsApp from the brand's linked account. The message comes back through the mirror as outbound in the person's merged thread. Refusals are 422 with a stable `code` (409 `send_in_progress` for a key in flight). No cost declared. Requires x-api-key, x-org-id; brand from body or x-brand-id; x-campaign-id recorded when sent.",
  request: { body: { content: { "application/json": { schema: WhatsappSendRequestSchema } }, required: true } },
  responses: {
    200: { description: "Sent (or already sent under this key)", content: { "application/json": { schema: WhatsappSendResponseSchema } } },
    400: { description: "Bad request (`code: invalid_request`)", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "`send_in_progress`", content: { "application/json": { schema: WhatsappRefusalSchema } } },
    422: { description: "Refused, with a stable `code`", content: { "application/json": { schema: WhatsappRefusalSchema } } },
    502: { description: "The WhatsApp bridge or run tracking failed (`code: bridge_error`)", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const WhatsappReachRequestSchema = registry.register(
  "WhatsappReachRequest",
  z
    .object({
      brandId: z.string().uuid().optional().openapi({ description: "The brand whose linked WhatsApp would send. Or the x-brand-id header." }),
      email: z.string().optional().openapi({ description: "The person, by email, exactly as the send names them. Their phone is read from the brand's CRM people when `phone` is absent." }),
      phone: z.string().optional().openapi({ description: "The number the send would write to, international form (+<country><number>). Wins over the CRM's." }),
      fromAccount: z.string().optional().openapi({ description: "As on the send: only this linked account (its own number) may write." }),
      fromAccountType: SendingAccountTypeSchema.optional().openapi({ description: "As on the send: only the brand's accounts of this type (`pro_ai` | `pro_human`) may write." }),
      fromLine: WhatsappLineRoleSchema.optional().openapi({ description: "Older word for `fromAccountType` (`assistant` = pro_ai, `founder` = pro_human)." }),
      skipIfReplied: z.boolean().optional().openapi({ description: "As on the send: answer `person_replied` when the person has written to the brand on any channel." }),
    })
    .refine((b) => [b.fromAccount, b.fromAccountType, b.fromLine].filter(Boolean).length <= 1, {
      message: "`fromAccount`, `fromAccountType` and `fromLine` are exclusive",
    })
    .openapi("WhatsappReachRequest"),
);

export const WhatsappReachResponseSchema = registry.register(
  "WhatsappReachResponse",
  z
    .union([
      z.object({
        reachable: z.literal(true),
        to: z.string().openapi({ description: "The number the send would write to (E.164)." }),
        phoneSource: z.string().openapi({ description: "`request`, or `crm:<source>` (the person's record holding the phone)." }),
        fromAccount: z.string().openapi({ description: "The linked account the send would write from right now (its own number). Only accounts allowing automated sends are considered." }),
        persona: SenderPersonaSchema,
        assistantLine: z
          .object({
            phone: z.string().openapi({ description: "That pro_ai account's own number, E.164." }),
            persona: SenderPersonaSchema,
          })
          .nullable()
          .openapi({
            description:
              "The brand's `pro_ai` account an automated send to this person writes from (among several, the one they last talked with), whichever account THIS send writes from, so a pro_human hello can name it (\"our assistant contacted you from <phone>\"). Null when the brand typed no account pro_ai. (ACCOUNT-TYPES-1028)",
          }),
      }),
      z.object({
        reachable: z.literal(false),
        code: z.enum(["whatsapp_not_linked", "whatsapp_not_connected", "automation_not_allowed", "no_phone_known", "not_on_whatsapp", "person_replied", "human_in_conversation"]).openapi({
          description: "The refusal code POST /orgs/whatsapp/messages would answer for this person now.",
        }),
        error: z.string(),
      }),
    ])
    .openapi("WhatsappReachResponse"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/whatsapp/reach",
  summary: "Can the brand's WhatsApp reach this person right now? (checks only, sends nothing)",
  description:
    "Runs the reachability checks of POST /orgs/whatsapp/messages in the same order, WITHOUT sending: the person's phone (`no_phone_known`), `skipIfReplied` (`person_replied`), the brand's linked and connected accounts (`whatsapp_not_linked`, `whatsapp_not_connected`), then one WhatsApp bridge lookup of the number (`not_on_whatsapp`, a number that cannot exist included). Ask it before paying a model to write the message: `reachable: true` means the send will not refuse for any of these reasons (a later transient bridge failure, or a `wrong_room` repair, can still happen). No message, no send row, no room opened, no cost. Requires x-api-key, x-org-id; brand from body or x-brand-id.",
  request: { body: { content: { "application/json": { schema: WhatsappReachRequestSchema } }, required: true } },
  responses: {
    200: { description: "The answer: reachable, or not with the send's refusal code", content: { "application/json": { schema: WhatsappReachResponseSchema } } },
    400: { description: "Bad request (`code: invalid_request`)", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "The WhatsApp bridge failed on a valid number, or run tracking failed (`code: bridge_error`)", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const TeamMembershipRequestSchema = registry.register(
  "TeamMembershipRequest",
  z
    .object({
      brandId: z.string().uuid().optional().openapi({ description: "The brand whose own team is asked about. Else the x-brand-id header." }),
      email: z.string().optional().openapi({ description: "The person's email." }),
      phone: z.string().optional().openapi({ description: "The person's phone, international form (+<country><number>)." }),
    })
    .openapi("TeamMembershipRequest"),
);

export const TeamMembershipResponseSchema = registry.register(
  "TeamMembershipResponse",
  z
    .object({
      staff: z.boolean().openapi({ description: "One of distribute.you's staff (by email)." }),
      ownTeam: z.boolean().openapi({ description: "One of the brand's own team: a linked WhatsApp account, the sales rep phone, or a member of the org (by phone or email)." }),
      matches: z
        .array(
          z.object({
            kind: z.enum(["staff", "linked_whatsapp_account", "sales_rep_phone", "org_member"]),
            via: z.string().openapi({ description: "The address or number (E.164) that matched." }),
            description: z.string().openapi({ description: "The kind in plain words, for a log." }),
          }),
        )
        .openapi({ description: "Every way the person matched; empty = neither." }),
    })
    .openapi("TeamMembershipResponse"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/people/team-membership",
  summary: "Is this person our staff, or one of the brand's own team? (a fact, no refusal)",
  description:
    "A read for a pipe's strategy (WA-GIVEN-PURE-FACT-1017): the triggers report every person; who to skip is the pipe's call. Staff = a distribute.you staff address. Own team = one of the brand's linked WhatsApp numbers, its sales rep phone (brand-service), or any member of the org, by phone or address (client-service). No side effect, no cost. 502 `team_unreadable` when the sales rep or the org's members cannot be read: never answered as \"not own team\". Requires x-api-key, x-org-id, x-user-id; brand from body or x-brand-id.",
  request: { body: { content: { "application/json": { schema: TeamMembershipRequestSchema } }, required: true } },
  responses: {
    200: { description: "The facts", content: { "application/json": { schema: TeamMembershipResponseSchema } } },
    400: { description: "Bad request (`code: invalid_request`)", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Sales rep or org members unreadable (`code: team_unreadable`), or run tracking failed", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const WhatsappSendsQueryRequestSchema = registry.register(
  "WhatsappSendsQueryRequest",
  z
    .object({
      brandId: z.string().uuid().openapi({ description: "The brand whose linked WhatsApp sent." }),
      campaignId: z.string().min(1).openapi({ description: "Only sends recorded under this campaign (the x-campaign-id the send carried)." }),
      emails: z.array(z.string()).min(1).max(500).openapi({ description: "The people, by email (matched case-folded). 1 to 500." }),
    })
    .openapi("WhatsappSendsQueryRequest"),
);

export const WhatsappSendsQueryResponseSchema = registry.register(
  "WhatsappSendsQueryResponse",
  z
    .object({
      sends: z
        .array(
          z.object({
            email: z.string().openapi({ description: "The person's email, lower-cased." }),
            sendId: z.string().uuid(),
            status: z.enum(["sending", "sent", "refused", "failed"]).openapi({ description: "`sent` = delivered to WhatsApp. `sending` = in flight. `refused` / `failed` = nothing reached the person." }),
            code: z.string().nullable().openapi({ description: "Refusal code (`no_phone_known`, `not_on_whatsapp`, …) or failure text; null when sent." }),
            campaignId: z.string(),
            sentAt: z.string().nullable(),
            createdAt: z.string(),
          }),
        )
        .openapi({ description: "Every send of this brand + campaign to a listed person, any status, newest first. A person with none is absent." }),
      invalidEmails: z.array(z.string()).openapi({ description: "Entries of `emails` that are not an email, as given. Never matched." }),
    })
    .openapi("WhatsappSendsQueryResponse"),
);

registry.registerPath({
  method: "post",
  path: "/orgs/whatsapp/sends/query",
  summary: "One campaign's WhatsApp sends to a list of people, in one call",
  description:
    "Which of these people this campaign has a WhatsApp send for, with each send's status and time. Read-only, no cost. Requires x-api-key, x-org-id (rows are scoped to that org); other identity headers forwarded as usual. One run per call.",
  request: { body: { content: { "application/json": { schema: WhatsappSendsQueryRequestSchema } }, required: true } },
  responses: {
    200: { description: "Sends", content: { "application/json": { schema: WhatsappSendsQueryResponseSchema } } },
    400: { description: "Bad request (`code: invalid_request`)", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Run tracking failed", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/whatsapp/messages",
  summary: "WhatsApp messages sent to one person through this route, newest first",
  request: {
    query: z.object({ brandId: z.string().uuid(), email: z.string().optional(), phone: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Sends",
      content: {
        "application/json": {
          schema: z.object({
            sends: z.array(
              z.object({
                sendId: z.string().uuid(),
                status: z.enum(["sending", "sent", "refused", "failed"]),
                code: z.string().nullable(),
                error: z.string().nullable(),
                email: z.string().nullable(),
                to: z.string().nullable(),
                phoneSource: z.string().nullable(),
                fromAccount: z.string().nullable(),
                text: z.string(),
                campaignId: z.string().nullable(),
                eventId: z.string().nullable(),
                sentAt: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
  },
});

// ─── Form trigger (lib/form-trigger/): each new CRM form submission → `form_submitted` ───

const FormTriggerReportSchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  submissionId: z.string(),
  formId: z.string().nullable(),
  formName: z.string().nullable(),
  person: z.object({
    fullName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    sourceContactId: z.string().nullable(),
    crmContactId: z.string().nullable(),
  }),
  answers: z.array(z.object({ key: z.string(), label: z.string().nullable(), value: z.unknown() })),
  status: z.enum(["pending", "reported", "skipped", "failed"]),
  reason: z.string().nullable().describe("calendar_booking_form | no_email_or_phone (neither an email nor an E.164 phone; older rows no_email) | offer_unknown | campaign_refused | campaign_unreachable | connection_gone"),
  lastError: z.string().nullable(),
  attempts: z.number().int(),
  offerId: z.string().nullable(),
  submittedAt: z.string(),
  detectedAt: z.string(),
  reportedAt: z.string().nullable(),
  campaignEventId: z.string().nullable(),
  campaignRecordedAt: z.string().nullable(),
  campaignOutcome: z.unknown(),
}).openapi("FormTriggerReport");

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/form-triggers",
  summary: "The brand's new CRM form submissions and their `form_submitted` reports to campaign-service",
  description:
    "A watch asks each connected CRM every 60s for its recent submissions. Each one made after the watch first saw " +
    "the connection is reported ONCE to campaign-service (`POST /internal/trigger-events`, trigger `form_submitted`) " +
    "naming the person and their answers. A calendar's own booking form is recorded `skipped / calendar_booking_form`. " +
    "Newest first.",
  request: { query: z.object({ brandId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).optional() }) },
  responses: {
    200: { description: "Reports", content: { "application/json": { schema: z.object({ reports: z.array(FormTriggerReportSchema) }) } } },
  },
});

export const PhoneTriggerReportSchema = z.object({
  id: z.string().uuid(),
  phone: z.string().describe("E.164. Reported at most once per (brand, number)."),
  source: z.string().describe("The connector that stated the number first: `posthog`, `clerk`, `gohighlevel`, `stripe`, `csv`, `matrix`..."),
  person: z.object({
    fullName: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    contactId: z.string().uuid().nullable(),
    sourceContactId: z.string().nullable(),
  }),
  status: z.string().describe("`pending` | `reported` | `skipped` | `failed`."),
  reason: z
    .string()
    .nullable()
    .describe(
      "Skipped: `before_watch` (known before the watch first looked at its source, history) | `conversation_channel` (learned " +
        "from a chat the person opened) | `staff` | `own_team`. Failed: `offer_unknown` | `campaign_unreachable` | `campaign_refused`.",
    ),
  lastError: z.string().nullable(),
  attempts: z.number().int(),
  offerId: z.string().uuid().nullable(),
  detectedAt: z.string(),
  reportedAt: z.string().nullable(),
  campaignEventId: z.string().nullable(),
  campaignRecordedAt: z.string().nullable(),
  campaignOutcome: z.unknown(),
}).openapi("PhoneTriggerReport");

registry.registerPath({
  method: "get",
  path: "/orgs/phone-triggers",
  summary: "Every phone number the brand learned and its `whatsapp_number_given` report to campaign-service",
  description:
    "WA-GIVEN-TRIGGER-1015. A watch looks every 60s at what the brand's connectors state (PostHog person properties and " +
    "auth-provider profiles are read live, every other connector at its own sync). A number a person of the brand holds " +
    "for the first time is reported ONCE to campaign-service (`POST /internal/trigger-events`, trigger `whatsapp_number_given`) " +
    "naming the person by the number (and email when held). Numbers known before the watch first looked at their source are " +
    "history (`before_watch`), listed only with `includeHistory=true`. Newest first.",
  request: {
    query: z.object({
      brandId: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      includeHistory: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: { description: "Reports", content: { "application/json": { schema: z.object({ reports: z.array(PhoneTriggerReportSchema) }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/phone-triggers/watch",
  summary: "Run one phone-watch pass now (the loop runs every 60s)",
  responses: { 200: { description: "What the pass mirrored, baselined, detected and reported" }, 502: { description: "The pass failed" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/phone-triggers/reports/redeliver",
  summary: "OWNER DOOR: deliver these unsent phone-given reports now, past the 24 h retry window",
  description:
    "WA-GREETING-OFFER-1027. Only a report not sent yet (failed / pending, never a final campaign refusal) is acted on; the " +
    "same rules as the loop apply (an impossible number is skipped, the offer resolved as usual, the same idempotency key).",
  request: { body: { content: { "application/json": { schema: z.object({ reportIds: z.array(z.string().uuid()).min(1).max(200), replayCampaignOff: z.boolean().optional().describe("Also re-send, as a NEW occurrence keyed on the first event, a report campaign-service answered skipped / campaign_off (its campaign was Off)") }) } } } },
  responses: { 200: { description: "`{acted: [{reportId, status, reason}], refused: [{reportId, error}]}`" }, 400: { description: "Invalid body" }, 502: { description: "campaign-service not configured" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/phone-triggers/reports/withhold",
  summary: "OWNER DOOR: never send these unsent phone-given reports (skipped / withheld)",
  request: { body: { content: { "application/json": { schema: z.object({ reportIds: z.array(z.string().uuid()).min(1).max(200), note: z.string().min(1).max(500) }) } } } },
  responses: { 200: { description: "`{acted, refused}`" }, 400: { description: "Invalid body" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/reply-triggers/reports/withhold",
  summary: "OWNER DOOR: never send these unsent reply reports (skipped / withheld)",
  request: { body: { content: { "application/json": { schema: z.object({ reportIds: z.array(z.string().uuid()).min(1).max(200), note: z.string().min(1).max(500) }) } } } },
  responses: { 200: { description: "`{acted, refused}`" }, 400: { description: "Invalid body" } },
});

registry.registerPath({
  method: "get",
  path: "/internal/ops/trigger-reports",
  summary: "Trigger reports stuck unsent, per trigger, + a daily series (dashboard v2 Monitoring)",
  description:
    "WA-GREETING-OFFER-1027. Every occurrence crm-service reports to campaign-service's trigger door (form_submitted, " +
    "whatsapp_number_given, positive_reply_received, account_event) is a dated row. A row not sent (failed, pending, handing " +
    "off) older than 15 min is STUCK: `status: red`, with its reason and last error. `byDay` = per UTC day of detection: sent, " +
    "skipped by rule, not sent, handed off. A Gmail reply the email path (instantly-service) acts on is SENT as `handed_off`, " +
    "listed in `handOffs` with the email path's answer; a LEGACY `skipped / cold_email_path` row (decided on the recipient alone, " +
    "no answer, before EMAIL-REPLY-ORPHAN-1027) is a dropped reply: stuck, red, at any age, until re-checked. " +
    "Nothing is emailed: red on the Monitoring hub is the alert. Staff-only behind the gateway.",
  request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).optional().describe("Window in days, default 30") }) },
  responses: { 200: { description: "`{generatedAt, days, stuckAfterMinutes, status, triggers: [{trigger, table, status, stuck, stuckByReason, stuckReports: [{reportId, orgId, brandId, brandName, person: {name, email, phone}, status, reason, lastError, attempts, detectedAt}], byDay: [{day, sent, skipped, notSent, handedOff}], handOffs: [{reportId, brandId, person, detectedAt, to, answer}]}]}`" }, 400: { description: "Invalid days" } },
});

registry.registerPath({
  method: "get",
  path: "/internal/ops/connector-intake",
  summary: "Per mirror connection: records the vendor dated per day, red when it fails, is late or went unusually quiet (dashboard v2 Monitoring)",
  description:
    "GHL-MIRROR-FROZEN-1028. Every mirror connection (GoHighLevel, PostHog, Stripe, auth provider such as Clerk), read from bronze: " +
    "`byDay` = records whose VENDOR creation date (GoHighLevel contact / deal / appointment / form submission, PostHog visit / event / " +
    "person, Stripe charge / refund / customer, auth user / membership) falls on each UTC day of the window, zero-filled. `status: red` " +
    "with `reasons` when: `sync_error` (the sync fails), `sync_late` (no good sync for 2 h), `quiet_unusual` (nothing new for longer " +
    "than the connection's own longest quiet stretch over the 180 days before, at least 3 days, only with 20+ active days of history). " +
    "A sync that succeeds while the account takes in nothing is therefore red, never healthy. Paused = `paused`, never red. " +
    "Nothing is emailed: red on the Monitoring hub is the alert. Staff-only behind the gateway.",
  request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).optional().describe("Window in days, default 30") }) },
  responses: { 200: { description: "`{generatedAt, days, rule: {historyDays, minActiveDays, minQuietDays, syncLateAfterMinutes}, status, connections: [{source, connectionId, orgId, brandId, brandName, account, syncStatus, lastSyncedAt, lastError, status: ok|red|paused, reasons: [{code, text}], newestRecordDay, quietDays, usualLongestQuietDays, activeDaysInHistory, byDay: [{day, records}]}]}`" }, 400: { description: "Invalid days" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/reply-triggers/gmail/recheck-cold-email-skips",
  summary: "OWNER DOOR: re-check legacy Gmail replies skipped as the email path's on the recipient alone",
  description:
    "EMAIL-REPLY-ORPHAN-1027. Each `skipped / cold_email_path` Gmail report with no email-path answer is decided again by the " +
    "detection rules: the email path (instantly-service `POST /orgs/reply-ownership`) acts on it = `handed_off` with its answer; " +
    "else own team / owning brand / automated / Jev, a positive burst delivered at once to campaign-service's trigger door; the " +
    "brand answered since = `answered_since`. `dryRun` (default true) asks the email path and reads the thread only (no Jev, no " +
    "write). A real run needs `reportIds` (the owner's pick: leads only).",
  request: { body: { content: { "application/json": { schema: z.object({ reportIds: z.array(z.string().uuid()).min(1).max(200).optional(), dryRun: z.boolean().optional() }) } } } },
  responses: { 200: { description: "`{dryRun, rows: [{reportId, address, firstMessageAt, outcome, status, reason, emailPath, error, delivery}]}`" }, 400: { description: "Invalid body, or a real run without reportIds" } },
});

registry.registerPath({
  method: "get",
  path: "/orgs/calendar/meetings",
  summary: "Meetings in the org's connected Google Calendar, who each attendee is among the brand's people, and the facts stated",
  description:
    "GOOGLE-CALENDAR-MEETING-FACTS-1021. google-service mirrors the org's connected Google Calendar; crm-service reads its " +
    "changes feed every 5 min. An attendee whose address a person of the brand holds IS that person; any other attendee is " +
    "judged by Jev against the brand's people (name, meeting title, domain), once. A matched attendee's meeting is a " +
    "`meeting_booked` fact (dated on the booking), `meeting_attended` only when Jev judged a Google Meet participant to be " +
    "that person, `meeting_not_held` when cancelled (a cancel then rebook by the same person is one booking). The org's " +
    "own team and declined attendees are nobody.",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Meetings",
      content: {
        "application/json": {
          schema: z.object({
            meetings: z.array(
              z.object({
                googleEventId: z.string(),
                calendarEmail: z.string(),
                status: z.string(),
                title: z.string().nullable(),
                startAt: z.string().nullable(),
                bookedAt: z.string().nullable(),
                meetStatus: z.string(),
                attendees: z.array(
                  z.object({
                    email: z.string(),
                    displayName: z.string().nullable(),
                    registered: z.boolean().describe("The attendee entered the brand's registry (false = the org's own team, or not judged yet)."),
                    person: z
                      .object({ personId: z.string(), displayName: z.string().nullable(), basis: z.enum(["same_address", "jev"]), confidence: z.number().nullable() })
                      .nullable(),
                  }),
                ),
                facts: z.array(z.object({ type: z.string(), attendeeEmail: z.string().nullable(), occurredAt: z.string().nullable(), dateBasis: z.string() })),
              }),
            ),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/outcomes/lead-identified",
  summary: "Declare the leads the registry identified as lead_identified (COST-ACCOUNTING-1024)",
  description:
    "One pass of the in-process loop (every 5 min): every crm relation (human x company) tagged professional_to_brand by a judged conversation, never recorded, is recorded (first conversation of a relation = pending, others = duplicate_subject), then every pending one is declared at runs-service as `lead_identified` produced (subject crm-service, the relation key) on the run whose Jev call judged it, with occurredAt = the judgment time. The same path covers the past and the future. Idempotent.",
  responses: { 200: { description: "recorded, duplicates, due, declared, alreadyRecorded, refused, failed" }, 502: { description: "The pass failed" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/outcomes/message-sent",
  summary: "Declare every WhatsApp message a campaign sent as message_sent on its send run (LEDGER-HISTORY-1024)",
  description:
    "One pass of the in-process loop (every minute): every WhatsApp send that went out carrying the campaign that sent it, never recorded, is recorded (one per send run: bubbles of one send are one message), its lead named by lead-service, then declared at runs-service as `message_sent` produced (subject lead-service, the lead id) on the send run, with occurredAt = the send time. The same path covers the past and the future. Not a lead yet = retried, no_lead after 7 days. Idempotent.",
  responses: { 200: { description: "recorded, due, declared, alreadyRecorded, waiting, noLead, refused, failed" }, 502: { description: "The pass failed" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/outcomes/form-submitted",
  summary: "Declare every CRM form submission crm-service holds as form_submitted on its lead (CRM-FORM-SUBMITTED-LEDGER-1025)",
  description:
    "One pass of the in-process loop (every 5 min): every dated CRM form submission (GoHighLevel), never recorded, is recorded; a calendar's own booking form is skipped (it is the booking); each other one's lead is named by lead-service from the identity the submission carries (else its mirrored contact's), a spend-free run of its own is opened once (`gohighlevel.form-submitted`), and runs-service records `form_submitted` produced (subject lead-service, the lead id) on it with occurredAt = the submission time. The same path covers the past and the future. Not a lead (yet) = asked again (backoff to 1 h), never guessed. Idempotent: a replay names the same run (already_recorded).",
  responses: { 200: { description: "recorded, due, declared, alreadyRecorded, waiting, skipped, refused, failed" }, 502: { description: "The pass failed" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/outcomes/support-marks",
  summary: "Mark crm-service's own past runs support, naming the function (LEDGER-HISTORY-1024)",
  description:
    "Passes `{kind, reason, markedBy?}` + `runIds (<= 5000)` OR a selection over crm-service's own runs (`taskNames`, `topLevelOnly?`, `withSpendOnly?`, `startedAfter?`, `startedBefore?`, `offOutcomeOnly?`, `offAncestorMarkOnly?`) to runs-service's owner door (`dryRun: true` = its preview): spend that produces no outcome by design (the Unibox thread reading, the brand's CRM vocabulary, column typing, calendar matching = product_feature; the Copilot's voice notes = copilot; another session's probe parented on a crm run = staff_experiment; the mailbox re-reads of the freshness watch, a people build's message index step and a top-level Unibox thread read = product_feature, LEDGER-RESIDUAL-1025; registry judgments made before the org's first declared lead_identified, whose verdict was re-judged since so the lead they identified is unrecorded = unattributed_production, LEDGER-CRM-UNDECLARED-1027). New runs are marked at creation. Idempotent; a run that declared an outcome is never marked.",
  responses: { 200: { description: "runs-service's selection answer" }, 400: { description: "Invalid body" }, 422: { description: "runs-service refused (its words)" }, 502: { description: "runs-service unreachable" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/outcomes/backfill",
  summary: "Declare the past positive replies on the runs that judged them (COST-BACKFILL-1023-CRM)",
  description:
    "Every reply burst Jev judged positive before the forward declaration shipped is matched to the detection run that judged it (runs-service, the org's crm-service run of a judging task that spent, started within seconds of the burst's detection; none or several = `unmatched`, never declared) and handed to the outcome declaration loop with runs-service `occurredAt: run_started_at`. Body `{dryRun?: boolean}`: dry run writes nothing. Idempotent: a re-run finds 0 candidates; runs-service answers a replayed declaration `already_recorded`.",
  responses: { 200: { description: "Candidates, matched, unmatched (by reason) and each row's judge run" }, 502: { description: "runs-service unreadable (rows already handled stay handled)" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/calendar/watch",
  summary: "Run one calendar pass now: mirror google-service's calendar feed, judge attendees and Meet attendance (the loop runs every 5 min)",
  responses: { 200: { description: "What the pass mirrored and judged per scope" }, 502: { description: "The pass failed" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/credit-events/watch",
  summary:
    "Read billing-service's credit events now (the loop runs every minute): \"Credit ran out\" / \"Credit restored\" on the staff Unibox " +
    "thread of each member of the client org (source `billing`), a fact on the people feed, and a Lead event (`account_event`) for new ones",
  responses: {
    200: { description: "`{feed: {pages, read, stored, caughtUp}, people: {resolved, failed, reports}, delivered}`, or `{skipped}`" },
    502: { description: "The feed could not be read" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/credit-events",
  summary: "The mirrored credit events (newest first, `limit` <= 1000): the people each is about and their Lead event report",
  responses: { 200: { description: "`{events: [{eventId, type, accountOrgId, accountName, episodeId, at, memberEmails, reports}]}`" } },
});

registry.registerPath({
  method: "post",
  path: "/internal/transactional-emails/watch",
  summary:
    "Read transactional-email-service's sent-emails feed now (the loop runs every minute): every email the platform sent a client, " +
    "shown on that person's staff Unibox thread (source `transactional`, outbound, subject + body at send time)",
  responses: {
    200: { description: "`{pages, read, stored, caughtUp, cursor}` (stored = new emails), or `{skipped: \"pass_running\"}`" },
    502: { description: "The feed could not be read" },
  },
});

export const ReplyTriggerReportSchema = z.object({
  id: z.string().uuid(),
  source: z.string().describe("`matrix` (WhatsApp, LinkedIn) | `gmail` (the org's connected mailbox)."),
  channel: z.string(),
  address: z.string().nullable().describe("gmail: the person's address (the conversation). matrix: null."),
  campaignId: z.string().nullable().describe("The last campaign that wrote in the thread before the burst; null = none did."),
  offerId: z.string().uuid().nullable(),
  offerBasis: z.string().nullable().describe("What decided the offer: `campaign` | `conversation` (Jev's offer tag) | `only_offer`."),
  conversationId: z.string().uuid().nullable(),
  person: z.object({ personId: z.string().uuid().nullable(), fullName: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  messages: z.array(z.object({
    eventId: z.string().optional().describe("matrix: the Matrix event id."),
    messageId: z.string().optional().describe("gmail: the Gmail message id."),
    at: z.string(),
    subject: z.string().nullable().optional(),
    text: z.string(),
  })),
  firstMessageAt: z.string(),
  lastMessageAt: z.string(),
  judgment: z.unknown(),
  status: z.enum(["pending", "reported", "skipped", "failed"]),
  reason: z.string().nullable().describe(
    "`own_address` (gmail: the brand's own address, its connected mailbox included: our own mail) | `not_addressed_to_brand` (gmail: no mail of the burst names the brand in To) | `own_team` (old rows only) | `automated_reply` | `not_positive` (Jev: a person wrote, no positive answer) | `before_watch` | `no_email_or_phone` (neither an email nor an E.164 phone; older rows `no_email`) | `cold_email_path` (gmail: status `handed_off` = the email path (instantly-service) said it acts on it, its answer stored; status `skipped` = a legacy skip decided on the recipient alone, red on Monitoring until re-checked) | `answered_since` / `other_brand` (re-check only) | `person_not_built` | `offer_unknown` | `campaign_refused` | `campaign_unreachable`",
  ),
  lastError: z.string().nullable(),
  attempts: z.number().int(),
  detectedAt: z.string(),
  reportedAt: z.string().nullable(),
  campaignEventId: z.string().nullable(),
  campaignOutcome: z.unknown(),
}).openapi("ReplyTriggerReport");

registry.registerPath({
  method: "get",
  path: "/orgs/matrix/reply-triggers",
  summary: "Messages people wrote to the brand on a personal channel or its connected Gmail, and their `positive_reply_received` reports",
  description:
    "Every one-to-one thread is read as it is mirrored (the live watch, every ~10 s; the 5-min pass heals), whoever " +
    "opened it. The person's words since our last message (a send or a message typed by hand on the account) are ONE " +
    "burst, reported ONCE to campaign-service (`POST /internal/trigger-events`, trigger `positive_reply_received`), naming " +
    "the person by email, for an offer (`offerBasis`). Who is answered is the answering pipe's strategy there. An " +
    "auto-reply is not an answer (`automated_reply`, Jev), and only a POSITIVE answer is reported (interested, asks for info, asks for a meeting; else `not_positive`, Jev); a team member is reported like anyone (the answering pipe decides). Gmail " +
    "(`source: gmail`): every mail a person sends TO the org's connected mailbox, same rules (our own addresses never a person: `own_address`), under the brand(s) whose " +
    "people know the person; a reply the email path says it acts on is its (`handed_off / cold_email_path`). Newest first.",
  request: { query: z.object({ brandId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).optional() }) },
  responses: {
    200: { description: "Reports", content: { "application/json": { schema: z.object({ reports: z.array(ReplyTriggerReportSchema) }) } } },
  },
});

const FormOfferSchema = z.object({ formId: z.string(), offerId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/orgs/gohighlevel/form-offers",
  summary: "Which offer each of the brand's CRM forms is about (stated)",
  description:
    "A form submission is reported for the offer stated for its form, else the one stated for every form " +
    "(`formId: \"*\"`), else the brand's ONLY active offer. A brand with several offers and no statement is reported " +
    "nowhere (`offer_unknown`).",
  request: { query: z.object({ brandId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Stated offers",
      content: { "application/json": { schema: z.object({ formOffers: z.array(FormOfferSchema.extend({ statedByUserId: z.string(), updatedAt: z.string() })) }) } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/orgs/gohighlevel/form-offers",
  summary: "State which offer a CRM form (or every form of the brand) is about",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            brandId: z.string().uuid(),
            formId: z.string().optional().describe("The CRM form id; omitted = every form of the brand"),
            offerId: z.string().uuid(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Stated", content: { "application/json": { schema: z.object({ formOffer: FormOfferSchema }) } } },
    422: { description: "`offer_not_of_brand`" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/orgs/gohighlevel/form-offers",
  summary: "Withdraw a stated form offer",
  request: { query: z.object({ brandId: z.string().uuid(), formId: z.string().optional() }) },
  responses: { 200: { description: "Withdrawn", content: { "application/json": { schema: z.object({ deleted: z.number().int() }) } } } },
});

registry.registerPath({
  method: "post",
  path: "/internal/form-triggers/watch",
  summary: "Run one form-trigger watch pass now (the loop runs every 60s)",
  responses: { 200: { description: "What the pass saw and reported" }, 502: { description: "The pass failed" } },
});

// ─── POST /internal/people/relations/latest-messages (UNIBOX-LAST-MESSAGE-PREVIEW-1021) ──

export const LatestMessagesRequestSchema = z
  .object({
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    relationKeys: z
      .array(z.string().min(3).max(200))
      .min(1)
      .max(LATEST_MESSAGES_MAX_RELATIONS)
      .openapi({ description: `The relations (\`rel:<personId>:...\`, as served on the \`relation\` fact / people rows), 1..${LATEST_MESSAGES_MAX_RELATIONS}. Duplicates are answered once.` }),
  })
  .strict();

const LatestMessageSchema = z.object({
  at: z.string().nullable().openapi({ description: "ISO time the message was sent; null only when the source gave none (and the relation holds no dated message)." }),
  source: z.enum(["gmail", "instantly", "matrix", "copilot", "api", "transactional"]),
  channel: z.string().openapi({ description: "email | whatsapp | telegram | discord | chat | api | mcp", example: "email" }),
  direction: z.enum(["inbound", "outbound", "other"]).openapi({ description: "inbound = the person wrote; outbound = the brand did." }),
  sentBy: z.enum(["person", "automation"]).nullable().openapi({
    description:
      "Outbound only (null inbound). automation = one of our machines (a cold-email sequence step, an automated WhatsApp send, the Copilot, the API); " +
      "person = a human of the brand typed it (a WhatsApp / Telegram message from the brand's account that is none of our automated sends); " +
      "null = the source does not say (a Gmail send, a cold-email send tied to no sequence step).",
  }),
  subject: z.string().nullable(),
  text: z.string().nullable().openapi({ description: `The first ${LATEST_MESSAGE_TEXT_MAX} characters.` }),
  textBasis: z.enum(TEXT_BASES).nullable().openapi({
    description:
      "cleaned = the sender's own words (Gmail cleaned by google-service); original = the body as stored, quoted history / signature included when the source sent them " +
      "(cold email, Gmail not cleaned); snippet = Gmail's snippet; as_written = a chat message or a voice note's transcript; summary = our one-line description of an API / MCP answer.",
  }),
  textCleanStatus: z.string().nullable().openapi({ description: "Gmail only: google-service's bodyCleanStatus, verbatim." }),
  textTruncated: z.boolean(),
  from: z.string().nullable(),
  ref: z.record(z.string(), z.string().nullable()).openapi({ description: "The source's own ids, as on the timeline item." }),
});

const LatestMessagesResponseSchema = z.object({
  orgId: z.string().uuid(),
  brandId: z.string().uuid(),
  scope: z.object({ id: z.string().uuid(), status: z.string(), lastBuiltAt: z.string().nullable() }).nullable(),
  counts: z.record(z.enum(LATEST_MESSAGE_STATUSES), z.number().int()),
  relations: z.array(
    z.object({
      relationKey: z.string(),
      status: z.enum(LATEST_MESSAGE_STATUSES).openapi({
        description:
          "message = the latest message of the thread (see gaps); no_message = every thread the relation calls for was read and holds no message; " +
          "unreadable = no message found AND a thread could not be read / was never read yet (gaps); unknown = not a relation of this org + brand (reason).",
      }),
      reason: z.string().nullable().openapi({ description: `unknown: ${UNKNOWN_REASONS.join(" | ")}; unreadable: source_unreadable; else null.` }),
      message: LatestMessageSchema.nullable(),
      gaps: z
        .array(z.object({ source: z.enum(["gmail", "instantly"]), address: z.string(), reason: z.enum(GAP_REASONS), error: z.string().nullable() }))
        .openapi({ description: "Stored threads of the relation that failed their last read or were never read yet: a newer message may exist there." }),
    }),
  ),
});

registry.registerPath({
  method: "post",
  path: "/internal/people/relations/latest-messages",
  summary: "The latest message of each relation's thread (Unibox row preview), many relations in one read",
  description:
    "For one org + brand and up to " +
    LATEST_MESSAGES_MAX_RELATIONS +
    " relation keys: the LATEST message of each relation's thread as `GET /orgs/people/timeline?relationKey=` merges it " +
    "(Gmail and cold email from our message store, WhatsApp / Telegram / Discord DMs and group posts from our Matrix mirror, Copilot and API calls on the staff " +
    "Unibox scope), ours or theirs, whichever is latest. Events (CRM steps, visits, payments) are not messages. Read from what is stored only (the store lags " +
    "the sources by a few minutes at most): no sibling call, no model, no cost. One answer per distinct key, in the order asked.",
  request: { body: { content: { "application/json": { schema: LatestMessagesRequestSchema } } } },
  responses: {
    200: { description: "One answer per relation", content: { "application/json": { schema: LatestMessagesResponseSchema } } },
    400: { description: "Invalid body" },
    502: { description: "Run tracking unavailable" },
  },
});

// ─── WhatsApp line health (WA-LINE-HEALTH-1023) ─────────────────────────────

const LineStateSchema = z
  .enum(["connected", "reconnecting", "logged_out", "bridge_unreachable"])
  .describe(
    "As the bridge states it: `connected` (CONNECTED / BACKFILLING) | `reconnecting` (any other bridge state: the bridge " +
      "reconnects on its own; red once it lasts > 15 min) | `logged_out` (BAD_CREDENTIALS / LOGGED_OUT / login gone: only a " +
      "QR relink brings it back) | `bridge_unreachable` (the bridge did not answer: nothing can be sent).",
  );

export const WhatsappLineDaySchema = z
  .object({
    day: z.string().describe("UTC day, YYYY-MM-DD"),
    status: z
      .enum(["ok", "down", "unknown"])
      .describe("`down` = any minute logged out, bridge unreachable or reconnecting > 15 min (RED); `ok` = connected, never down; `unknown` = nothing observed"),
    connectedMinutes: z.number().int(),
    reconnectingMinutes: z.number().int().describe("Short reconnects the bridge finished on its own (not red)"),
    downMinutes: z.number().int(),
    unknownMinutes: z.number().int().describe("Minutes with no evidence (before history, or the watch not running). Today counts only elapsed minutes."),
    recoveredOnItsOwn: z.number().int().describe("Reconnects that ended connected this day with no human: auto-healed"),
    lastState: z.string().nullable(),
    lastReason: z.string().nullable().describe("The bridge's own words at the day's last observed minute"),
  })
  .openapi("WhatsappLineDay");

export const WhatsappLineHealthSchema = z
  .object({
    generatedAt: z.string(),
    from: z.string().describe("First day of the window (UTC, YYYY-MM-DD)"),
    to: z.string().describe("Last day of the window = today (UTC)"),
    lines: z.array(
      z.object({
        orgId: z.string().uuid(),
        brandId: z.string().uuid(),
        phone: z.string().describe("The line's own number, E.164"),
        linkId: z.string().uuid().nullable(),
        linked: z.boolean().describe("Currently linked; false = an unlinked line that still has days in the window"),
        brandName: z.string().nullable().describe("The brand's name (brand-service), plain words"),
        orgName: z.string().nullable().describe("The org's name (client-service), plain words"),
        namesUnresolvedReason: z.string().nullable().describe("Why brandName / orgName is null; null when both resolved"),
        current: z.object({
          state: z.union([LineStateSchema, z.literal("unknown")]).describe("`unknown` = a linked line not checked in the last 15 min"),
          down: z.boolean().describe("RED now: logged out, bridge unreachable, reconnecting > 15 min, or a linked line not checked in 15 min"),
          since: z.string().nullable().describe("When this state began (the bridge's stated time when it gives one)"),
          checkedAt: z.string().nullable().describe("Last time the watch read the bridge for this line"),
          bridgeState: z.string().nullable().describe("The bridge's own state_event"),
          reason: z.string().nullable().describe("The bridge's own words (e.g. \"You were logged out from another device...\")"),
        }),
        days: z.array(WhatsappLineDaySchema).describe("Oldest first; only days the line has history for"),
      }),
    ).describe("Linked lines first, then red first, then by number"),
  })
  .openapi("WhatsappLineHealth");

registry.registerPath({
  method: "get",
  path: "/internal/ops/whatsapp-lines",
  summary: "Every linked WhatsApp line, fleet-wide: its state now + a stored daily series (dashboard v2 Monitoring)",
  description:
    "WA-LINE-HEALTH-1023. A watch asks the bridge (`/whoami`) for every linked WhatsApp line of every org / brand every 2 min " +
    "and stores the answer as spans and a daily series (recomputed on boot). History before the watch is re-derived from our " +
    "own sends (connected), `whatsapp_not_connected` refusals naming the number (logged out since the bridge's stated time) " +
    "and relink times. Nothing is emailed or messaged: red on the Monitoring hub is the alert. Staff-only behind the gateway.",
  request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).optional().describe("Window in days, default 30") }) },
  responses: {
    200: { description: "Lines", content: { "application/json": { schema: WhatsappLineHealthSchema } } },
    400: { description: "Invalid days" },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/ops/whatsapp-lines/check",
  summary: "Run one WhatsApp line watch pass now (the loop runs every 2 min)",
  responses: { 200: { description: "Lines checked, per state, days recomputed" }, 502: { description: "The pass failed" } },
});
