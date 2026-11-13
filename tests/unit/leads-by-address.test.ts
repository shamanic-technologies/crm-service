import { describe, expect, it } from "vitest";
import { leadFromRows, rowsByAskedAddress, type LeadRow } from "../../src/lib/people/sources.js";

const row = (id: string, email: string, campaignId: string): LeadRow => ({
  id,
  leadId: `l-${id}`,
  email,
  campaignId,
  disqualification: null,
  company: null,
  human: null,
});

describe("lead-service's by-address answer (MON-DB-HOT-1112-CRM-WALK)", () => {
  it("keys rows on the address asked, in lead-service's order; no lead = an explicit empty list", () => {
    const rows = rowsByAskedAddress(["dave@w.com", "nobody@x.com"], {
      addresses: [
        { email: "dave@w.com", leads: [row("lc-3", "Dave@w.com", "camp-3"), row("lc-4", "dave@w.com", "camp-5")] },
        { email: "nobody@x.com", leads: [] },
      ],
    });
    expect(rows.get("dave@w.com")!.map((r) => r.id)).toEqual(["lc-3", "lc-4"]);
    expect(leadFromRows(rows.get("dave@w.com")!)).toMatchObject({ found: true, leadCampaignId: "lc-3", campaignIds: ["camp-3", "camp-5"] });
    expect(leadFromRows(rows.get("nobody@x.com")!)).toEqual({ found: false });
  });

  it("an address left unanswered fails loud, never read as 'not a lead'", () => {
    expect(() => rowsByAskedAddress(["a@x.com", "b@x.com"], { addresses: [{ email: "a@x.com", leads: [] }] })).toThrow(/unanswered/);
  });

  it("a row filed under another address fails loud (a substring is no match)", () => {
    expect(() =>
      rowsByAskedAddress(["bob@y.com"], { addresses: [{ email: "bob@y.com", leads: [row("lc-0", "jimbob@y.com", "camp-9")] }] }),
    ).toThrow(/under bob@y.com/);
  });

  it("an answer with no addresses array fails loud", () => {
    expect(() => rowsByAskedAddress(["a@x.com"], {})).toThrow(/no addresses/);
  });
});
