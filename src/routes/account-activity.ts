/**
 * What a client DID on their account (CLIENT-ACTIVITY-1030, lib/account-activity/activity.ts):
 *  - POST /internal/account-activity        a producer reports one fact (campaign created / edited / paused /
 *                                           resumed, budget changed, any later account action), fire-and-forget;
 *  - GET  /internal/account-activity        what was reported: each fact, where it was filed, its ping;
 *  - POST /internal/account-activity/watch  one retry pass now (the in-process loop runs every minute).
 */
import { Router } from "express";
import { desc } from "drizzle-orm";
import { apiKeyAuth, SERVICE_NAME } from "../middleware/auth.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { copilotDestination } from "../lib/copilot/messages.js";
import { activityLine, activityWatchNow, processActivity, storeActivity } from "../lib/account-activity/activity.js";
import { AccountActivityRequestSchema } from "../schemas.js";
import { db } from "../db/index.js";
import { accountActivities } from "../db/schema.js";

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null;

router.post("/internal/account-activity", apiKeyAuth, async (req, res) => {
  const parsed = AccountActivityRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ type: "validation", error: parsed.error.message });
  const orgId = header(req.headers["x-org-id"]);
  const userId = header(req.headers["x-user-id"]);
  if (!orgId || !UUID.test(orgId)) {
    return res.status(400).json({ type: "validation", error: "x-org-id (the client org the action happened in, internal uuid) is required" });
  }
  if (userId && !UUID.test(userId)) return res.status(400).json({ type: "validation", error: "x-user-id must be an internal user uuid" });
  if (!copilotDestination()) {
    return res.status(503).json({
      type: "not_configured",
      error: "COPILOT_UNIBOX_ORG_ID and COPILOT_UNIBOX_BRAND_ID are not set on crm-service: nowhere to file account activity",
    });
  }

  let runId: string;
  try {
    runId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "account-activity.store" })).id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  try {
    const { id, duplicate } = await storeActivity(
      parsed.data,
      { orgId, userId, email: header(req.headers["x-email"]), name: null },
      runId,
    );
    await updatePlatformRun(runId, "completed", SERVICE_NAME);
    res.json({ id, stored: !duplicate, duplicate });
    // Filing + the owner's Telegram after the answer, never awaited, never throws; a step that could not run is
    // retried by the loop (lib/account-activity/activity.ts). A duplicate is not re-pinged: the ping is claimed.
    if (!duplicate) void processActivity(id, runId);
    return;
  } catch (err) {
    await updatePlatformRun(runId, "failed", SERVICE_NAME).catch((e) => console.error(`[crm-service] failed to close activity run ${runId}:`, e));
    throw err;
  }
});

router.get("/internal/account-activity", apiKeyAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const rows = await db.select().from(accountActivities).orderBy(desc(accountActivities.receivedAt), desc(accountActivities.id)).limit(limit);
  res.json({
    activities: rows.map((r) => ({
      id: r.id,
      producer: r.producer,
      activityId: r.activityId,
      type: r.type,
      line: activityLine({ title: r.title, subject: r.subject, changes: r.changes, actorName: r.actorName }),
      accountOrgId: r.accountOrgId,
      accountBrandId: r.accountBrandId,
      actorUserId: r.actorUserId,
      actorEmail: r.actorEmail,
      via: r.via,
      occurredAt: r.occurredAt.toISOString(),
      receivedAt: r.receivedAt.toISOString(),
      status: r.status,
      reason: r.reason,
      lastError: r.lastError,
      pingStatus: r.pingStatus,
      pingError: r.pingError,
      pingedAt: r.pingedAt?.toISOString() ?? null,
    })),
  });
});

router.post("/internal/account-activity/watch", apiKeyAuth, async (_req, res) => {
  let runId: string;
  try {
    runId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "account-activity.watch" })).id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  const result = await activityWatchNow(runId);
  await updatePlatformRun(runId, "completed", SERVICE_NAME).catch((e) => console.error(`[crm-service] failed to close activity run ${runId}:`, e));
  res.json(result);
});

export default router;
