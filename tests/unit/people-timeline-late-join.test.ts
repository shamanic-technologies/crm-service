import { describe, it, expect } from "vitest";
import { mirrorContactKeys, unjoinedPresences, type MirrorContactRow } from "../../src/lib/people/timeline.js";
import type { Presence } from "../../src/lib/people/identity.js";

const row = (over: Partial<MirrorContactRow>): MirrorContactRow => ({
  id: "c1",
  source: "posthog",
  primaryEmail: null,
  phoneE164: null,
  externalId: null,
  rawAttributes: {},
  ...over,
});

const held = (source: Presence["source"], sourceRef: string): Presence => ({
  source,
  sourceRef,
  displayName: null,
  company: null,
  emails: [],
  phones: [],
  firstActivityAt: null,
  lastActivityAt: null,
  messageCount: null,
  inboundCount: null,
  outboundCount: null,
  detail: {},
});

describe("records not yet joined to a person (TIMELINE-STALE-SOURCE-1023)", () => {
  it("derives the keys each mirror states, as the build does", () => {
    expect(mirrorContactKeys(row({ primaryEmail: "A@X.com", rawAttributes: { distinctIds: ["user_1", "anon"] } }))).toEqual([
      "email:a@x.com",
      "uid:user_1",
      "uid:anon",
    ]);
    expect(
      mirrorContactKeys(row({ source: "clerk", primaryEmail: "ignored@x.com", externalId: "user_1", rawAttributes: { emails: ["a@x.com"], phones: ["+33612345678"] } })),
    ).toEqual(["email:a@x.com", "phone:+33612345678", "uid:user_1"]);
    // Only PostHog distinct ids are user ids; a Stripe customer's external id is not.
    expect(mirrorContactKeys(row({ source: "stripe", externalId: "cus_1", phoneE164: "+971503639172" }))).toEqual(["phone:+971503639172"]);
  });

  it("keeps a record stating one of the person's keys that the index does not hold yet, and nothing else", () => {
    const keys = ["email:a@x.com", "uid:user_1"];
    const rows = [
      row({ id: "ph-new", primaryEmail: "a@x.com" }), // Albin: email given after the build
      row({ id: "ph-uid", rawAttributes: { distinctIds: ["user_1"] } }), // tied by the auth user id only
      row({ id: "ph-held", primaryEmail: "a@x.com" }), // already on the person
      row({ id: "ph-other", primaryEmail: "b@x.com" }), // someone else
      row({ id: "csv-1", source: "csv", primaryEmail: "a@x.com" }), // not a late-join source
    ];
    const late = unjoinedPresences(rows, keys, [held("posthog", "ph-held")]);
    expect(late.map((p) => [p.source, p.sourceRef])).toEqual([
      ["posthog", "ph-new"],
      ["posthog", "ph-uid"],
    ]);
    expect(late[0]).toMatchObject({ emails: ["a@x.com"], detail: { contactId: "ph-new" } });
  });
});
