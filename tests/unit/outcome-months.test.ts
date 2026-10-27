import { describe, it, expect } from "vitest";
import { fillMonths } from "../../src/lib/people/outcomes.js";

describe("fillMonths (OUTCOMES-CONTACTED-1027)", () => {
  const now = new Date("2026-10-27T12:00:00Z");

  it("fills every month from the first to now, gaps as zeros, across a year boundary", () => {
    const m = fillMonths([{ month: "2025-11", people: 3, contacted: 1 }, { month: "2026-02", people: 2, contacted: 0 }], { first: "2025-11", last: "2026-02" }, now);
    expect(m.map((x) => x.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(m[0]).toEqual({ month: "2025-11", people: 3, contactedByUs: 1, cumulativePeople: 3, cumulativeContactedByUs: 1 });
    expect(m[1]).toEqual({ month: "2025-12", people: 0, contactedByUs: 0, cumulativePeople: 3, cumulativeContactedByUs: 1 });
    expect(m[3]).toEqual({ month: "2026-02", people: 2, contactedByUs: 0, cumulativePeople: 5, cumulativeContactedByUs: 1 });
    expect(m[m.length - 1]).toMatchObject({ month: "2026-10", cumulativePeople: 5, cumulativeContactedByUs: 1 });
  });

  it("runs past now when a reach is dated later, and is empty with no dated reach", () => {
    expect(fillMonths([], { first: "2026-10", last: "2026-12" }, now).map((x) => x.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(fillMonths([], null, now)).toEqual([]);
  });
});
