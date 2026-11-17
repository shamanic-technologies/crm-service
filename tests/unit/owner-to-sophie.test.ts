import { describe, it, expect } from "vitest";
import { burstJudgeState } from "../../src/lib/reply-trigger/burst-context.js";
import { teamRoleOf, OWN_TEAM_ROLES } from "../../src/lib/reply-trigger/own-team.js";
import { REPLY_KINDS, burstVerdict, triggerOfJudgment } from "../../src/lib/reply-trigger/watch.js";

const business = {
  brand: { name: "Distribute.you", website: "distribute.you", description: "Sales meetings for B2B founders." },
  offers: [{ offerId: "o", name: "Agency", whatWeOffer: "Sales meetings" }],
  otherBrandsOfTheSameOwner: [],
  hash: "h",
};

describe("OWNER-TO-SOPHIE-1117: the business's own people writing to it are never dropped as 'not to business'", () => {
  const team = { phones: new Map([["33770657585", OWN_TEAM_ROLES.linked_whatsapp_account]]), emails: new Set(["owner@acme.com"]) };

  it("names the writer's role on the own team, by number or address, and nobody else", () => {
    expect(teamRoleOf({ phones: ["+33 7 70 65 75 85"], emails: [] }, team)).toBe(OWN_TEAM_ROLES.linked_whatsapp_account);
    expect(teamRoleOf({ phones: [], emails: ["Owner@Acme.com"] }, team)).toBe(OWN_TEAM_ROLES.org_member);
    expect(teamRoleOf({ phones: ["+44 7700 900123", null], emails: ["lead@prospect.io", null] }, team)).toBeNull();
  });

  it("Jev is shown who the writer is to the business; a stranger carries no ownTeam", () => {
    const thread = [
      { at: "2026-11-17T02:59:22.637Z", byThePerson: false, text: "A lead needs your answer: (ethan@x.com) asked: what's the cost per email?" },
      { at: "2026-11-17T11:28:15.000Z", byThePerson: true, text: "Réponds-lui toi-même stp, envoie-lui un lien de paiement pour démarrer avec $10.", new: true },
    ];
    const owner = burstJudgeState("whatsapp", { business, person: { name: "Kevin", phone: "+33770657585", ownTeam: OWN_TEAM_ROLES.linked_whatsapp_account }, thread }) as {
      context: string;
      person: Record<string, unknown>;
    };
    expect(owner.person.ownTeam).toBe("one of the business's own people: one of the brand's linked WhatsApp accounts");
    expect(owner.context).toContain('"person.ownTeam"');
    const lead = burstJudgeState("whatsapp", { business, person: { name: "Ethan", phone: "+447700900123", ownTeam: null }, thread }) as { person: Record<string, unknown> };
    expect(lead.person).not.toHaveProperty("ownTeam");
  });

  it("Jev's own_team kind is reported as a message (a Lead event), never skipped, never a positive reply", () => {
    expect(REPLY_KINDS).toContain("own_team");
    const j = { status: "ok" as const, choice: "own_team", confidence: 0.9, model: "jev", error: null, probabilities: { own_team: 0.95, interested: 0.05 }, positive: 0.05, senderOwnTeam: "x" };
    expect(burstVerdict(j)).toEqual({ report: true, triggerId: "message_received", positive: false });
    expect(triggerOfJudgment(j)).toBe("message_received");
  });
});
