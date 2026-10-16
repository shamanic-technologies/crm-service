/**
 * THE ORG'S OWN PEOPLE are never someone writing to the brand (OWN-TEAM-GMAIL-1016).
 *
 * Prod 2026-10-16: the owner's own pitch to a prospect, sent from his PERSONAL
 * address (kevin.lourd@gmail.com) with the brand's mailbox in copy, was read by
 * the Gmail reply trigger as "a prospect wrote to the brand" and rang an AI
 * Instant Call. "Own" used to mean the brand's sending mailboxes and its domain
 * only, so any team member writing from a gmail / outlook address counted as a
 * prospect, for every client.
 *
 * Own team = every MEMBER of the org, whatever address or number they use: read
 * from client-service (its owner), `GET /internal/users?orgId=&allMembers=true`
 * = the users last active in the org plus every member the identity provider
 * (Clerk) holds, staff who set the org up included (their words are never a
 * prospect's either). A recorded fact, never an address-shape guess, never a
 * list of ours.
 *
 * Unreadable = throws: the caller records nothing this pass rather than risk
 * ringing a client about their own teammate (the next pass reads again).
 */
import { normalizeEmail, normalizePhone } from "./people/identity.js";
import { siblingGetOk, type SiblingIdentity } from "./people/siblings.js";

export interface OrgMembers {
  /** Every member's address, normalized. */
  emails: Set<string>;
  /** Every member's international phone (E.164), when client-service holds one. */
  phones: Set<string>;
}

interface ClientUser {
  email: string | null;
  phone: string | null;
}

export async function readOrgMembers(identity: SiblingIdentity): Promise<OrgMembers> {
  const path = `/internal/users?orgId=${encodeURIComponent(identity.orgId)}&allMembers=true`;
  const body = await siblingGetOk<{ users: ClientUser[] }>("client", path, identity);
  if (!Array.isArray(body?.users)) throw new Error(`client-service GET ${path} answered no users list`);
  const members: OrgMembers = { emails: new Set(), phones: new Set() };
  for (const u of body.users) {
    const e = normalizeEmail(u.email);
    if (e) members.emails.add(e);
    const p = normalizePhone(u.phone);
    if (p) members.phones.add(p);
  }
  return members;
}
