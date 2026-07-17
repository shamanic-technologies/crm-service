import { describe, it, expect } from "vitest";
import { buildColumnProfiles, normalizeMapping } from "../../src/lib/column-typing.js";

describe("buildColumnProfiles", () => {
  it("collects up to 5 non-empty samples per header", () => {
    const headers = ["email", "note"];
    const rows = Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.com`, note: "" }));
    const profiles = buildColumnProfiles(headers, rows);
    expect(profiles[0].header).toBe("email");
    expect(profiles[0].samples).toHaveLength(5);
    expect(profiles[1].samples).toHaveLength(0);
  });
});

describe("normalizeMapping", () => {
  it("keeps valid enum fields, collapses unknown to other, fills missing headers", () => {
    const headers = ["Email", "First Name", "Weird", "Missing"];
    const raw = { Email: "email", "First Name": "first_name", Weird: "banana" };
    const mapping = normalizeMapping(headers, raw);
    expect(mapping).toEqual({
      Email: "email",
      "First Name": "first_name",
      Weird: "other",
      Missing: "other",
    });
  });
});
