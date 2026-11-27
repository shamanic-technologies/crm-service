import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { peopleScopes } from "../db/schema.js";
import { apiKeyAuth, requireOrg, AuthenticatedRequest } from "../middleware/auth.js";
import { ConversationReachRequestSchema, ConversationSendRequestSchema } from "../schemas.js";
import { BridgeError } from "../lib/matrix/bridge.js";
import { runSyncPass } from "../lib/matrix/sync.js";
import { runScopeBuild } from "../lib/people/build.js";
import { ConversationRefusal, reachConversation, sendInConversation } from "../lib/matrix/conversation-send.js";
import { SendRefusal } from "../lib/whatsapp/send.js";
import { normalizeEmail, normalizePhone } from "../lib/people/identity.js";

/**
 * Answer a person in their own conversation, on the app they wrote on, from the account they wrote to
 * (LEAD-REPLY-CHANNEL-1127, lib/matrix/conversation-send.ts). One path for every bridged app.
 */
const router = Router();

function personOrConversation(body: { conversationId?: string; email?: string; phone?: string }): string | null {
  if (body.conversationId || normalizeEmail(body.email) || normalizePhone(body.phone)) return null;
  return "name the conversation (`conversationId`) or the person: email, or phone in international form (+<country><number>)";
}

/** POST /orgs/conversations/reach: which conversation, can automation write there, from which account. 200 either way. */
router.post("/orgs/conversations/reach", apiKeyAuth, requireOrg("conversations.reach"), async (req: AuthenticatedRequest, res) => {
  const parsed = ConversationReachRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ type: "validation", code: "invalid_request", error: parsed.error.message });
  const body = parsed.data;
  const brandId = body.brandId ?? req.brandIds?.[0];
  if (!brandId) return res.status(400).json({ type: "validation", code: "invalid_request", error: "brandId (body) or x-brand-id header is required" });
  const missing = personOrConversation(body);
  if (missing) return res.status(400).json({ type: "validation", code: "invalid_request", error: missing });
  try {
    return res.json(
      await reachConversation({ orgId: req.orgId!, brandId, conversationId: body.conversationId ?? null, email: body.email ?? null, phone: body.phone ?? null }),
    );
  } catch (err) {
    if (err instanceof BridgeError) return res.status(502).json({ type: "upstream", code: "bridge_error", error: `bridge: ${err.code} ${err.bridgeMessage}` });
    throw err;
  }
});

/** POST /orgs/conversations/messages: write in that conversation as the account holding it. */
router.post("/orgs/conversations/messages", apiKeyAuth, requireOrg("conversations.send"), async (req: AuthenticatedRequest, res) => {
  const parsed = ConversationSendRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ type: "validation", code: "invalid_request", error: parsed.error.message });
  const body = parsed.data;
  const brandId = body.brandId ?? req.brandIds?.[0];
  if (!brandId) return res.status(400).json({ type: "validation", code: "invalid_request", error: "brandId (body) or x-brand-id header is required" });
  const missing = personOrConversation(body);
  if (missing) return res.status(400).json({ type: "validation", code: "invalid_request", error: missing });
  try {
    const result = await sendInConversation({
      orgId: req.orgId!,
      brandId,
      conversationId: body.conversationId ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      runId: req.runId!,
      callerRunId: req.parentRunId ?? null,
      campaignId: (req.headers["x-campaign-id"] as string | undefined) ?? null,
      idempotencyKey: body.idempotencyKey,
      messages: body.messages ?? [body.text!],
      replyToEventId: body.replyToEventId ?? null,
      userId: req.userId ?? null,
    });
    const { connectionId, ...served } = result;
    res.json(served);
    if (!result.duplicate && process.env.WHATSAPP_SEND_REFRESH !== "off") void refreshAfterSend(req.orgId!, brandId, connectionId);
    return;
  } catch (err) {
    if (err instanceof ConversationRefusal) return res.status(err.httpStatus).json({ type: "refused", code: err.conversationCode, error: err.message });
    if (err instanceof SendRefusal) return res.status(err.httpStatus).json({ type: "refused", code: err.code, error: err.message });
    if (err instanceof BridgeError) return res.status(502).json({ type: "upstream", code: "bridge_error", error: `bridge: ${err.code} ${err.bridgeMessage}` });
    throw err;
  }
});

/** After a send: the sent message into the mirror and the people rebuilt, so the thread shows it within a minute. */
async function refreshAfterSend(orgId: string, brandId: string, connectionId: string | null): Promise<void> {
  try {
    if (connectionId) await runSyncPass(connectionId);
    const [scope] = await db.select().from(peopleScopes).where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
    if (scope) await runScopeBuild(scope);
  } catch (err) {
    console.error(`[crm-service][conversation-send] refresh after send failed:`, err);
  }
}

export default router;
