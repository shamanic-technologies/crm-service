import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgAndUser, SERVICE_NAME, type AuthenticatedRequest } from "../middleware/auth.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { copilotDestination } from "../lib/copilot/messages.js";
import { describeRequest, describeResponse, readApiCall, storeApiCalls } from "../lib/api-calls/calls.js";
import { ApiCallsRequestSchema } from "../schemas.js";
import { announceApiCallStarts } from "../lib/conversation-pings.js";
import { brandNamesFor } from "../lib/people/timeline.js";

const router = Router();

/**
 * api-service pushes, in batches, every call a client made to our API or MCP
 * server with their own key. Filed under the staff Unibox scope configured on
 * the box, never under the calling org (lib/api-calls/calls.ts). DB-only, no
 * cost: a platform run tracks it, no customer org is ever billed.
 */
router.post("/internal/api-calls", apiKeyAuth, async (req, res) => {
  const parsed = ApiCallsRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: parsed.error.message });
  }
  if (!copilotDestination()) {
    return res.status(503).json({
      type: "not_configured",
      error: "COPILOT_UNIBOX_ORG_ID and COPILOT_UNIBOX_BRAND_ID are not set on crm-service: nowhere to file API calls",
    });
  }

  let runId: string;
  try {
    runId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "api-calls.store" })).id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  try {
    const { stored, duplicates, skippedNoEmail, newCallIds } = await storeApiCalls(parsed.data.calls, runId);
    await updatePlatformRun(runId, "completed", SERVICE_NAME);
    res.json({ stored, duplicates, skippedNoEmail });
    // The owner's Telegram ping for each conversation this batch STARTS: after
    // the answer, never awaited, never throws (lib/conversation-pings.ts).
    void announceApiCallStarts(newCallIds, runId);
    return;
  } catch (err) {
    await updatePlatformRun(runId, "failed", SERVICE_NAME).catch((e) =>
      console.error(`[crm-service] failed to close api-calls run ${runId}:`, e),
    );
    throw err;
  }
});

/** One call, whole: what the thread item `ref.callId` points at. Staff Unibox scope only. */
router.get(
  "/orgs/people/api-calls/:callId",
  apiKeyAuth,
  requireOrgAndUser("people.api-call"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z.object({ brandId: z.string().uuid() }).safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    try {
      const call = await readApiCall(req.orgId!, parsed.data.brandId, String(req.params.callId));
      if (!call) {
        return res.status(404).json({
          type: "not_found",
          reason: "call_not_found",
          error: `no API call ${req.params.callId} in this scope (API calls are served on the staff Unibox only)`,
        });
      }
      const brandNames = await brandNamesFor((call.brandIds as string[]) ?? [], {
        orgId: req.orgId!,
        userId: req.userId!,
        runId: req.runId!,
        brandId: parsed.data.brandId,
      });
      res.json({
        callId: call.callId,
        channel: call.channel,
        mcpTool: call.mcpTool,
        callerOrgId: call.callerOrgId,
        callerUserId: call.callerUserId,
        email: call.email,
        displayName: call.displayName,
        keyFingerprint: call.keyFingerprint,
        brandIds: call.brandIds as string[],
        calledAt: call.calledAt.toISOString(),
        durationMs: call.durationMs,
        summary: { asked: describeRequest(call, brandNames), answered: describeResponse(call) },
        request: {
          method: call.method,
          path: call.path,
          query: call.query as Record<string, unknown>,
          headers: call.requestHeaders as Record<string, string>,
          body: call.requestBody,
          bodyBytes: call.requestBodyBytes,
          bodyTruncated: call.requestBodyTruncated,
        },
        response: {
          status: call.status,
          contentType: call.responseContentType,
          body: call.responseBody,
          bodyBytes: call.responseBodyBytes,
          bodyTruncated: call.responseBodyTruncated,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
