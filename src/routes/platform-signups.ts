/**
 * client-service's signup fact feed, copied into the people fact feed
 * (`lib/platform-signups/pull.ts`):
 *  - POST /internal/platform-signups/pull   run one pull now (the in-process loop runs every 60s).
 */
import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { runPlatformSignupPass } from "../lib/platform-signups/pull.js";

const router = Router();

/** Pull client-service's signup facts now and answer what was stored. */
router.post("/internal/platform-signups/pull", apiKeyAuth, async (_req, res) => {
  try {
    const result = await runPlatformSignupPass();
    if (!result) return res.status(409).json({ type: "busy", error: "a pull is already running" });
    res.json(result);
  } catch (err) {
    console.error("[crm-service] platform signups: manual pull failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

export default router;
