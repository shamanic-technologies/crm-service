import { describe, it, expect } from "vitest";
import { assignPersonIds, type KnownKey } from "../../src/lib/people/person-id.js";

const OLD = new Date("2026-09-01T00:00:00Z");
const NEW = new Date("2026-10-01T00:00:00Z");
const known = (entries: [string, string, Date][]) =>
  new Map<string, KnownKey>(entries.map(([key, personId, createdAt]) => [key, { personId, createdAt }]));
const minter = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("assignPersonIds", () => {
  it("a new person gets a fresh id; a known one keeps theirs", () => {
    const r = assignPersonIds(
      [
        { personKey: "email:a@x.com", identityKeys: ["email:a@x.com", "phone:+331"] },
        { personKey: "email:b@x.com", identityKeys: ["email:b@x.com"] },
      ],
      known([["email:a@x.com", "id-a", OLD]]),
      minter(),
    );
    expect(r.ids.get("email:a@x.com")).toBe("id-a");
    expect(r.ids.get("email:b@x.com")).toBe("new-1");
    expect(r.retired).toEqual([]);
  });

  it("the person key changing (a smaller address appears) does not change the id", () => {
    const r = assignPersonIds(
      [{ personKey: "email:0@x.com", identityKeys: ["email:0@x.com", "email:a@x.com"] }],
      known([["email:a@x.com", "id-a", OLD]]),
      minter(),
    );
    expect(r.ids.get("email:0@x.com")).toBe("id-a");
  });

  it("MERGE: the id holding most keys wins, the other is retired into it", () => {
    const r = assignPersonIds(
      [{ personKey: "email:a@x.com", identityKeys: ["email:a@x.com", "email:a2@x.com", "phone:+331"] }],
      known([
        ["email:a@x.com", "id-a", NEW],
        ["email:a2@x.com", "id-a", NEW],
        ["phone:+331", "id-p", OLD],
      ]),
      minter(),
    );
    expect(r.ids.get("email:a@x.com")).toBe("id-a");
    expect(r.retired).toEqual([{ retiredId: "id-p", personId: "id-a" }]);
  });

  it("MERGE tie: the older id wins", () => {
    const r = assignPersonIds(
      [{ personKey: "email:a@x.com", identityKeys: ["email:a@x.com", "phone:+331"] }],
      known([
        ["email:a@x.com", "id-a", NEW],
        ["phone:+331", "id-p", OLD],
      ]),
      minter(),
    );
    expect(r.ids.get("email:a@x.com")).toBe("id-p");
    expect(r.retired).toEqual([{ retiredId: "id-a", personId: "id-p" }]);
  });

  it("SPLIT: the part holding most keys keeps the id, the other gets a new one, nothing retired", () => {
    const r = assignPersonIds(
      [
        { personKey: "email:a@x.com", identityKeys: ["email:a@x.com", "email:a2@x.com"] },
        { personKey: "phone:+331", identityKeys: ["phone:+331"] },
      ],
      known([
        ["email:a@x.com", "id-a", OLD],
        ["email:a2@x.com", "id-a", OLD],
        ["phone:+331", "id-a", OLD],
      ]),
      minter(),
    );
    expect(r.ids.get("email:a@x.com")).toBe("id-a");
    expect(r.ids.get("phone:+331")).toBe("new-1");
    expect(r.retired).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const persons = [
      { personKey: "email:a@x.com", identityKeys: ["email:a@x.com"] },
      { personKey: "phone:+331", identityKeys: ["phone:+331"] },
    ];
    const k = known([
      ["email:a@x.com", "id-a", OLD],
      ["phone:+331", "id-a", OLD],
    ]);
    const one = assignPersonIds(persons, k, minter());
    const two = assignPersonIds([...persons].reverse(), k, minter());
    expect(one.ids.get("email:a@x.com")).toBe("id-a");
    expect(two.ids.get("email:a@x.com")).toBe("id-a");
  });
});
