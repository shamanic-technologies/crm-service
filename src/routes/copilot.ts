import { Router } from "express";
import { apiKeyAuth, SERVICE_NAME } from "../middleware/auth.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { copilotDestination, storeCopilotTurn } from "../lib/copilot/messages.js";
import { CopilotTurnRequestSchema } from "../schemas.js";
import { announceCopilotStarts } from "../lib/conversation-pings.js";

const router = Router();

/**
 * chat-service pushes each Copilot chat turn (the user's message and the
 * Copilot's answer). Filed under the staff Unibox scope configured on the box,
 * never under the chatting org (see lib/copilot/messages.ts). DB-only, no cost:
 * a platform run tracks it, no customer org is ever billed.
 */
router.post("/internal/copilot/messages", apiKeyAuth, async (req, res) => {
  const parsed = CopilotTurnRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: parsed.error.message });
  }
  if (!copilotDestination()) {
    return res.status(503).json({
      type: "not_configured",
      error: "COPILOT_UNIBOX_ORG_ID and COPILOT_UNIBOX_BRAND_ID are not set on crm-service: nowhere to file Copilot turns",
    });
  }

  let runId: string;
  try {
    runId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "copilot.messages.store" })).id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  try {
    const { stored, duplicates, newMessageIds } = await storeCopilotTurn(parsed.data, runId);
    await updatePlatformRun(runId, "completed", SERVICE_NAME);
    res.json({ stored, duplicates });
    // The owner's Telegram ping when this turn STARTS a conversation: after the
    // answer, never awaited, never throws (lib/conversation-pings.ts).
    void announceCopilotStarts(parsed.data, newMessageIds, runId);
    return;
  } catch (err) {
    await updatePlatformRun(runId, "failed", SERVICE_NAME).catch((e) =>
      console.error(`[crm-service] failed to close copilot run ${runId}:`, e),
    );
    throw err;
  }
});

export default router;
