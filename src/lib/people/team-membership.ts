/**
 * Is this person one of OUR staff, or one of the brand's OWN team? A FACT read
 * (WA-GIVEN-PURE-FACT-1017, owner 2026-10-17): the "WhatsApp number given" trigger
 * no longer filters who it reports; the answering pipe's strategy skips staff and the
 * brand's own team itself, and asks here. No side effect, no refusal: the caller decides.
 *
 * Staff = `isStaffEmail` (owner-telegram.ts). Own team = `readOwnTeam` (the brand's
 * linked WhatsApp numbers, its sales rep phone, every org member's phone) plus every
 * org member's ADDRESS (client-service, org-members.ts). Unreadable sales rep or
 * members = throws (the route answers 502), never "not own team".
 */
import { isStaffEmail } from "../owner-telegram.js";
import { readOrgMembers, type OrgMembers } from "../org-members.js";
import { OWN_TEAM_ROLES, ownTeamMatch, readOwnTeam, type OwnTeam } from "../reply-trigger/own-team.js";
import { normalizeEmail } from "./identity.js";
import type { SiblingIdentity } from "./siblings.js";

export type TeamKind = "staff" | keyof typeof OWN_TEAM_ROLES;

export interface TeamMatch {
  kind: TeamKind;
  /** The address or number that matched. */
  via: string;
  description: string;
}

export interface TeamMembership {
  staff: boolean;
  ownTeam: boolean;
  matches: TeamMatch[];
}

const KIND_BY_ROLE = new Map<string, TeamKind>(
  Object.entries(OWN_TEAM_ROLES).map(([kind, role]) => [role, kind as TeamKind]),
);

/** PURE: every way this email / phone is staff or the brand's own team. */
export function teamMembership(
  person: { email: string | null; phone: string | null },
  team: OwnTeam,
  members: OrgMembers,
): TeamMembership {
  const matches: TeamMatch[] = [];
  const email = normalizeEmail(person.email);
  if (email && isStaffEmail(email)) matches.push({ kind: "staff", via: email, description: "one of distribute.you's staff" });
  if (email && members.emails.has(email)) matches.push({ kind: "org_member", via: email, description: OWN_TEAM_ROLES.org_member });
  const byPhone = ownTeamMatch([person.phone], team);
  if (byPhone) {
    const kind = KIND_BY_ROLE.get(byPhone.role);
    if (!kind) throw new Error(`own team role "${byPhone.role}" has no kind`);
    if (!matches.some((m) => m.kind === kind)) matches.push({ kind, via: byPhone.phone, description: byPhone.role });
  }
  return { staff: matches.some((m) => m.kind === "staff"), ownTeam: matches.some((m) => m.kind !== "staff"), matches };
}

export async function readTeamMembership(
  identity: SiblingIdentity,
  person: { email: string | null; phone: string | null },
): Promise<TeamMembership> {
  const [team, members] = await Promise.all([readOwnTeam(identity), readOrgMembers(identity)]);
  return teamMembership(person, team, members);
}
