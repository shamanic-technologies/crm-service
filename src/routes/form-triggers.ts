/**
 * The form-trigger watch, readable and steerable (lib/form-trigger/watch.ts):
 *  - GET  /orgs/gohighlevel/form-triggers?brandId=   what was detected and reported, with the timings;
 *  - GET  /orgs/gohighlevel/form-offers?brandId=     the stated offer per form;
 *  - PUT  /orgs/gohighlevel/form-offers              state which offer a form (or every form) is about;
 *  - DELETE /orgs/gohighlevel/form-offers?brandId=&formId=
 *  - POST /internal/form-triggers/watch              run one pass now (the in-process loop runs every 60s).
 */
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { formOfferMappings, formTriggerReports } from "../db/schema.js";
import { apiKeyAuth, requireOrg, requireOrgAndUser, AuthenticatedRequest } from "../middleware/auth.js";
import { ALL_FORMS, readBrandOffers } from "../lib/form-trigger/offer.js";
import { runFormWatchPass } from "../lib/form-trigger/watch.js";

const router = Router();
const brandIdSchema = z.string().uuid();

router.get(
  "/orgs/gohighlevel/form-triggers",
  apiKeyAuth,
  requireOrg("form-triggers.list"),
  async (req: AuthenticatedRequest, res) => {
    const brand = brandIdSchema.safeParse(req.query.brandId);
    if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await db
      .select()
      .from(formTriggerReports)
      .where(and(eq(formTriggerReports.orgId, req.orgId!), eq(formTriggerReports.brandId, brand.data)))
      .orderBy(desc(formTriggerReports.submittedAt), desc(formTriggerReports.id))
      .limit(limit);
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        source: r.source,
        submissionId: r.submissionId,
        formId: r.formId,
        formName: r.formName,
        person: { fullName: r.fullName, email: r.email, phone: r.phone, sourceContactId: r.sourceContactId, crmContactId: r.crmContactId },
        answers: r.answers,
        status: r.status,
        reason: r.reason,
        lastError: r.lastError,
        attempts: r.attempts,
        offerId: r.offerId,
        submittedAt: r.submittedAt,
        detectedAt: r.detectedAt,
        reportedAt: r.reportedAt,
        campaignEventId: r.campaignEventId,
        campaignRecordedAt: r.campaignRecordedAt,
        campaignOutcome: r.campaignOutcome,
      })),
    });
  },
);

router.get(
  "/orgs/gohighlevel/form-offers",
  apiKeyAuth,
  requireOrg("form-offers.list"),
  async (req: AuthenticatedRequest, res) => {
    const brand = brandIdSchema.safeParse(req.query.brandId);
    if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    const rows = await db
      .select()
      .from(formOfferMappings)
      .where(and(eq(formOfferMappings.orgId, req.orgId!), eq(formOfferMappings.brandId, brand.data)))
      .orderBy(formOfferMappings.formId);
    res.json({
      formOffers: rows.map((r) => ({ formId: r.formId, offerId: r.offerId, statedByUserId: r.statedByUserId, updatedAt: r.updatedAt })),
    });
  },
);

const putBody = z.object({
  brandId: z.string().uuid(),
  /** The CRM form's id; omitted = every form of the brand. */
  formId: z.string().min(1).max(200).optional(),
  offerId: z.string().uuid(),
});

router.put(
  "/orgs/gohighlevel/form-offers",
  apiKeyAuth,
  requireOrgAndUser("form-offers.state"),
  async (req: AuthenticatedRequest, res) => {
    const parsed = putBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) and offerId (uuid) are required; formId optional" });
    }
    const { brandId, offerId } = parsed.data;
    const formId = parsed.data.formId ?? ALL_FORMS;
    const offers = await readBrandOffers({ orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId });
    if (!offers.some((o) => o.offerId === offerId)) {
      return res.status(422).json({ type: "refused", code: "offer_not_of_brand", error: `offer ${offerId} is not an offer of brand ${brandId}` });
    }
    const now = new Date();
    await db
      .insert(formOfferMappings)
      .values({ orgId: req.orgId!, brandId, formId, offerId, statedByUserId: req.userId! })
      .onConflictDoUpdate({
        target: [formOfferMappings.orgId, formOfferMappings.brandId, formOfferMappings.formId],
        set: { offerId, statedByUserId: req.userId!, updatedAt: now },
      });
    res.json({ formOffer: { formId, offerId } });
  },
);

router.delete(
  "/orgs/gohighlevel/form-offers",
  apiKeyAuth,
  requireOrg("form-offers.delete"),
  async (req: AuthenticatedRequest, res) => {
    const brand = brandIdSchema.safeParse(req.query.brandId);
    if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    const formId = typeof req.query.formId === "string" && req.query.formId ? req.query.formId : ALL_FORMS;
    const deleted = await db
      .delete(formOfferMappings)
      .where(and(eq(formOfferMappings.orgId, req.orgId!), eq(formOfferMappings.brandId, brand.data), eq(formOfferMappings.formId, formId)))
      .returning({ id: formOfferMappings.id });
    res.json({ deleted: deleted.length });
  },
);

/** Run one watch pass now and answer what it did (the loop runs every 60s anyway). */
router.post("/internal/form-triggers/watch", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await runFormWatchPass());
  } catch (err) {
    console.error("[crm-service][form-trigger] manual pass failed:", err);
    res.status(502).json({ type: "upstream", error: (err as Error).message });
  }
});

export default router;
