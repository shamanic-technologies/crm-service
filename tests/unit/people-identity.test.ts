import { describe, it, expect } from "vitest";
import {
  clusterPeople,
  normalizeEmail,
  normalizePhone,
  type Evidence,
  type Presence,
} from "../../src/lib/people/identity.js";
import { resolvePersonState } from "../../src/lib/people/state.js";
import { pairingEvidence, possibleLeadOf, type LeadPairingRow } from "../../src/lib/people/sources.js";
import { leadAddressesFirst, type LeadObservation } from "../../src/lib/people/state.js";

function presence(over: Partial<Presence> & Pick<Presence, "source" | "sourceRef">): Presence {
  return {
    displayName: null,
    company: null,
    emails: [],
    phones: [],
    firstActivityAt: null,
    lastActivityAt: null,
    messageCount: null,
    inboundCount: null,
    outboundCount: null,
    detail: {},
    ...over,
  };
}

describe("identity keys are exact, never fuzzy", () => {
  it("lower-cases and trims emails, refuses non-emails", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeEmail("a.lice@gmail.com")).toBe("a.lice@gmail.com");
    expect(normalizeEmail("not an email")).toBeNull();
  });

  it("keys only international phones", () => {
    expect(normalizePhone("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("0033612345678")).toBe("+33612345678");
    expect(normalizePhone("06 12 34 56 78")).toBeNull();
    expect(normalizePhone("+123")).toBeNull();
  });
});

describe("clusterPeople", () => {
  it("one address on Gmail and Instantly is ONE person", () => {
    const out = clusterPeople(
      [
        presence({ source: "gmail", sourceRef: "a@x.com", emails: ["A@x.com"] }),
        presence({ source: "instantly", sourceRef: "a@x.com", emails: ["a@x.com"] }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].personKey).toBe("email:a@x.com");
    expect(out[0].presences.map((p) => p.source).sort()).toEqual(["gmail", "instantly"]);
  });

  it("merges an email and a WhatsApp phone only through a record holding both", () => {
    const gmail = presence({ source: "gmail", sourceRef: "a@x.com", emails: ["a@x.com"] });
    const whatsapp = presence({ source: "matrix", sourceRef: "c1", phones: ["+33612345678"] });
    expect(clusterPeople([gmail, whatsapp], [])).toHaveLength(2);

    const contact: Evidence = {
      kind: "google_contact",
      ref: "g1",
      displayName: "Alice",
      company: null,
      emails: ["a@x.com"],
      phones: ["+33 6 12 34 56 78"],
    };
    const merged = clusterPeople([gmail, whatsapp], [contact]);
    expect(merged).toHaveLength(1);
    expect(merged[0].identityKeys).toEqual(["email:a@x.com", "phone:+33612345678"]);
    expect(merged[0].evidence.map((e) => e.ref)).toEqual(["g1"]);
  });

  it("never merges on a shared name", () => {
    const out = clusterPeople(
      [
        presence({ source: "gmail", sourceRef: "a@x.com", emails: ["a@x.com"], displayName: "Alice Martin" }),
        presence({ source: "matrix", sourceRef: "c1", phones: ["+33612345678"], displayName: "Alice Martin" }),
      ],
      [],
    );
    expect(out).toHaveLength(2);
  });

  it("drops evidence that ties nobody in conversation, and keys a keyless presence on its source", () => {
    const out = clusterPeople(
      [presence({ source: "matrix", sourceRef: "tg-1", displayName: "Bob" })],
      [{ kind: "csv_contact", ref: "r1", displayName: null, company: null, emails: ["z@z.com"], phones: ["+4915112345678"] }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].personKey).toBe("matrix:tg-1");
  });

  it("prefers the smallest email as the person key", () => {
    const out = clusterPeople(
      [presence({ source: "gohighlevel", sourceRef: "c9", emails: ["b@x.com"], phones: ["+33612345678"] })],
      [{ kind: "lead_pairing", ref: "c9", displayName: null, company: null, emails: ["b@x.com", "a@y.com"], phones: [] }],
    );
    expect(out[0].personKey).toBe("email:a@y.com");
  });
});

describe("resolvePersonState precedence", () => {
  const empty = { leadObservations: [], ghlDeals: [], stripe: [], matrixStatuses: [], instantly: null };

  it("lead-service standing wins, verbatim", () => {
    const s = resolvePersonState({
      ...empty,
      leadObservations: [
        { found: false },
        {
          found: true,
          email: "a@x.com",
          standing: { state: "sales_interest", tag: "sales_interest", signal: "positive_reply" },
          leadCampaignId: "lc1",
          leadId: "l1",
          campaignId: "c1",
          campaignIds: ["c1"],
        },
      ],
      ghlDeals: [{ status: "won", pipelineName: null, stageName: null, updatedAt: null }],
    });
    expect(s.state).toBe("sales_interest");
    expect(s.stateSource).toBe("lead_service");
  });

  it("the Unibox tag is lead-service's standing TAG, not its state (a click alone is a website visit)", () => {
    const s = resolvePersonState({
      ...empty,
      leadObservations: [
        {
          found: true,
          email: "norman@x.com",
          standing: { state: "sales_interest", tag: "website_visit", signal: "click" },
          leadCampaignId: "lc1",
          leadId: "l1",
          campaignId: "c1",
          campaignIds: ["c1"],
        },
      ],
    });
    expect(s.state).toBe("website_visit");
    expect(s.stateSource).toBe("lead_service");
    expect((s.stateDetail as { standing: { state: string } }).standing.state).toBe("sales_interest");
  });

  it("a failed lead-service read is unavailable, never a guess from another source", () => {
    const s = resolvePersonState({
      ...empty,
      leadObservations: [{ found: "error", error: "boom" }],
      ghlDeals: [{ status: "won", pipelineName: null, stageName: null, updatedAt: null }],
    });
    expect(s).toMatchObject({ state: "unavailable", stateSource: "lead_service" });
  });

  it("then the CRM's deal status, most advanced first", () => {
    const s = resolvePersonState({
      ...empty,
      leadObservations: [{ found: false }],
      ghlDeals: [
        { status: "lost", pipelineName: "P", stageName: "Lost", updatedAt: null },
        { status: "open", pipelineName: "P", stageName: "Quote sent", updatedAt: null },
      ],
    });
    expect(s).toMatchObject({ state: "deal_open", stateSource: "gohighlevel" });
  });

  it("then the Matrix reading, then Instantly engagement, then in_conversation", () => {
    expect(resolvePersonState({ ...empty, matrixStatuses: ["negotiating", "new"] })).toMatchObject({
      state: "negotiating",
      stateSource: "matrix",
    });
    expect(
      resolvePersonState({ ...empty, instantly: { replied: false, clicked: true, replyClassification: null } }),
    ).toMatchObject({ state: "clicked", stateSource: "instantly" });
    expect(resolvePersonState(empty)).toMatchObject({ state: "in_conversation", stateSource: "none" });
  });
});

describe("pairingEvidence: lead-service's CONFIDENT paired verdict, nothing else", () => {
  const row = (state: LeadPairingRow["pairing"]["state"], lead = true, toConfirm = false): LeadPairingRow => ({
    crmContact: { id: "c1", email: "marketing@aim.com", phone: "+13529423443", fullName: "Joanie S", company: null },
    pairing: { state, toConfirm, lead: lead ? { leadId: "lead-1", email: "joanie@aim.com", fullName: "Joanie S", company: "Aim" } : null },
  });

  it("a confident paired row ties the CRM contact's address and phone to the lead's address", () => {
    expect(pairingEvidence(row("paired"))).toEqual({
      kind: "lead_pairing",
      ref: "c1",
      displayName: "Joanie S",
      company: "Aim",
      emails: ["marketing@aim.com", "joanie@aim.com"],
      phones: ["+13529423443"],
    });
    expect(possibleLeadOf(row("paired"))).toBeNull();
  });

  it("a paired row lead-service is only guessing (toConfirm) merges nothing: it is a hint", () => {
    expect(pairingEvidence(row("paired", true, true))).toBeNull();
    expect(possibleLeadOf(row("paired", true, true))).toEqual({
      crmContactId: "c1",
      leadId: "lead-1",
      email: "joanie@aim.com",
      fullName: "Joanie S",
      company: "Aim",
    });
  });

  it("rejected, never judged (unconfirmed) and unpaired tie nothing and hint nothing", () => {
    for (const s of ["rejected", "unconfirmed", "unpaired"] as const) {
      expect(pairingEvidence(row(s))).toBeNull();
      expect(possibleLeadOf(row(s, true, true))).toBeNull();
    }
    expect(pairingEvidence(row("paired", false))).toBeNull();
  });

  it("a paired row without toConfirm fails loud instead of guessing", () => {
    const r = row("paired") as unknown as { pairing: Record<string, unknown> };
    delete r.pairing.toConfirm;
    expect(() => pairingEvidence(r as unknown as LeadPairingRow)).toThrow(/toConfirm/);
  });
});

describe("leadAddressesFirst: a lead shows under the address lead-service serves", () => {
  it("puts lead-service's addresses first, each group kept in key order", () => {
    const obs = new Map<string, LeadObservation>([
      ["drjackson@mabnr.com", { found: true } as LeadObservation],
      ["drbricejackson@gmail.com", { found: false }],
    ]);
    expect(leadAddressesFirst(["a@x.com", "drbricejackson@gmail.com", "drjackson@mabnr.com"], obs)).toEqual([
      "drjackson@mabnr.com",
      "a@x.com",
      "drbricejackson@gmail.com",
    ]);
    expect(leadAddressesFirst(["b@x.com", "a@x.com"], new Map())).toEqual(["b@x.com", "a@x.com"]);
  });
});
