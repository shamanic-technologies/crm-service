import { describe, it, expect } from "vitest";
import { clerk, deriveClerkUser } from "../../src/lib/auth/clerk.js";
import { clusterPeople, type Presence } from "../../src/lib/people/identity.js";
import { isUnnamedPosthogOnly } from "../../src/lib/people/build.js";

const presence = (p: Partial<Presence> & Pick<Presence, "source" | "sourceRef">): Presence => ({
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
  ...p,
});

describe("Clerk derivation", () => {
  it("keeps verified (or unstated) addresses, primary first, lower-cased; drops unverified; dates from unix ms", () => {
    const u = deriveClerkUser({
      id: "user_1",
      first_name: "Ann",
      last_name: null,
      primary_email_address_id: "e2",
      email_addresses: [
        { id: "e1", email_address: "Old@X.com", verification: { status: "verified" } },
        { id: "e2", email_address: "ann@x.com", verification: { status: "verified" } },
        { id: "e3", email_address: "typo@x.com", verification: { status: "unverified" } },
        { id: "e4", email_address: "imported@x.com", verification: null },
      ],
      phone_numbers: [{ id: "p1", phone_number: "+33612345678", verification: { status: "unverified" } }],
      created_at: Date.parse("2026-06-18T10:00:00Z"),
      last_sign_in_at: Date.parse("2026-09-01T00:00:00Z"),
      last_active_at: null,
    });
    expect(u).toMatchObject({
      externalId: "user_1",
      emails: ["ann@x.com", "old@x.com", "imported@x.com"],
      phones: [],
      fullName: "Ann",
      createdAt: new Date("2026-06-18T10:00:00Z"),
      lastActiveAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(deriveClerkUser({ email_addresses: [] })).toBeNull();
  });

  it("refuses a publishable or foreign key before any call", () => {
    expect(clerk.rejectKey("pk_live_x")).toMatch(/PUBLISHABLE/);
    expect(clerk.rejectKey("rk_live_x")).toMatch(/sk_live_/);
    expect(clerk.rejectKey("sk_live_x")).toBeNull();
  });
});

describe("the brand's own user id joins people", () => {
  it("a PostHog person with no email merges with the Clerk user named by its distinct id", () => {
    const people = clusterPeople(
      [
        presence({ source: "posthog", sourceRef: "ph-1", userIds: ["anon-1", "user_bob"] }),
        presence({ source: "clerk", sourceRef: "c-1", emails: ["bob@y.com"], userIds: ["user_bob"] }),
        presence({ source: "posthog", sourceRef: "ph-2", userIds: ["anon-2"] }),
      ],
      [],
    );
    expect(people.map((p) => [p.personKey, p.presences.map((x) => x.source)])).toEqual([
      ["email:bob@y.com", ["posthog", "clerk"]],
      ["uid:anon-2", ["posthog"]],
    ]);
    expect(people.map(isUnnamedPosthogOnly)).toEqual([false, true]);
  });
});
