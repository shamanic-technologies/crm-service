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

/** What a number of the own team is to the brand: the map's value, and the log's words. */
export const OWN_TEAM_ROLES = {
  linked_whatsapp_account: "one of the brand's linked WhatsApp accounts",
  sales_rep_phone: "the brand's sales rep phone",
  org_member: "a member of the org",
} as const;

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
    if (d) team.set(d, OWN_TEAM_ROLES.linked_whatsapp_account);
  }

  for (const [d, role] of await readTeamPeoplePhones(identity)) if (!team.has(d) || role === OWN_TEAM_ROLES.sales_rep_phone) team.set(d, role);
  return team;
}

/**
 * The numbers of the brand's PEOPLE (its sales rep, the org's members), without
 * its linked accounts. Throws like
 * `readOwnTeam` when either owner cannot answer.
 */
export async function readTeamPeoplePhones(identity: SiblingIdentity): Promise<OwnTeam> {
  const team: OwnTeam = new Map();
  const path = `/orgs/brands/${identity.brandId}/sales-rep`;
  const r = await siblingGet("brand", path, identity);
  if (r.status !== 200) {
    throw new SiblingError("brand", path, r.status, `brand-service GET ${path} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const rep = phoneDigits((r.body as { salesRepPhone?: string | null } | null)?.salesRepPhone ?? null);
  if (rep) team.set(rep, OWN_TEAM_ROLES.sales_rep_phone);
  for (const p of (await readOrgMembers(identity)).phones) {
    const d = phoneDigits(p);
    if (d && !team.has(d)) team.set(d, OWN_TEAM_ROLES.org_member);
  }
  return team;
}

/**
 * WHO OF THE BUSINESS'S OWN TEAM IS WRITING (OWNER-TO-SOPHIE-1117): the fact Jev reads with a burst.
 *
 * Prod 2026-11-17: the owner answered his assistant's alert on her WhatsApp line ("Réponds-lui toi-même, envoie-lui
 * un lien de paiement pour démarrer avec $10"). Jev, shown no fact about who he is, read an order about another
 * person's deal as words "not written to this business" (0.70) and the instruction was dropped. A team member
 * (one of the brand's linked accounts, its sales rep, any org member by phone or address) writing to the business is
 * the business's own people talking to it: Jev is SHOWN it (burst-context.ts `person.ownTeam`), no rule of ours
 * decides the verdict.
 */
export interface BusinessTeam {
  /** digits -> role (linked account, sales rep, org member). */
  phones: OwnTeam;
  /** every org member's address, normalized. */
  emails: Set<string>;
}

/** Read once per pass (lazy): the brand's own numbers and the org members' addresses. Throws like `readOwnTeam`. */
export function businessTeamOnce(identity: () => Promise<SiblingIdentity>): () => Promise<BusinessTeam> {
  let read: Promise<BusinessTeam> | null = null;
  return () =>
    (read ??= identity().then(async (id) => {
      const [phones, members] = await Promise.all([readOwnTeam(id), readOrgMembers(id)]);
      return { phones, emails: members.emails };
    }));
}

/** PURE: what this person is to the business's own team (the role in words), or null when they are not on it. */
export function teamRoleOf(person: { phones: (string | null | undefined)[]; emails: (string | null | undefined)[] }, team: BusinessTeam): string | null {
  const byPhone = ownTeamMatch(person.phones, team.phones);
  if (byPhone) return byPhone.role;
  for (const e of person.emails) {
    const n = e?.trim().toLowerCase();
    if (n && team.emails.has(n)) return OWN_TEAM_ROLES.org_member;
  }
  return null;
}
