/**
 * The brand's OWN TEAM is never a prospect (WA-RESPONDER-1012, 2026-10-13).
 *
 * A thread a campaign opened can have one of OUR people on the other side: the
 * brand's sales rep (workflow-service alerts them on WhatsApp when the AI
 * escalates, and they answer "ok"), or another of the brand's own linked
 * accounts (a test between two of the brand's numbers). Their words are never
 * a prospect's answer, whatever the thread's history.
 *
 * Own team = a number that is
 *  - one of the brand's linked WhatsApp accounts (`matrix_links.remote_login_id`,
 *    the bridge names a WhatsApp login by its phone digits), or
 *  - the brand's stated sales rep phone, READ from brand-service (its owner),
 *    never copied here, or
 *  - the phone of any MEMBER of the org (client-service, `org-members.ts`,
 *    OWN-TEAM-GMAIL-1016).
 *
 * Numbers are compared on their digits (`+33 7 70…`, `0033770…` and
 * `33770…` are one number).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixLinks } from "../../db/schema.js";
import { siblingGet, SiblingError, type SiblingIdentity } from "../people/siblings.js";
import { readOrgMembers } from "../org-members.js";

/** PURE: a phone as its bare digits (international form), or null when it holds none worth comparing. */
export function phoneDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 6 ? digits : null;
}

/** digits -> what that number is to the brand (for the log). */
export type OwnTeam = Map<string, string>;

/** PURE: the first of these phones that belongs to the brand's own team, with what it is. */
export function ownTeamMatch(phones: (string | null | undefined)[], team: OwnTeam): { phone: string; role: string } | null {
  for (const p of phones) {
    const d = phoneDigits(p);
    if (d && team.has(d)) return { phone: `+${d}`, role: team.get(d)! };
  }
  return null;
}

/**
 * The brand's own numbers. Throws when brand-service cannot say who the sales
 * rep is, or client-service who the org's members are: the caller then reports nothing this pass rather than risk answering
 * one of our own people (the next pass re-reads the thread).
 */
export async function readOwnTeam(identity: SiblingIdentity): Promise<OwnTeam> {
  const team: OwnTeam = new Map();
  const links = await db
    .select({ remoteLoginId: matrixLinks.remoteLoginId })
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.orgId, identity.orgId),
        eq(matrixLinks.brandId, identity.brandId),
        eq(matrixLinks.channel, "whatsapp"),
        isNotNull(matrixLinks.remoteLoginId),
      ),
    );
  for (const l of links) {
    const d = /^\+?\d{6,20}$/.test(l.remoteLoginId ?? "") ? phoneDigits(l.remoteLoginId) : null;
    if (d) team.set(d, "one of the brand's linked WhatsApp accounts");
  }

  const path = `/orgs/brands/${identity.brandId}/sales-rep`;
  const r = await siblingGet("brand", path, identity);
  if (r.status !== 200) {
    throw new SiblingError("brand", path, r.status, `brand-service GET ${path} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const rep = phoneDigits((r.body as { salesRepPhone?: string | null } | null)?.salesRepPhone ?? null);
  if (rep) team.set(rep, "the brand's sales rep phone");
  for (const p of (await readOrgMembers(identity)).phones) {
    const d = phoneDigits(p);
    if (d && !team.has(d)) team.set(d, "a member of the org");
  }
  return team;
}
