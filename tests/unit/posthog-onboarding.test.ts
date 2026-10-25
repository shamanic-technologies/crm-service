import { describe, it, expect } from "vitest";
import { ownEventProperties, EVENT_PROPERTY_MAX_CHARS } from "../../src/lib/posthog/client.js";
import { brandEventProperties, derivePosthogContact, deriveKeyEvent, describeKeyEvent, visitorLabel, websiteDomain } from "../../src/lib/posthog/records.js";
import { isUnnamedPosthogOnly, personDisplayName } from "../../src/lib/people/build.js";
import { clusterPeople, type Presence } from "../../src/lib/people/identity.js";

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

describe("ONBOARDING-IN-UNIBOX-1015: what a visitor typed", () => {
  it("an event keeps the brand's own properties only, strings cut", () => {
    expect(ownEventProperties(JSON.stringify({ step: "company", name: "Acme", $current_url: "x", $set: { a: 1 }, __kx: 1 }))).toEqual({
      step: "company",
      name: "Acme",
    });
    expect(ownEventProperties({ mode: "ai" })).toEqual({ mode: "ai" });
    expect(ownEventProperties("not json")).toEqual({});
    expect(ownEventProperties(null)).toEqual({});
    const long = ownEventProperties({ text: "x".repeat(EVENT_PROPERTY_MAX_CHARS + 10) }).text as string;
    expect(long).toHaveLength(EVENT_PROPERTY_MAX_CHARS + 1);
    expect(
      deriveKeyEvent({ id: "e", event: "get_started_step_done", timestamp: "2026-10-15T09:00:00Z", person_id: "p", properties: { step: "offer" } })?.detail,
    ).toMatchObject({ properties: { step: "offer" } });
  });

  it("an event reads as its name and what it carried", () => {
    expect(describeKeyEvent("get_started_step_done", { step: "company", name: "Acme", empty: "", n: null, plan: { a: 1 } })).toBe(
      'Get started step done · step: company · name: Acme · plan: {"a":1}',
    );
    expect(describeKeyEvent("signup_completed", {})).toBe("Signup completed");
    // ONBOARDING-EVENTS-TO-LEADS-1025: PostHog's own non-$ keys (project token, distinct id) are not what the person entered.
    expect(describeKeyEvent("get_started_website_submitted", { token: "phc_x", distinct_id: "d", website: "inogates.com" })).toBe(
      "Get started website submitted · website: inogates.com",
    );
    expect(brandEventProperties({ token: "phc_x", distinct_id: "d", gs_arm: "leads", none: null, blank: "" })).toEqual({ gs_arm: "leads" });
  });

  it("a website names the visitor by its bare domain", () => {
    expect(websiteDomain("https://www.Acme.io/pricing?x=1")).toBe("acme.io");
    expect(websiteDomain("acme.io")).toBe("acme.io");
    expect(websiteDomain("www.shop.acme.co.uk/")).toBe("shop.acme.co.uk");
    expect(websiteDomain("not a site")).toBeNull();
    expect(websiteDomain("")).toBeNull();
    expect(visitorLabel("acme.io")).toBe("Visitor from acme.io");
    expect(visitorLabel(null)).toBeNull();
  });

  it("a person known only by what they typed is no signup; an identified one is", () => {
    expect(derivePosthogContact({ id: "p", prop_website: "acme.io", is_identified: 0 })).toMatchObject({ notSignup: true, website: "acme.io" });
    expect(derivePosthogContact({ id: "p", name: "Ann", is_identified: false })).toMatchObject({ notSignup: true, fullName: "Ann" });
    expect(derivePosthogContact({ id: "p", is_identified: 1 })).toMatchObject({ notSignup: false, website: null });
  });

  it("POSTHOG-EMAIL-NOT-SIGNUP-1024: an email `$set` on an anonymous person keeps the email and is no signup", () => {
    // A newsletter reader whose email the product set on their anonymous person: a visitor WITH that email.
    expect(derivePosthogContact({ id: "p", email: " Ramy@Inogates.com ", is_identified: 0, distinct_ids: ["anon-1"] })).toMatchObject({
      primaryEmail: "ramy@inogates.com",
      notSignup: true,
    });
    // An identified person keeps their signup, email or not.
    expect(derivePosthogContact({ id: "p", email: "a@b.com", is_identified: 1 })).toMatchObject({ notSignup: false });
    expect(derivePosthogContact({ id: "p", email: "a@b.com", is_identified: "true" })).toMatchObject({ notSignup: false });
    // A person named by one of the brand's auth user ids has an account (server-side capture, never identified).
    const auth = new Set(["user_bob"]);
    expect(derivePosthogContact({ id: "p", email: "bob@x.com", is_identified: 0, distinct_ids: ["anon-2", "user_bob"] }, auth)).toMatchObject({ notSignup: false });
    expect(derivePosthogContact({ id: "p", is_identified: 0, distinct_ids: ["user_bob"] }, auth)).toMatchObject({ notSignup: false });
    expect(derivePosthogContact({ id: "p", email: "bob@x.com", is_identified: 0, distinct_ids: ["user_other"] }, auth)).toMatchObject({ notSignup: true });
  });

  it("a website-only PostHog person is a person named 'Visitor from <domain>'; one known by nothing stays nobody", () => {
    const [site, nothing] = clusterPeople(
      [
        presence({ source: "posthog", sourceRef: "ph-1", userIds: ["anon-1"], detail: { website: "https://acme.io" } }),
        presence({ source: "posthog", sourceRef: "ph-2", userIds: ["anon-2"] }),
      ],
      [],
    );
    expect(isUnnamedPosthogOnly(site)).toBe(false);
    expect(personDisplayName(site)).toBe("Visitor from acme.io");
    expect(isUnnamedPosthogOnly(nothing)).toBe(true);
    const [named] = clusterPeople([presence({ source: "posthog", sourceRef: "ph-3", userIds: ["anon-3"], displayName: "Ann" })], []);
    expect(isUnnamedPosthogOnly(named)).toBe(false);
  });

  it("the same human later signing up on Clerk (same user id or phone) stays ONE person, named by their name", () => {
    const people = clusterPeople(
      [
        presence({ source: "posthog", sourceRef: "ph-1", userIds: ["anon-1", "user_ann"], phones: ["+33612345678"], detail: { website: "acme.io" } }),
        presence({ source: "clerk", sourceRef: "c-1", emails: ["ann@acme.io"], phones: ["+33612345678"], userIds: ["user_ann"], displayName: "Ann Lee" }),
      ],
      [],
    );
    expect(people).toHaveLength(1);
    expect(people[0].presences.map((p) => p.source).sort()).toEqual(["clerk", "posthog"]);
    expect(personDisplayName(people[0])).toBe("Ann Lee");
    // Merged on the phone alone too (no shared user id).
    const byPhone = clusterPeople(
      [
        presence({ source: "posthog", sourceRef: "ph-1", userIds: ["anon-1"], phones: ["+33612345678"], detail: { website: "acme.io" } }),
        presence({ source: "clerk", sourceRef: "c-1", emails: ["ann@acme.io"], phones: ["+33612345678"], userIds: ["user_ann"] }),
      ],
      [],
    );
    expect(byPhone).toHaveLength(1);
  });
});
