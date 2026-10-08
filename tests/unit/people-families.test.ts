import { describe, it, expect } from "vitest";
import { familyOf, indexFamilies } from "../../src/lib/people/families.js";

const row = (leadId: string, email: string | null, family: string, lostReason: string | null = null) =>
  ({ leadId, email, family, lostReason }) as never;

describe("indexFamilies", () => {
  it("indexes features-service's verdict per email, verbatim", () => {
    const byEmail = indexFamilies({
      counts: { won: 1, hot: 0, lost: 1, cold: 1 },
      people: [row("l1", "a@x.com", "won"), row("l2", "b@x.com", "lost", "ruled_out"), row("l3", null, "cold")],
    });
    expect([...byEmail]).toEqual([
      ["a@x.com", { family: "won", lostReason: null, leadId: "l1" }],
      ["b@x.com", { family: "lost", lostReason: "ruled_out", leadId: "l2" }],
    ]);
  });

  it("one address on two leads keeps the strongest family", () => {
    const byEmail = indexFamilies({
      counts: { won: 0, hot: 1, lost: 0, cold: 1 },
      people: [row("l1", "a@x.com", "cold"), row("l2", "A@x.com ", "hot")],
    });
    expect(byEmail.get("a@x.com")?.family).toBe("hot");
  });

  it("an unknown family or a missing list fails loud", () => {
    expect(() => indexFamilies({ counts: {} as never, people: [row("l1", "a@x.com", "warm")] })).toThrow(/unknown family "warm"/);
    expect(() => indexFamilies({} as never)).toThrow(/without a people list/);
  });
});

describe("familyOf", () => {
  const byEmail = indexFamilies({
    counts: { won: 0, hot: 1, lost: 1, cold: 0 },
    people: [row("l1", "a@x.com", "lost", "went_cold"), row("l2", "b@x.com", "hot")],
  });

  it("a person with several lead addresses takes the strongest", () => {
    expect(familyOf(["a@x.com", "b@x.com"], byEmail)?.family).toBe("hot");
  });

  it("someone who is not one of our leads has no family", () => {
    expect(familyOf(["c@x.com"], byEmail)).toBeNull();
    expect(familyOf([], byEmail)).toBeNull();
  });
});
