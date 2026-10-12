import { describe, it, expect } from "vitest";
import { ownTeamMatch, phoneDigits } from "../../src/lib/reply-trigger/own-team.js";

describe("own team numbers", () => {
  it("compares numbers on their digits, whatever the spelling", () => {
    expect(phoneDigits("+33 7 70 65 75 85")).toBe("33770657585");
    expect(phoneDigits("0033770657585")).toBe("33770657585");
    expect(phoneDigits("33770657585")).toBe("33770657585");
    expect(phoneDigits("")).toBeNull();
    expect(phoneDigits(null)).toBeNull();
    expect(phoneDigits("12")).toBeNull();
  });

  it("names the first number of the other side that is the brand's own, and nobody else", () => {
    const team = new Map([["33770657585", "the brand's sales rep phone"]]);
    expect(ownTeamMatch([null, "+33 6 11 22 33 44", "+33770657585"], team)).toEqual({
      phone: "+33770657585",
      role: "the brand's sales rep phone",
    });
    expect(ownTeamMatch(["+33611223344", null, undefined], team)).toBeNull();
  });
});
