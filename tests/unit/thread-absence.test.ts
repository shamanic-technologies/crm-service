import { describe, expect, it } from "vitest";
import { decideThreadAbsence, keyTarget } from "../../src/lib/people/thread-absence.js";

const built = new Date("2026-11-26T11:53:50Z");

describe("THREAD-OF-EMAILED-PERSON-1126 decideThreadAbsence", () => {
  it("none only when the index is built and every check answered nothing", () => {
    const t = decideThreadAbsence(built, [
      { check: "email_sent", answer: "nothing" },
      { check: "message_store", answer: "nothing" },
    ]);
    expect(t.status).toBe("none");
    expect(t.retryAfterSeconds).toBeUndefined();
    expect(t.indexBuiltAt).toBe(built.toISOString());
  });

  it("a person we emailed that the index does not hold yet is not_known_yet (dalaal: emailed 11:47, indexed 11:54)", () => {
    const t = decideThreadAbsence(built, [
      { check: "email_sent", answer: "found" },
      { check: "message_store", answer: "nothing" },
    ]);
    expect(t.status).toBe("not_known_yet");
    expect(t.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a check that could not be read is never a none", () => {
    expect(decideThreadAbsence(built, [{ check: "email_sent", answer: "unreadable" }]).status).toBe("not_known_yet");
  });

  it("a scope never built is not_known_yet", () => {
    const t = decideThreadAbsence(null, [{ check: "email_sent", answer: "nothing" }]);
    expect(t.status).toBe("not_known_yet");
    expect(t.checks[0]).toEqual({ check: "people_index", answer: "not_built" });
  });
});

describe("keyTarget", () => {
  it("reads an email key lowercased, a phone key as E.164, anything else as no record check", () => {
    expect(keyTarget("email:Jane@Acme.com")).toEqual({ kind: "email", value: "jane@acme.com" });
    expect(keyTarget("phone:+33612345678")).toEqual({ kind: "phone", value: "+33612345678" });
    expect(keyTarget("uid:user_1")).toBeNull();
    expect(keyTarget("phone:0612")).toBeNull();
  });
});
