import { describe, it, expect } from "vitest";
import { familyOf, indexFamilies } from "../../src/lib/people/families.js";

const row = (leadId: string | null, email: string | null, family: string, lostReason: string | null = null, humanId?: string | null) =>
  ({ leadId, email, family, lostReason, ...(humanId !== undefined ? { humanId } : {}) }) as never;

describe("indexFamilies", () => {
  it("indexes features-service's verdict per email, verbatim", () => {
    const { byEmail } = indexFamilies({
      counts: { won: 1, hot: 0, lost: 1, cold: 1 },
      people: [row("l1", "a@x.com", "won"), row("l2", "b@x.com", "lost", "ruled_out"), row("l3", null, "cold")],
    });
    expect([...byEmail]).toEqual([
      ["a@x.com", { family: "won", lostReason: null, leadId: "l1" }],
      ["b@x.com", { family: "lost", lostReason: "ruled_out", leadId: "l2" }],
    ]);
  });

  it("one address on two leads keeps the strongest family", () => {
    const { byEmail } = indexFamilies({
      counts: { won: 0, hot: 1, lost: 0, cold: 1 },
      people: [row("l1", "a@x.com", "cold"), row("l2", "A@x.com ", "hot")],
    });
    expect(byEmail.get("a@x.com")?.family).toBe("hot");
  });

  it("a row with no email but a humanId (a WhatsApp writer) is indexed on the human (HOT-INBOUND-UNANSWERED-1016)", () => {
    const { byEmail, byHuman } = indexFamilies({
      counts: { won: 0, hot: 2, lost: 0, cold: 0 },
      people: [row(null, null, "hot", null, "h1"), row(null, "d@x.com", "hot", null, "h2")],
    });
    expect(byHuman.get("h1")).toEqual({ family: "hot", lostReason: null, leadId: null });
    expect(byHuman.get("h2")?.family).toBe("hot");
    expect(byEmail.get("d@x.com")?.family).toBe("hot");
  });

  it("an unknown family or a missing list fails loud", () => {
    expect(() => indexFamilies({ counts: {} as never, people: [row("l1", "a@x.com", "warm")] })).toThrow(/unknown family "warm"/);
    expect(() => indexFamilies({} as never)).toThrow(/without a people list/);
  });
});

describe("familyOf", () => {
  const index = indexFamilies({
    counts: { won: 0, hot: 2, lost: 1, cold: 0 },
    people: [row("l1", "a@x.com", "lost", "went_cold"), row("l2", "b@x.com", "hot"), row(null, null, "hot", null, "h9")],
  });

  it("a person with several lead addresses takes the strongest", () => {
    expect(familyOf(["a@x.com", "b@x.com"], null, index)?.family).toBe("hot");
  });

  it("a person with no matching address is found by their human", () => {
    expect(familyOf([], "h9", index)?.family).toBe("hot");
    expect(familyOf(["a@x.com"], "h9", index)?.family).toBe("hot");
  });

  it("someone who is not one of our leads has no family", () => {
    expect(familyOf(["c@x.com"], "h0", index)).toBeNull();
    expect(familyOf([], null, index)).toBeNull();
  });
});
