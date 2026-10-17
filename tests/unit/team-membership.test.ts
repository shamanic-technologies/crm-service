import { describe, it, expect } from "vitest";
import { teamMembership } from "../../src/lib/people/team-membership.js";
import { OWN_TEAM_ROLES } from "../../src/lib/reply-trigger/own-team.js";

const team = new Map<string, string>([
  ["33770000001", OWN_TEAM_ROLES.sales_rep_phone],
  ["447911000002", OWN_TEAM_ROLES.linked_whatsapp_account],
  ["447911000003", OWN_TEAM_ROLES.org_member],
]);
const members = { emails: new Set(["teammate@gmail.com"]), phones: new Set(["+447911000003"]) };

describe("team membership (WA-GIVEN-PURE-FACT-1017)", () => {
  it("the brand's sales rep phone is own team, not staff", () => {
    expect(teamMembership({ email: null, phone: "+33 7 70 00 00 01" }, team, members)).toEqual({
      staff: false,
      ownTeam: true,
      matches: [{ kind: "sales_rep_phone", via: "+33770000001", description: OWN_TEAM_ROLES.sales_rep_phone }],
    });
  });

  it("a distribute.you address is staff; a sending-mailbox +tag is not", () => {
    expect(teamMembership({ email: "Kevin@distribute.you", phone: null }, team, members)).toMatchObject({ staff: true, ownTeam: false });
    expect(teamMembership({ email: "k.lourd+probe@trydistribute.com", phone: null }, team, members)).toMatchObject({ staff: false, ownTeam: false });
  });

  it("an org member by address or by phone, a linked account by phone", () => {
    expect(teamMembership({ email: "teammate@gmail.com", phone: null }, team, members).matches.map((m) => m.kind)).toEqual(["org_member"]);
    expect(teamMembership({ email: null, phone: "+447911000003" }, team, members).matches.map((m) => m.kind)).toEqual(["org_member"]);
    expect(teamMembership({ email: null, phone: "+447911000002" }, team, members).matches.map((m) => m.kind)).toEqual(["linked_whatsapp_account"]);
  });

  it("a random outside number is neither", () => {
    expect(teamMembership({ email: "someone@example.com", phone: "+447700900123" }, team, members)).toEqual({ staff: false, ownTeam: false, matches: [] });
  });
});
