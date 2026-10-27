/**
 * The phone watch, readable and steerable (lib/phone-trigger/watch.ts, WA-GIVEN-TRIGGER-1015):
 *  - GET  /orgs/phone-triggers?brandId=   every number the brand learned, and its `whatsapp_number_given` report;
 *  - POST /internal/phone-triggers/watch  run one pass now (the in-process loop runs every 60s).
 *  - POST /internal/phone-triggers/reports/redeliver {reportIds, replayCampaignOff?}  OWNER DOOR: deliver these unsent
 *    reports now, past the 24 h retry window; `replayCampaignOff` also re-sends, as a new occurrence, a report its
 *    campaign answered `campaign_off` (WA-GREETING-OFFER-1027);
 *  - POST /internal/phone-triggers/reports/withhold {reportIds, note}  OWNER DOOR: never send these (skipped / withheld).
 */
import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { phoneGivenReports } from "../db/schema.js";
import { apiKeyAuth, requireOrg, AuthenticatedRequest } from "../middleware/auth.js";
import { redeliverReports, runPhoneWatchPass, withholdReports } from "../lib/phone-trigger/watch.js";

const router = Router();
const brandIdSchema = z.string().uuid();

router.get("/orgs/phone-triggers", apiKeyAuth, requireOrg("phone-triggers.list"), async (req: AuthenticatedRequest, res) => {
  const brand = brandIdSchema.safeParse(req.query.brandId);
  if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const includeHistory = req.query.includeHistory === "true";
  const found = await db
    .select()
    .from(phoneGivenReports)
    .where(
      and(
        eq(phoneGivenReports.orgId, req.orgId!),
        eq(phoneGivenReports.brandId, brand.data),
        // History (numbers known before the watch looked) only on request.
        includeHistory ? undefined : sql`${phoneGivenReports.reason} IS DISTINCT FROM 'before_watch'`,
      ),
    )
    .orderBy(desc(phoneGivenReports.detectedAt), desc(phoneGivenReports.id))
    .limit(limit);
  res.json({
    reports: found.map((r) => ({
        id: r.id,
        phone: r.phone,
        source: r.source,
        person: { fullName: r.fullName, firstName: r.firstName, lastName: r.lastName, email: r.email, contactId: r.contactId, sourceContactId: r.sourceContactId },
        status: r.status,
        reason: r.reason,
        lastError: r.lastError,
        attempts: r.attempts,
        offerId: r.offerId,
        detectedAt: r.detectedAt,
        reportedAt: r.reportedAt,
        campaignEventId: r.campaignEventId,
        campaignRecordedAt: r.campaignRecordedAt,
        campaignOutcome: r.campaignOutcome,
      })),
  });
});

/** Run one watch pass now and answer what it did (the loop runs every 60s anyway). */
router.post("/internal/phone-triggers/watch", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await runPhoneWatchPass());
  } catch (err) {
    console.error("[crm-service][phone-trigger] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

const reportIdsSchema = z.array(z.string().uuid()).min(1).max(200);

router.post("/internal/phone-triggers/reports/redeliver", apiKeyAuth, async (req, res) => {
  const body = z.object({ reportIds: reportIdsSchema, replayCampaignOff: z.boolean().optional() }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ type: "validation", error: body.error.message });
  try {
    res.json(await redeliverReports(body.data.reportIds, Date.now(), { replayCampaignOff: body.data.replayCampaignOff }));
  } catch (err) {
    console.error("[crm-service][phone-trigger] redeliver failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

router.post("/internal/phone-triggers/reports/withhold", apiKeyAuth, async (req, res) => {
  const body = z.object({ reportIds: reportIdsSchema, note: z.string().min(1).max(500) }).strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ type: "validation", error: body.error.message });
  res.json(await withholdReports(body.data.reportIds, body.data.note));
});

export default router;
