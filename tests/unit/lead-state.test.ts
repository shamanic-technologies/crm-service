import { describe, it, expect } from "vitest";
import { indexLeadStates, leadStateWord, matchLeadState, readLeadState } from "../../src/lib/people/lead-state.js";

const served = {
  lifecycle: { key: "meeting_booked", rank: 5, label: "Meeting booked" },
  won: false,
  hot: true,
  lost: null,
  reachable: "contactable",
  conversation: "waiting_on_them",
  fit: "fit",
  fitNote: null,
  interest: "interested",
  clientStatus: "prospect",
  nextFollowupAt: "2026-11-08T09:00:00.000Z",
  nextFollowupBasis: "send",
};

describe("readLeadState: lead-service's leadState, verbatim (LEAD-GENERIC-1106)", () => {
  it("relays every field", () => {
    expect(readLeadState(served, "t")).toEqual(served);
    expect(readLeadState({ ...served, lifecycle: null }, "t").lifecycle).toBeNull();
  });
  it("a malformed answer fails loud, never a partial verdict", () => {
    expect(() => readLeadState({ ...served, won: "no" }, "t")).toThrow(/unreadable leadState/);
    expect(() => readLeadState({ ...served, lost: { reasons: [] } }, "t")).toThrow(/unreadable leadState/);
    const { interest: _i, ...noInterest } = served;
    expect(() => readLeadState(noInterest, "t")).toThrow(/unreadable leadState/);
    expect(() => readLeadState(null, "t")).toThrow(/unreadable leadState/);
  });
});

describe("leadStateWord: lead-service's verdict, else open", () => {
  it("won > hot > lost > open, as lead-service served them (disjoint there)", () => {
    expect(leadStateWord(readLeadState({ ...served, won: true, hot: false }, "t"))).toBe("won");
    expect(leadStateWord(readLeadState(served, "t"))).toBe("hot");
    expect(leadStateWord(readLeadState({ ...served, hot: false, lost: { reasons: ["not_interested"], reachable: null, fit: null } }, "t"))).toBe("lost");
    expect(leadStateWord(readLeadState({ ...served, hot: false }, "t"))).toBe("open");
  });
});

describe("matchLeadState: the row holding the person's lead, else their human's first row", () => {
  const ls = readLeadState(served, "t");
  const rows = [
    { humanId: "h1", companyKey: "co-a", relationKey: null, leadIds: [], leadState: { ...ls, hot: false } },
    { humanId: "h1", companyKey: "co-b", relationKey: null, leadIds: ["l1"], leadState: ls },
  ];
  const idx = indexLeadStates(rows);
  it("lead id first, in the order given", () => {
    expect(matchLeadState(["lx", "l1"], "h1", idx)).toMatchObject({ matchedBy: "lead_id", row: { companyKey: "co-b" } });
  });
  it("else the human's FIRST row in lead-service's order", () => {
    expect(matchLeadState([], "h1", idx)).toMatchObject({ matchedBy: "human_id", row: { companyKey: "co-a" } });
  });
  it("nothing = null", () => {
    expect(matchLeadState(["lx"], "h2", idx)).toBeNull();
    expect(matchLeadState([], null, idx)).toBeNull();
  });
});
