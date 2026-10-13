import { describe, it, expect } from "vitest";
import {
  contactMark,
  eventHumanIds,
  humanEvidence,
  keysHash,
  personHumanId,
  recordKeys,
  statable,
} from "../../src/lib/people/humans.js";

const H1 = "11111111-1111-4111-8111-000000000001";
const H2 = "11111111-1111-4111-8111-000000000002";

describe("recordKeys", () => {
  it("states only normalised email / international phone keys, sorted and unique", () => {
    expect(recordKeys({ emails: ["Alice@X.com ", "alice@x.com", "not-an-email"], phones: ["+33 6 12 34 56 78", "06 12 34 56 78"] })).toEqual([
      "email:alice@x.com",
      "phone:+33612345678",
    ]);
    expect(recordKeys({ emails: [], phones: [] })).toEqual([]);
  });

  it("hashes a key set the same whatever the input order", () => {
    expect(keysHash(recordKeys({ emails: ["b@y.com", "a@x.com"], phones: [] }))).toBe(
      keysHash(recordKeys({ emails: ["a@x.com", "b@y.com"], phones: [] })),
    );
  });
});

describe("humanEvidence", () => {
  it("ties the keys one human holds, never a key the build does not hold", () => {
    const humanOf = new Map([
      ["email:a@x.com", H1],
      ["phone:+33611111111", H1],
      ["email:other-org@x.com", H1],
      ["email:b@y.com", H2],
    ]);
    const ev = humanEvidence(["email:a@x.com", "phone:+33611111111", "email:b@y.com"], humanOf);
    expect(ev).toEqual([
      { kind: "human_identity", ref: H1, displayName: null, company: null, emails: ["a@x.com"], phones: ["+33611111111"] },
    ]);
  });
});

describe("personHumanId", () => {
  it("is the human most keys name, ties to the smallest key, null when none is known", () => {
    const humanOf = new Map([
      ["email:b@y.com", H2],
      ["email:a@x.com", H1],
    ]);
    expect(personHumanId(["email:a@x.com", "email:b@y.com"], humanOf)).toBe(H1);
    expect(personHumanId(["email:a@x.com", "email:b@y.com", "phone:+1555000000"], new Map([...humanOf, ["phone:+1555000000", H2]]))).toBe(H2);
    expect(personHumanId(["matrix:abc"], humanOf)).toBeNull();
  });
});

describe("eventHumanIds", () => {
  it("only merges / splits / withdrawn statements move a human", () => {
    expect(eventHumanIds({ type: "human.created", humanIds: [H1], data: {} })).toEqual([]);
    expect(eventHumanIds({ type: "human.linked", humanIds: [H1, H2], data: { humanId: H1, memberHumanIds: [H1, H2, "x"] } }).sort()).toEqual([H1, H2, "x"].sort());
  });
});

describe("statable", () => {
  it("needs an email or a phone on BOTH sides", () => {
    expect(statable({ kind: "stated_merge", ref: "m", sides: [{ emails: ["a@x.com"], phones: [] }, { emails: [], phones: ["+33611111111"] }], judgedBy: "person:u", evidence: "e" })).toBe(true);
    expect(statable({ kind: "stated_merge", ref: "m", sides: [{ emails: ["a@x.com"], phones: [] }, { emails: [], phones: ["0611111111"] }], judgedBy: "person:u", evidence: "e" })).toBe(false);
  });
});

describe("contactMark", () => {
  const base = { externalId: null, primaryEmail: "c@z.com", phoneE164: null, unsubscribed: false, consentStatus: "unknown" };
  it("a CSV opt-out or denied consent is an opt_out; a GoHighLevel DND a do_not_contact", () => {
    expect(contactMark({ ...base, source: "csv", unsubscribed: true })).toMatchObject({ subject: "csv:c@z.com", kind: "opt_out", marked: true });
    expect(contactMark({ ...base, source: "csv", consentStatus: "denied" })).toMatchObject({ kind: "opt_out", marked: true });
    expect(contactMark({ ...base, source: "csv" })).toMatchObject({ marked: false });
    expect(contactMark({ ...base, source: "gohighlevel", externalId: "g1", unsubscribed: true })).toMatchObject({ subject: "gohighlevel:g1", kind: "do_not_contact", marked: true });
  });
  it("a contact with no email / phone, or another source, states nothing", () => {
    expect(contactMark({ ...base, source: "csv", primaryEmail: null })).toBeNull();
    expect(contactMark({ ...base, source: "stripe" })).toBeNull();
  });
});
