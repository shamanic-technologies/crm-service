import { Router } from "express";
import { isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { contactUploads } from "../db/schema.js";
import { apiKeyAuth, SERVICE_NAME } from "../middleware/auth.js";
import { promoteUpload } from "../lib/promote.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";

const router = Router();

const bodySchema = z.object({ uploadId: z.string().uuid().optional() });

/**
 * Reprocess silver from bronze — for schema migrations / logic changes. Idempotent.
 * Creates a platform run up front, responds 202, then runs the promotion in the
 * background (never on the boot path).
 */
router.post("/internal/contacts/promote", apiKeyAuth, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "uploadId must be a uuid" });
  }
  const { uploadId } = parsed.data;

  // Run tracking is mandatory — create the platform run before responding so a
  // runs-service outage fails the request (502) instead of running untracked.
  let platformRunId: string;
  try {
    const run = await createPlatformRun({
      serviceName: SERVICE_NAME,
      taskName: "contacts.promote.reprocess",
    });
    platformRunId = run.id;
  } catch (err) {
    return res
      .status(502)
      .json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }

  res.status(202).json({ status: "accepted", platformRunId, uploadId });

  setImmediate(async () => {
    try {
      if (uploadId) {
        await promoteUpload(uploadId);
      } else {
        const uploads = await db
          .select({ id: contactUploads.id })
          .from(contactUploads)
          .where(isNotNull(contactUploads.columnMapping));
        for (const u of uploads) {
          await promoteUpload(u.id);
        }
      }
      await updatePlatformRun(platformRunId, "completed", SERVICE_NAME);
    } catch (err) {
      console.error("[crm-service] reprocess promotion failed:", err);
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service] failed to close reprocess run:", e),
      );
    }
  });
});

export default router;
