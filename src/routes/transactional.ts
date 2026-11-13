/**
 * Transactional emails the platform sent its clients (lib/transactional/sent-emails.ts, TX-EMAIL-IN-UNIBOX-1024):
 *  - POST /internal/transactional-emails/watch   read the sent-emails feed now (the in-process loop runs every minute).
 */
import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { runTxEmailPassNow } from "../lib/transactional/sent-emails.js";
import { runNewsletterPassNow } from "../lib/transactional/newsletters.js";

const router = Router();

router.post("/internal/transactional-emails/watch", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await runTxEmailPassNow());
  } catch (err) {
    console.error("[crm-service][tx-email] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

router.post("/internal/newsletter-sends/watch", apiKeyAuth, async (req, res) => {
  try {
    // {reread: true}: from the first send again (a list's brand stated after its sends were read).
    res.json(await runNewsletterPassNow({ reread: req.body?.reread === true }));
  } catch (err) {
    console.error("[crm-service][newsletter] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

export default router;
