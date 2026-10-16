import { describe, it, expect } from "vitest";
import { dialablePhone, doorPersonKey } from "../../src/lib/trigger-door.js";

describe("doorPersonKey", () => {
  it("names by email when held; the phone travels only when dialable", () => {
    expect(doorPersonKey("a@b.com", "+33 6 12 34 56 78")).toEqual({ email: "a@b.com", phone: "+33612345678" });
    expect(doorPersonKey("a@b.com", "06 12 34 56 78")).toEqual({ email: "a@b.com", phone: null });
    expect(doorPersonKey("a@b.com", null)).toEqual({ email: "a@b.com", phone: null });
  });

  it("names a person with no email by their E.164 phone", () => {
    expect(doorPersonKey(null, "+44 7911 123-123")).toEqual({ email: null, phone: "+447911123123" });
    expect(doorPersonKey(null, "0044 7911 123123")).toEqual({ email: null, phone: "+447911123123" });
  });

  it("cannot name a person with neither an email nor an international phone", () => {
    expect(doorPersonKey(null, null)).toBeNull();
    expect(doorPersonKey(null, "06 12 34 56 78")).toBeNull();
  });

  it("never offers a number nobody can be called on (OWN-TEAM-GMAIL-1016: a Telegram id as +1501657753)", () => {
    expect(doorPersonKey("a@b.com", "+1501657753")).toEqual({ email: "a@b.com", phone: null });
    expect(doorPersonKey(null, "+1501657753")).toBeNull();
    expect(doorPersonKey(null, "+2541110229905")).toBeNull();
  });
});

describe("dialablePhone", () => {
  it("picks the first dialable number, skipping impossible ones", () => {
    expect(dialablePhone(["+1501657753", null, "+33680478702"])).toBe("+33680478702");
    expect(dialablePhone(["+1501657753"])).toBeNull();
    expect(dialablePhone([])).toBeNull();
  });
});
