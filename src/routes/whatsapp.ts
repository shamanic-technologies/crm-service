import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { peopleScopes, whatsappSends } from "../db/schema.js";
import { apiKeyAuth, requireOrg, AuthenticatedRequest } from "../middleware/auth.js";
import { WhatsappSendRequestSchema, WhatsappSendsQueryRequestSchema } from "../schemas.js";
import { BridgeError } from "../lib/matrix/bridge.js";
import { runSyncPass } from "../lib/matrix/sync.js";
import { runScopeBuild } from "../lib/people/build.js";
import { SendRefusal, sendConnection, sendWhatsApp } from "../lib/whatsapp/send.js";
import { normalizeEmail, normalizePhone } from "../lib/people/identity.js";

const router = Router();

/**
 * After a send: pull the sent message into the mirror and rebuild the brand's
 * people, so the person's thread shows it and they count as written to within
 * a minute instead of at the next cron. Never awaited, never throws.
 */
async function refreshAfterSend(orgId: string, brandId: string, sendId: string): Promise<void> {
  try {
    const connectionId = await sendConnection(sendId);
    if (connectionId) await runSyncPass(connectionId);
    const [scope] = await db
      .select()
      .from(peopleScopes)
      .where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
    if (scope) await runScopeBuild(scope);
  } catch (err) {
    console.error(`[crm-service][whatsapp] refresh after send ${sendId} failed:`, err);
  }
}

/**
 * POST /orgs/whatsapp/messages — send ONE WhatsApp text from the brand's linked
 * WhatsApp account to a person (lib/whatsapp/send.ts). Refusals answer 422
 * (409 for a key in flight) with a stable `code`.
 */
router.post("/orgs/whatsapp/messages", apiKeyAuth, requireOrg("whatsapp.send"), async (req: AuthenticatedRequest, res) => {
  const parsed = WhatsappSendRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", code: "invalid_request", error: parsed.error.message });
  }
  const body = parsed.data;
  const brandId = body.brandId ?? req.brandIds?.[0];
  if (!brandId) {
    return res.status(400).json({ type: "validation", code: "invalid_request", error: "brandId (body) or x-brand-id header is required" });
  }
  if (!normalizeEmail(body.email) && !normalizePhone(body.phone)) {
    return res.status(400).json({
      type: "validation",
      code: "invalid_request",
      error: "name the person: email, or phone in international form (+<country><number>)",
    });
  }
  try {
    const result = await sendWhatsApp({
      orgId: req.orgId!,
      brandId,
      runId: req.runId!,
      campaignId: (req.headers["x-campaign-id"] as string | undefined) ?? null,
      idempotencyKey: body.idempotencyKey,
      text: body.text,
      email: body.email ?? null,
      phone: body.phone ?? null,
      fromAccount: body.fromAccount ?? null,
      skipIfReplied: body.skipIfReplied ?? false,
    });
    res.json(result);
    if (!result.duplicate && process.env.WHATSAPP_SEND_REFRESH !== "off") void refreshAfterSend(req.orgId!, brandId, result.sendId);
    return;
  } catch (err) {
    if (err instanceof SendRefusal) {
      return res.status(err.httpStatus).json({ type: "refused", code: err.code, error: err.message });
    }
    if (err instanceof BridgeError) {
      return res.status(502).json({ type: "upstream", code: "bridge_error", error: `WhatsApp bridge: ${err.code} ${err.bridgeMessage}` });
    }
    throw err;
  }
});

/** GET /orgs/whatsapp/messages?brandId=&email=|phone= — what we sent to this person, newest first. */
router.get("/orgs/whatsapp/messages", apiKeyAuth, requireOrg("whatsapp.sends.list"), async (req: AuthenticatedRequest, res) => {
  const brandId = typeof req.query.brandId === "string" ? req.query.brandId : req.brandIds?.[0];
  const email = normalizeEmail(typeof req.query.email === "string" ? req.query.email : null);
  const phone = normalizePhone(typeof req.query.phone === "string" ? req.query.phone : null);
  if (!brandId || (!email && !phone)) {
    return res.status(400).json({ type: "validation", error: "brandId and (email or phone) are required" });
  }
  const rows = await db
    .select()
    .from(whatsappSends)
    .where(
      and(
        eq(whatsappSends.orgId, req.orgId!),
        eq(whatsappSends.brandId, brandId),
        email ? eq(whatsappSends.email, email) : eq(whatsappSends.phone, phone!),
      ),
    )
    .orderBy(desc(whatsappSends.createdAt), desc(whatsappSends.id))
    .limit(200);
  res.json({
    sends: rows.map((r) => ({
      sendId: r.id,
      status: r.status,
      code: r.errorCode,
      error: r.error,
      email: r.email,
      to: r.phone,
      phoneSource: r.phoneSource,
      fromAccount: r.fromAccount,
      text: r.text,
      campaignId: r.campaignId,
      eventId: r.eventId,
      sentAt: r.sentAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

/**
 * POST /orgs/whatsapp/sends/query — ONE campaign's sends to a LIST of people, in
 * one call (lead-service asks this before handing a person back to a WhatsApp
 * campaign; the per-person GET above cost one call and one run per person).
 * Every send row of the brand + campaign whose email is in the list, any status,
 * newest first; a person with no row is simply absent. Emails are matched
 * case-folded (stored normalized); an entry that is not an email is named in
 * `invalidEmails`, never silently dropped.
 */
router.post("/orgs/whatsapp/sends/query", apiKeyAuth, requireOrg("whatsapp.sends.query"), async (req: AuthenticatedRequest, res) => {
  const parsed = WhatsappSendsQueryRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", code: "invalid_request", error: parsed.error.message });
  }
  const { brandId, campaignId, emails } = parsed.data;
  const wanted = new Set<string>();
  const invalidEmails: string[] = [];
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (email) wanted.add(email);
    else invalidEmails.push(raw);
  }
  const rows = wanted.size
    ? await db
        .select()
        .from(whatsappSends)
        .where(
          and(
            eq(whatsappSends.orgId, req.orgId!),
            eq(whatsappSends.brandId, brandId),
            eq(whatsappSends.campaignId, campaignId),
            inArray(whatsappSends.email, [...wanted]),
          ),
        )
        .orderBy(desc(whatsappSends.createdAt), desc(whatsappSends.id))
    : [];
  res.json({
    sends: rows.map((r) => ({
      email: r.email!,
      sendId: r.id,
      status: r.status,
      code: r.errorCode,
      campaignId: r.campaignId!,
      sentAt: r.sentAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    invalidEmails,
  });
});

export default router;
