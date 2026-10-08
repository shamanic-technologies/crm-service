import { describe, it, expect } from "vitest";
import { contentHash, ownershipEvents } from "../../src/lib/people/facts.js";

describe("ownershipEvents", () => {
  it("nothing moved: no event", () => {
    expect(ownershipEvents([{ factId: "f1", from: "a", to: "a" }])).toEqual({ splits: [], merges: [] });
  });

  it("a split puts every old fact in exactly one part, unmoved facts under the old key", () => {
    const moves = [
      { factId: "f1", from: "a", to: "a" },
      { factId: "f2", from: "a", to: "b" },
      { factId: "f3", from: "a", to: "c" },
      { factId: "f4", from: "a", to: "b" },
      { factId: "f5", from: "z", to: "z" },
    ];
    const { splits, merges } = ownershipEvents(moves);
    expect(merges).toEqual([]);
    expect(splits).toEqual([
      {
        fromPersonKey: "a",
        parts: [
          { personKey: "a", factIds: ["f1"] },
          { personKey: "b", factIds: ["f2", "f4"] },
          { personKey: "c", factIds: ["f3"] },
        ],
      },
    ]);
    const ids = splits[0].parts.flatMap((p) => p.factIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(moves.filter((m) => m.from === "a").map((m) => m.factId).sort());
  });

  it("all facts of a key moving to one other key is a merge into it", () => {
    expect(
      ownershipEvents([
        { factId: "f1", from: "b", to: "a" },
        { factId: "f2", from: "b", to: "a" },
        { factId: "f3", from: "a", to: "a" },
      ]),
    ).toEqual({ splits: [], merges: [{ fromPersonKey: "b", intoPersonKey: "a" }] });
  });
});

describe("contentHash", () => {
  it("ignores key order and sees any content change", () => {
    const base = { type: "payment" as const, occurredAt: null, dateBasis: "created", sourceContactId: "cus", payload: { a: 1, b: 2 } };
    expect(contentHash(base)).toBe(contentHash({ ...base, payload: { b: 2, a: 1 } }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, payload: { a: 1, b: 3 } }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, occurredAt: "2026-01-01T00:00:00.000Z" }));
  });
});
