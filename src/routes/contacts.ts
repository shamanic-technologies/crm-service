import { Router } from "express";
import multer from "multer";
import { createHash } from "crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { contactUploads, contactRowsRaw, contacts, NewContactRowRaw } from "../db/schema.js";
import {
  apiKeyAuth,
  requireOrg,
  requireOrgAndUser,
  AuthenticatedRequest,
} from "../middleware/auth.js";
import { parseCsv } from "../lib/csv.js";
import {
  buildColumnProfiles,
  classifyColumns,
  heuristicMapping,
  normalizeMapping,
  ColumnMapping,
} from "../lib/column-typing.js";
import { promoteUpload } from "../lib/promote.js";
import {
  serveNext,
  serveNextPeople,
  serveStats,
  serveStatsPeople,
  normalizeUploadIdsQuery,
  normalizeReachQuery,
  REACH_CHANNELS,
  type PeopleFilter,
  type Reach,
} from "../lib/serve.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { SERVICE_NAME } from "../middleware/auth.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 * 1024 }, // 256MB — comfortably covers an 80K-row export
});

// Larger chunks = fewer DB round-trips for big uploads. 2000 rows × ~5 cols is
// well under Postgres' 65535-param limit.
const ROW_CHUNK = 2000;

const brandIdSchema = z.string().uuid();

/**
 * Fire-and-forget silver promotion for one upload, under its own platform run.
 * Never throws — this runs after the HTTP response has been sent.
 */
async function runAsyncPromotion(uploadId: string): Promise<void> {
  let platformRunId: string | null = null;
  try {
    const run = await createPlatformRun({
      serviceName: SERVICE_NAME,
      taskName: "contacts.promote",
    });
    platformRunId = run.id;
    await db
      .update(contactUploads)
      .set({ status: "promoting" })
      .where(eq(contactUploads.id, uploadId));

    await promoteUpload(uploadId);

    await db
      .update(contactUploads)
      .set({ status: "promoted" })
      .where(eq(contactUploads.id, uploadId));
    await updatePlatformRun(platformRunId, "completed", SERVICE_NAME);
  } catch (err) {
    console.error(`[crm-service] async promotion failed for upload ${uploadId}:`, err);
    await db
      .update(contactUploads)
      .set({ status: "failed" })
      .where(eq(contactUploads.id, uploadId))
      .catch((e) => console.error("[crm-service] failed to mark upload failed:", e));
    if (platformRunId) {
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service] failed to close platform run:", e),
      );
    }
  }
}

// ─── POST /orgs/contacts/upload ──────────────────────────────────────────────

router.post(
  "/orgs/contacts/upload",
  apiKeyAuth,
  upload.single("file"),
  requireOrgAndUser("contacts.upload"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.body?.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) is required" });
    }
    const brandId = brandParse.data;

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ type: "validation", error: "file (CSV) is required" });
    }

    const contentHash = createHash("sha256").update(req.file.buffer).digest("hex");

    // Idempotent re-upload: same bytes for the same (org, brand) → return the
    // existing upload, re-kick promotion, do NOT re-type or re-write bronze.
    const [existing] = await db
      .select()
      .from(contactUploads)
      .where(
        and(
          eq(contactUploads.orgId, req.orgId!),
          eq(contactUploads.brandId, brandId),
          eq(contactUploads.contentHash, contentHash),
        ),
      );
    if (existing) {
      res.json({
        uploadId: existing.id,
        rowCount: existing.rowCount,
        status: existing.status,
        mappingProvenance: existing.mappingProvenance,
      });
      setImmediate(() => void runAsyncPromotion(existing.id));
      return;
    }

    const { headers, rows } = parseCsv(req.file.buffer);
    if (headers.length === 0) {
      return res.status(400).json({ type: "validation", error: "CSV has no header row" });
    }

    // Resolve column mapping — override skips the LLM entirely.
    let mapping: ColumnMapping;
    let mappingProvenance: "llm" | "override" | "heuristic";
    const overrideRaw = req.body?.columnMapping;
    if (overrideRaw !== undefined && overrideRaw !== "") {
      let parsed: Record<string, unknown>;
      try {
        parsed = typeof overrideRaw === "string" ? JSON.parse(overrideRaw) : overrideRaw;
      } catch {
        return res
          .status(400)
          .json({ type: "validation", error: "columnMapping must be valid JSON" });
      }
      mapping = normalizeMapping(headers, parsed);
      mappingProvenance = "override";
    } else {
      // The classify call is on the synchronous response path, behind the gateway
      // + Cloudflare edge timeout. chatComplete is time-bounded; if it stalls or
      // errors we MUST NOT hang or fail the upload — fall back to a deterministic
      // header-name mapping so bronze is still written and the client gets a fast
      // 200. Re-typing can happen later via /internal/contacts/promote or an
      // override re-upload.
      const profiles = buildColumnProfiles(headers, rows);
      try {
        mapping = await classifyColumns(profiles, {
          orgId: req.orgId!,
          userId: req.userId!,
          runId: req.runId!,
          brandIds: req.brandIds,
        });
        mappingProvenance = "llm";
      } catch (err) {
        console.error(
          "[crm-service] column typing via chat-service failed; using header-name heuristic:",
          err,
        );
        mapping = heuristicMapping(headers);
        mappingProvenance = "heuristic";
      }
    }

    // Bronze write: upload row + raw rows, one transaction.
    const uploadId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(contactUploads)
        .values({
          orgId: req.orgId!,
          brandId,
          filename: req.file!.originalname || "upload.csv",
          contentHash,
          rowCount: rows.length,
          columnHeaders: headers,
          columnMapping: mapping,
          mappingProvenance,
          status: "uploaded",
          runId: req.runId!,
          parentRunId: req.parentRunId ?? null,
        })
        .returning({ id: contactUploads.id });

      for (let i = 0; i < rows.length; i += ROW_CHUNK) {
        const chunk = rows.slice(i, i + ROW_CHUNK).map<NewContactRowRaw>((payload, j) => ({
          orgId: req.orgId!,
          brandId,
          uploadId: row.id,
          rowNumber: i + j,
          payload,
        }));
        await tx.insert(contactRowsRaw).values(chunk).onConflictDoNothing();
      }

      return row.id;
    });

    res.json({ uploadId, rowCount: rows.length, status: "uploaded", mappingProvenance });

    // Kick silver promotion only AFTER the response is sent.
    setImmediate(() => void runAsyncPromotion(uploadId));
  },
);

// ─── POST /orgs/contacts/serve-next ──────────────────────────────────────────

// `uploadIds` restricts the serve to a subset of the brand's imported CRM files
// (the product's per-file ON/OFF switch). Omitted → whole brand, as before.
// Bounded so one call can't emit an unbounded number of SQL parameters.
const MAX_UPLOAD_IDS = 200;
const uploadIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_UPLOAD_IDS);

// `people` switches the pool from the brand's CSV rows to its merged PEOPLE,
// filtered (lib/serve.ts "PEOPLE pool"). Exclusive with `uploadIds`.
// `reachableBy` (one channel or a list, all required): the channel(s) the pipe
// serving writes on. Unreachable people are skipped, never marked served.
const reachSchema = z.union([z.enum(REACH_CHANNELS), z.array(z.enum(REACH_CHANNELS)).max(2)]);
const reachOf = (r: Reach | Reach[] | undefined): Reach[] => (r === undefined ? [] : Array.isArray(r) ? r : [r]);

const peopleFilterSchema = z
  .object({
    signedUp: z.boolean().optional(),
    replied: z.boolean().optional(),
    reachableBy: reachSchema.optional(),
  })
  .strict();

const serveNextBodySchema = z
  .object({
    brandId: z.string().uuid(),
    limit: z.number().int().positive().max(5000).optional(),
    uploadIds: uploadIdsSchema.optional(),
    people: peopleFilterSchema.optional(),
    reachableBy: reachSchema.optional(),
  })
  .refine((b) => !(b.uploadIds && b.people), { message: "uploadIds and people are exclusive" });

const boolQuery = z.enum(["true", "false"]).transform((v) => v === "true");

/** `?pool=people&signedUp=&replied=&reachableBy=` → the people filter; null = the CSV pool. */
function peopleFilterFromQuery(q: Record<string, unknown>): { filter: PeopleFilter | null; error?: string } {
  if (q.pool === undefined || q.pool === "csv") return { filter: null };
  if (q.pool !== "people") return { filter: null, error: "pool must be csv or people" };
  const parsed = z
    .object({ signedUp: boolQuery.optional(), replied: boolQuery.optional() })
    .safeParse({ signedUp: q.signedUp, replied: q.replied });
  if (!parsed.success) return { filter: null, error: "signedUp / replied must be true|false" };
  return { filter: parsed.data };
}

router.post(
  "/orgs/contacts/serve-next",
  apiKeyAuth,
  requireOrg("contacts.serve-next"),
  async (req: AuthenticatedRequest, res) => {
    const parsed = serveNextBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        type: "validation",
        error: `brandId (uuid) required; limit optional 1..5000; uploadIds optional array of 1..${MAX_UPLOAD_IDS} uuids; people optional {signedUp?, replied?, reachableBy?}, exclusive with uploadIds; reachableBy optional phone|email or a list`,
      });
    }
    const { brandId, uploadIds, people } = parsed.data;
    const limit = parsed.data.limit ?? 100;
    const reach = reachOf(parsed.data.reachableBy);

    if (people) {
      res.json(await serveNextPeople(req.orgId!, brandId, limit, req.runId!, people, reach));
      return;
    }
    const result = await serveNext(req.orgId!, brandId, limit, req.runId!, uploadIds, reach);
    res.json(result);
  },
);

// ─── GET /orgs/contacts/serve-stats?brandId= ─────────────────────────────────

router.get(
  "/orgs/contacts/serve-stats",
  apiKeyAuth,
  requireOrg("contacts.serve-stats"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }

    const reachParse = z.array(z.enum(REACH_CHANNELS)).max(2).safeParse(normalizeReachQuery(req.query.reachableBy));
    if (!reachParse.success) {
      return res.status(400).json({ type: "validation", error: "reachableBy must be phone, email, or both (comma-separated)" });
    }
    const reach = reachParse.data;

    const pool = peopleFilterFromQuery(req.query as Record<string, unknown>);
    if (pool.error) return res.status(400).json({ type: "validation", error: pool.error });
    if (pool.filter) {
      if (req.query.uploadIds !== undefined) {
        return res.status(400).json({ type: "validation", error: "uploadIds and pool=people are exclusive" });
      }
      return res.json(await serveStatsPeople(req.orgId!, brandParse.data, pool.filter, reach));
    }

    // Optional per-file scope: ?uploadIds=a,b or repeated ?uploadIds=a&uploadIds=b.
    const rawUploadIds = normalizeUploadIdsQuery(req.query.uploadIds);
    let uploadIds: string[] | undefined;
    if (rawUploadIds.length > 0) {
      const idsParse = uploadIdsSchema.safeParse(rawUploadIds);
      if (!idsParse.success) {
        return res.status(400).json({
          type: "validation",
          error: `uploadIds must be 1..${MAX_UPLOAD_IDS} uuids (comma-separated or repeated)`,
        });
      }
      uploadIds = idsParse.data;
    }

    const stats = await serveStats(req.orgId!, brandParse.data, uploadIds, reach);
    res.json(stats);
  },
);

// ─── GET /orgs/contacts?brandId= ─────────────────────────────────────────────

router.get(
  "/orgs/contacts",
  apiKeyAuth,
  requireOrg("contacts.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const offset = Number(req.query.offset) || 0;

    const rows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.orgId, req.orgId!), eq(contacts.brandId, brandParse.data)))
      // `id` breaks ties so the order is total and limit/offset paging is stable.
      .orderBy(desc(contacts.lastRebuiltAt), asc(contacts.id))
      .limit(limit)
      .offset(offset);

    res.json({ contacts: rows });
  },
);

// ─── GET /orgs/contacts/uploads?brandId= ─────────────────────────────────────

router.get(
  "/orgs/contacts/uploads",
  apiKeyAuth,
  requireOrg("contacts.uploads.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }

    const rows = await db
      .select({
        id: contactUploads.id,
        brandId: contactUploads.brandId,
        filename: contactUploads.filename,
        rowCount: contactUploads.rowCount,
        status: contactUploads.status,
        mappingProvenance: contactUploads.mappingProvenance,
        columnMapping: contactUploads.columnMapping,
        uploadedAt: contactUploads.uploadedAt,
      })
      .from(contactUploads)
      .where(
        and(eq(contactUploads.orgId, req.orgId!), eq(contactUploads.brandId, brandParse.data)),
      )
      .orderBy(desc(contactUploads.uploadedAt));

    res.json({ uploads: rows });
  },
);

export default router;
