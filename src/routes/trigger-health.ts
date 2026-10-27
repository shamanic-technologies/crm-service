/**
 * Trigger reports for the dashboard v2 Monitoring hub (lib/trigger-health.ts, WA-GREETING-OFFER-1027):
 *  - GET /internal/ops/trigger-reports?days=30   per trigger: reports stuck unsent (red) + a daily series.
 * Staff-only behind the api-service gateway; no org scope (fleet-wide).
 */
import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth.js";
import { readTriggerHealth } from "../lib/trigger-health.js";

const router = Router();
const daysSchema = z.coerce.number().int().min(1).max(90);

router.get("/internal/ops/trigger-reports", apiKeyAuth, async (req, res) => {
  const days = req.query.days === undefined ? { success: true as const, data: 30 } : daysSchema.safeParse(req.query.days);
  if (!days.success) return res.status(400).json({ type: "validation", error: "days must be an integer from 1 to 90" });
  res.json(await readTriggerHealth(days.data));
});

export default router;
