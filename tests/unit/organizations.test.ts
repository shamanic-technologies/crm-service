import { describe, it, expect } from "vitest";
import { domainOfEmail, domainOfWebsite, personOrganizations, presenceContactId, websiteOfPresence, type DomainKind } from "../../src/lib/people/organizations.js";
import { organizationsView } from "../../src/routes/people.js";
import type { TagLookups, TagScores } from "../../src/lib/people/connection-tags.js";

const scores = (p: Partial<TagScores>): TagScores => ({
  personal_to_user: 0,
  personal_not_to_user: 0,
  professional_to_brand: 0,
  professional_not_to_brand: 0,
  ...p,
});
const lookups = (conversations: TagLookups["conversations"] = new Map()): TagLookups => ({
  brandId: "brand-1",
  automated: false,
  conversations,
  groups: new Map(),
  posters: new Map(),
});
const kinds = new Map<string, { kind: DomainKind; confidence: number }>([
  ["acme.com", { kind: "organization", confidence: 0.98 }],
  ["gmail.com", { kind: "mailbox_provider", confidence: 0.99 }],
  ["maybe.io", { kind: "organization", confidence: 0.4 }],
  ["globex.com", { kind: "organization", confidence: 0.9 }],
]);
const companyOf = new Map([
  ["acme.com", "c-acme"],
  ["maybe.io", "c-maybe"],
  ["globex.com", "c-globex"],
]);
const noWebsite = () => null;

describe("domainOfEmail / domainOfWebsite", () => {
  it("reads the domain of an address and the host of a website", () => {
    expect(domainOfEmail("Ana@Acme.COM")).toBe("acme.com");
    expect(domainOfEmail("nope")).toBeNull();
    expect(domainOfWebsite("https://www.acme.com/about")).toBe("acme.com");
    expect(domainOfWebsite("globex.com")).toBe("globex.com");
    expect(domainOfWebsite("  ")).toBeNull();
  });
});

describe("personOrganizations (PERSON-ORGANIZATIONS-1017)", () => {
  it("a lead our cold email wrote to at a work address speaks for that company, professionally to the brand", () => {
    const orgs = personOrganizations(
      { presences: [{ source: "instantly", emails: ["ana@acme.com"], detail: {} }] },
      lookups(),
      kinds,
      companyOf,
      noWebsite,
    );
    expect(orgs).toEqual([
      {
        companyId: "c-acme",
        domain: "acme.com",
        evidence: [{ kind: "email", value: "ana@acme.com", source: "instantly" }],
        tags: [{ tag: "professional_to_brand", userIds: [], brandId: "brand-1", basis: [{ kind: "source", ref: "instantly", probability: null }] }],
      },
    ]);
  });

  it("a public mailbox (gmail.com) is nobody's company; a domain Jev hesitates on (0.4) names none", () => {
    const person = { presences: [{ source: "stripe", emails: ["ana@gmail.com", "x@maybe.io"], detail: {} }] };
    expect(personOrganizations(person, lookups(), kinds, companyOf, noWebsite)).toEqual([]);
  });

  it("a friend writing from a work address, judged personal only, gives no organization link", () => {
    const conversations: TagLookups["conversations"] = new Map([
      ["gmail:bob@acme.com", { tags: ["personal_to_user"], scores: scores({ personal_to_user: 0.9 }), userIds: ["u1"] }],
    ]);
    const person = { presences: [{ source: "gmail", emails: ["bob@acme.com"], detail: {} }] };
    expect(personOrganizations(person, lookups(conversations), kinds, companyOf, noWebsite)).toEqual([]);
  });

  it("a supplier on Gmail links professionally, not to the brand; the CRM website names a second company", () => {
    const conversations: TagLookups["conversations"] = new Map([
      ["gmail:cy@acme.com", { tags: ["professional_not_to_brand"], scores: scores({ professional_not_to_brand: 0.8 }), userIds: ["u1"] }],
    ]);
    const person = {
      presences: [
        { source: "gmail", emails: ["cy@acme.com"], detail: {} },
        { source: "gohighlevel", emails: [], detail: { contactId: "k1" } },
      ],
    };
    const orgs = personOrganizations(person, lookups(conversations), kinds, companyOf, (p) =>
      p.source === "gohighlevel" ? "https://globex.com" : null,
    );
    expect(orgs.map((o) => [o.companyId, o.tags.map((t) => t.tag), o.evidence[0].kind])).toEqual([
      ["c-acme", ["professional_not_to_brand"], "email"],
      ["c-globex", ["professional_to_brand"], "website"],
    ]);
  });
});

describe("websiteOfPresence (WA-THREAD-IDENTITY-1023)", () => {
  const PH = "30e6f401-a464-4e3e-a331-437669329b6e";
  const WA = "1dc6c9b7-448e-4d60-ac38-2891c85d784c";

  it("names our contact id on any source, nothing that is not one", () => {
    expect(presenceContactId({ detail: { contactId: PH } })).toBe(PH);
    expect(presenceContactId({ detail: { contactId: "k1" } })).toBeNull();
    expect(presenceContactId({ detail: {} })).toBeNull();
  });

  it("a signup known by phone on WhatsApp + the website they typed on the brand's PostHog form speaks for that company", () => {
    // Jeremy, 2026-10-22: phone on WhatsApp, website typed on /get-started, no email anywhere. The website
    // evidence read GoHighLevel only, so his company was named nowhere and the writer pitched blind.
    const websiteOf = websiteOfPresence(new Map([[PH, "acme.com"]]));
    const person = {
      presences: [
        { source: "matrix", emails: [], detail: { contactId: WA } },
        { source: "posthog", emails: [], detail: { contactId: PH } },
      ],
    };
    const orgs = personOrganizations(person, lookups(), kinds, companyOf, websiteOf);
    expect(orgs.map((o) => [o.companyId, o.domain, o.evidence])).toEqual([
      ["c-acme", "acme.com", [{ kind: "website", value: "acme.com", source: "posthog" }]],
    ]);
  });
});

describe("organizationsView", () => {
  it("one row per company, most people first, tags counted per person, the union of its links'", () => {
    const view = organizationsView(
      [
        { company_id: "c1", domain: "acme.com", tags: ["professional_to_brand"] },
        { company_id: "c1", domain: "acme.com", tags: ["professional_to_brand", "professional_not_to_brand"] },
        { company_id: "c2", domain: "globex.com", tags: ["professional_not_to_brand"] },
      ],
      10,
      0,
    );
    expect(view).toEqual({
      total: 2,
      links: 3,
      organizations: [
        { companyId: "c1", domains: ["acme.com"], people: 2, tags: [{ tag: "professional_not_to_brand", people: 1 }, { tag: "professional_to_brand", people: 2 }] },
        { companyId: "c2", domains: ["globex.com"], people: 1, tags: [{ tag: "professional_not_to_brand", people: 1 }] },
      ],
    });
    expect(organizationsView([], 10, 0)).toEqual({ total: 0, links: 0, organizations: [] });
  });
});
