import { describe, it, expect } from "vitest";
import { doorPersonKey } from "../../src/lib/trigger-door.js";

describe("doorPersonKey", () => {
  it("names by email when held, the phone carried as is (byte-identical to before)", () => {
    expect(doorPersonKey("a@b.com", "06 12 34 56 78")).toEqual({ email: "a@b.com", phone: "06 12 34 56 78" });
    expect(doorPersonKey("a@b.com", null)).toEqual({ email: "a@b.com", phone: null });
  });

  it("names a person with no email by their E.164 phone", () => {
    expect(doorPersonKey(null, "+44 7700 900-123")).toEqual({ email: null, phone: "+447700900123" });
    expect(doorPersonKey(null, "0044 7700 900123")).toEqual({ email: null, phone: "+447700900123" });
  });

  it("cannot name a person with neither an email nor an international phone", () => {
    expect(doorPersonKey(null, null)).toBeNull();
    expect(doorPersonKey(null, "06 12 34 56 78")).toBeNull();
  });
});
