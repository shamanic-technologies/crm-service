import { Router } from "express";
import multer from "multer";
import { createHash } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
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
  normalizeMapping,
  ColumnMapping,
} from "../lib/column-typing.js";
import { promoteUpload } from "../lib/promote.js";
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
    let mappingProvenance: "llm" | "override";
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
      const profiles = buildColumnProfiles(headers, rows);
      mapping = await classifyColumns(profiles, {
        orgId: req.orgId!,
        userId: req.userId!,
        runId: req.runId!,
        brandIds: req.brandIds,
      });
      mappingProvenance = "llm";
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
      .orderBy(desc(contacts.lastRebuiltAt))
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
