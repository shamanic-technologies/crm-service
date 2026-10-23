/**
 * WhatsApp line health for the dashboard v2 Monitoring hub (lib/whatsapp/line-health.ts, WA-LINE-HEALTH-1023):
 *  - GET  /internal/ops/whatsapp-lines?days=30   every linked line, fleet-wide: its state now + its daily series;
 *  - POST /internal/ops/whatsapp-lines/check     run one watch pass now (the in-process loop runs every 2 min).
 * Staff-only behind the api-service gateway; no org scope (fleet-wide).
 */
import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth.js";
import { readLineHealth, runLineWatchNow } from "../lib/whatsapp/line-health.js";

const router = Router();
const daysSchema = z.coerce.number().int().min(1).max(90);

router.get("/internal/ops/whatsapp-lines", apiKeyAuth, async (req, res) => {
  const days = req.query.days === undefined ? { success: true as const, data: 30 } : daysSchema.safeParse(req.query.days);
  if (!days.success) return res.status(400).json({ type: "validation", error: "days must be an integer from 1 to 90" });
  res.json(await readLineHealth(days.data));
});

router.post("/internal/ops/whatsapp-lines/check", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await runLineWatchNow());
  } catch (err) {
    console.error("[crm-service][wa-line-health] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

export default router;
