/**
 * Trigger reports for the dashboard v2 Monitoring hub (lib/trigger-health.ts, WA-GREETING-OFFER-1027):
 *  - GET /internal/ops/trigger-reports?days=30   per trigger: reports stuck unsent (red) + a daily series.
 *  - POST /internal/reply-triggers/reports/withhold {reportIds, note}   OWNER DOOR: never send these reply reports.
 * Staff-only behind the api-service gateway; no org scope (fleet-wide).
 */
import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth.js";
import { readTriggerHealth } from "../lib/trigger-health.js";
import { withholdReplyReports } from "../lib/reply-trigger/watch.js";

const router = Router();
const daysSchema = z.coerce.number().int().min(1).max(90);

router.get("/internal/ops/trigger-reports", apiKeyAuth, async (req, res) => {
  const days = req.query.days === undefined ? { success: true as const, data: 30 } : daysSchema.safeParse(req.query.days);
  if (!days.success) return res.status(400).json({ type: "validation", error: "days must be an integer from 1 to 90" });
  res.json(await readTriggerHealth(days.data));
});

router.post("/internal/reply-triggers/reports/withhold", apiKeyAuth, async (req, res) => {
  const body = z.object({ reportIds: z.array(z.string().uuid()).min(1).max(200), note: z.string().min(1).max(500) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ type: "validation", error: body.error.message });
  res.json(await withholdReplyReports(body.data.reportIds, body.data.note));
});

export default router;
