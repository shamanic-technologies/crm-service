/**
 * Our sending mailboxes as a CRM source (lib/mailbox/, EVERY-PERSON-ON-THE-THREAD-1109):
 *  - POST /internal/sending-mailbox/watch   read instantly-service's mailbox-messages feed now (the loop runs every minute).
 */
import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { runMailboxPassNow } from "../lib/mailbox/feed.js";

const router = Router();

router.post("/internal/sending-mailbox/watch", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await runMailboxPassNow());
  } catch (err) {
    console.error("[crm-service][mailbox] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

export default router;
