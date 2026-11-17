import { Router } from "express";
import { apiKeyAuth, SERVICE_NAME } from "../middleware/auth.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { copilotDestination, storeCopilotTurn } from "../lib/copilot/messages.js";
import { CopilotTurnRequestSchema, WebConversationRequestSchema } from "../schemas.js";
import { storeWebConversation } from "../lib/copilot/messages.js";
import { kickStaffBuild, passAfterBuild, recordWebHandoff, webHandoffScope } from "../lib/copilot/web-handoffs.js";
import { db } from "../db/index.js";
import { webChatHandoffs } from "../db/schema.js";
import { desc } from "drizzle-orm";
import { announceCopilotMessages } from "../lib/assistant-pings.js";

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
    // The owner's Telegram ping for each new message, both ways (SOPHIE-TG-PING-1018):
    // after the answer, never awaited, never throws (lib/assistant-pings.ts).
    void announceCopilotMessages(parsed.data, newMessageIds, runId);
    return;
  } catch (err) {
    await updatePlatformRun(runId, "failed", SERVICE_NAME).catch((e) =>
      console.error(`[crm-service] failed to close copilot run ${runId}:`, e),
    );
    throw err;
  }
});

/**
 * DISTRY-WEB-CHAT-EMAIL-1117: a visitor of our public site gave their email in the chat window. The page conversation
 * becomes part of their person's thread (staff Unibox scope, channel `web`) and ONE Lead event is reported so the Lead
 * event campaign writes them next (lib/copilot/web-handoffs.ts). DB-only here; the report goes out right after the
 * staff people build makes them a person (kicked now), else on the next minute's pass.
 */
router.post("/internal/copilot/web-conversations", apiKeyAuth, async (req, res) => {
  const parsed = WebConversationRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: parsed.error.message });
  }
  const scope = await webHandoffScope();
  if (!scope) {
    return res.status(503).json({
      type: "not_configured",
      error: "the staff Unibox scope (COPILOT_UNIBOX_ORG_ID / COPILOT_UNIBOX_BRAND_ID and its people scope) is not set up on crm-service: nowhere to file the conversation",
    });
  }
  let runId: string;
  try {
    runId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "copilot.web-conversations.store" })).id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  try {
    const body = parsed.data;
    const stored = await storeWebConversation(body, runId);
    const { handoff, duplicate } = await recordWebHandoff({
      orgId: scope.orgId,
      brandId: scope.brandId,
      conversationId: body.conversationId,
      visitorId: body.visitorId,
      email: stored.email,
      phone: body.phone?.trim() || null,
      fullName: body.displayName?.trim() || null,
    });
    await updatePlatformRun(runId, "completed", SERVICE_NAME);
    res.status(202).json({ handoffId: handoff.id, stored: stored.stored, duplicates: stored.duplicates, duplicate, status: handoff.status });
    // The visitor becomes a person of the staff scope with its next build; report as soon as it is done.
    // `WEB_CHAT_HANDOFF_WATCH=off` stops it with the loop (the next build and an owner pass still deliver).
    if ((stored.stored > 0 || handoff.status !== "reported") && process.env.WEB_CHAT_HANDOFF_WATCH !== "off") {
      kickStaffBuild(scope.scopeId, passAfterBuild);
    }
    return;
  } catch (err) {
    await updatePlatformRun(runId, "failed", SERVICE_NAME).catch((e) =>
      console.error(`[crm-service] failed to close web conversation run ${runId}:`, e),
    );
    throw err;
  }
});

router.get("/internal/copilot/web-conversations", apiKeyAuth, async (_req, res) => {
  const handoffs = await db.select().from(webChatHandoffs).orderBy(desc(webChatHandoffs.detectedAt)).limit(200);
  res.json({ handoffs });
});

export default router;
