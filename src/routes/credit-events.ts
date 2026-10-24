/**
 * billing-service's credit events on the staff Unibox (lib/credit-events/, CREDIT-RAN-OUT-UNIBOX-EVENT-1024):
 *  - POST /internal/credit-events/watch  run one pass now (the in-process loop runs every minute);
 *  - GET  /internal/credit-events        what was mirrored: each event, the people it is about, their Lead event report.
 */
import { Router } from "express";
import { desc, inArray } from "drizzle-orm";
import { apiKeyAuth } from "../middleware/auth.js";
import { creditWatchNow } from "../lib/credit-events/feed.js";
import { db } from "../db/index.js";
import { creditEventReports, creditEvents } from "../db/schema.js";

const router = Router();

router.post("/internal/credit-events/watch", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await creditWatchNow());
  } catch (err) {
    console.error("[crm-service][credit] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

router.get("/internal/credit-events", apiKeyAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const events = await db.select().from(creditEvents).orderBy(desc(creditEvents.at), desc(creditEvents.eventId)).limit(limit);
  const reports = events.length
    ? await db.select().from(creditEventReports).where(inArray(creditEventReports.eventId, events.map((e) => e.eventId)))
    : [];
  res.json({
    events: events.map((e) => ({
      eventId: e.eventId,
      type: e.type,
      accountOrgId: e.creditOrgId,
      accountName: e.orgLabel,
      episodeId: e.episodeId,
      at: e.at.toISOString(),
      memberEmails: e.memberEmails,
      membersResolvedAt: e.membersResolvedAt?.toISOString() ?? null,
      membersError: e.membersError,
      reports: reports
        .filter((r) => r.eventId === e.eventId)
        .map((r) => ({ email: r.email, status: r.status, reason: r.reason, attempts: r.attempts, offerIds: r.offerIds, campaignEvents: r.campaignEvents, reportedAt: r.reportedAt?.toISOString() ?? null })),
    })),
  });
});

export default router;
