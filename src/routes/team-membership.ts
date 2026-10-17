import { Router } from "express";
import { apiKeyAuth, requireOrgAndUser, AuthenticatedRequest } from "../middleware/auth.js";
import { TeamMembershipRequestSchema } from "../schemas.js";
import { normalizeEmail, normalizePhone } from "../lib/people/identity.js";
import { readTeamMembership } from "../lib/people/team-membership.js";

const router = Router();

/**
 * POST /orgs/people/team-membership — is this person our staff and / or the brand's
 * own team? A fact read (lib/people/team-membership.ts): the pipe decides. 502 when
 * the sales rep or the org's members are unreadable, never "not own team".
 */
router.post("/orgs/people/team-membership", apiKeyAuth, requireOrgAndUser("people.team-membership"), async (req: AuthenticatedRequest, res) => {
  const parsed = TeamMembershipRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", code: "invalid_request", error: parsed.error.message });
  }
  const brandId = parsed.data.brandId ?? req.brandIds?.[0];
  if (!brandId) {
    return res.status(400).json({ type: "validation", code: "invalid_request", error: "brandId (body) or x-brand-id header is required" });
  }
  const email = normalizeEmail(parsed.data.email);
  const phone = normalizePhone(parsed.data.phone);
  if (!email && !phone) {
    return res.status(400).json({
      type: "validation",
      code: "invalid_request",
      error: "name the person: email, or phone in international form (+<country><number>)",
    });
  }
  try {
    const membership = await readTeamMembership({ orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId }, { email, phone });
    return res.json(membership);
  } catch (err) {
    return res.status(502).json({ type: "upstream", code: "team_unreadable", error: (err as Error).message });
  }
});

export default router;
