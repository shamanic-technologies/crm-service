import { describe, it, expect } from "vitest";
import { applyCorrections, correctionsOf, domainOverrides } from "../../src/lib/people/corrections.js";
import { overrideDomains, type DomainKind } from "../../src/lib/people/organizations.js";
import type { PeopleCorrection } from "../../src/db/schema.js";
import type { PersonConnectionTag } from "../../src/lib/people/connection-tags.js";

let n = 0;
const corr = (kind: string, target: Record<string, unknown>, personKeys = ["email:ana@acme.com"]): PeopleCorrection => ({
  id: `c${++n}`,
  orgId: "o",
  brandId: "b",
  kind,
  personId: "p1",
  personKeys,
  target,
  targetKey: kind,
  reason: null,
  statedByUserId: "u-kevin",
  runId: null,
  createdAt: new Date(),
  undoneAt: null,
  undoneByUserId: null,
});
const friend: PersonConnectionTag = { tag: "personal_to_user", userIds: ["u-kevin"], brandId: null, basis: [{ kind: "conversation", ref: "matrix:c1", probability: 0.9 }] };
const lead: PersonConnectionTag = { tag: "professional_to_brand", userIds: [], brandId: "b", basis: [{ kind: "source", ref: "instantly", probability: null }] };

describe("applyCorrections (PEOPLE-CORRECTIONS-1017)", () => {
  it("a user says the friend is not a friend but a prospect: the tag goes, the user's tag comes, marked as theirs", () => {
    const out = applyCorrections(
      { connectionTags: [friend], organizations: [] },
      [corr("tag_remove", { tag: "personal_to_user" }), corr("tag_add", { tag: "professional_to_brand" })],
      "b",
    );
    expect(out.connectionTags).toEqual([
      { tag: "professional_to_brand", userIds: [], brandId: "b", basis: [{ kind: "user_correction", ref: expect.any(String), probability: null }] },
    ]);
  });

  it("adds a company link with the stated tags, and removes one the AI made", () => {
    const acme = { companyId: "c-acme", domain: "acme.com", evidence: [{ kind: "email" as const, value: "ana@acme.com", source: "instantly" }], tags: [lead] };
    const out = applyCorrections(
      { connectionTags: [lead], organizations: [acme] },
      [
        corr("organization_remove", { companyId: "c-acme" }),
        corr("organization_add", { companyId: "c-globex", domain: "globex.com", tags: ["professional_not_to_brand"] }),
      ],
      "b",
    );
    expect(out.organizations).toEqual([
      {
        companyId: "c-globex",
        domain: "globex.com",
        evidence: [{ kind: "user", value: "globex.com", source: "correction" }],
        tags: [{ tag: "professional_not_to_brand", userIds: [], brandId: "b", basis: [{ kind: "user_correction", ref: expect.any(String), probability: null }] }],
      },
    ]);
  });

  it("removing a professional tag drops the company links left with no tag", () => {
    const acme = { companyId: "c-acme", domain: "acme.com", evidence: [], tags: [lead] };
    const out = applyCorrections({ connectionTags: [lead], organizations: [acme] }, [corr("tag_remove", { tag: "professional_to_brand" })], "b");
    expect(out).toEqual({ connectionTags: [], organizations: [] });
  });

  it("a correction follows the person by any key it held when stated", () => {
    const c = corr("tag_add", { tag: "personal_to_user" }, ["email:old@acme.com", "phone:+33600000000"]);
    expect(correctionsOf(["phone:+33600000000", "email:new@x.com"], [c])).toEqual([c]);
    expect(correctionsOf(["email:other@x.com"], [c])).toEqual([]);
  });
});

describe("domain corrections", () => {
  it("a user's domain statement wins over Jev's verdict", () => {
    const kinds = new Map<string, { kind: DomainKind; confidence: number }>([
      ["family.com", { kind: "organization", confidence: 0.9 }],
      ["mybiz.co", { kind: "mailbox_provider", confidence: 0.6 }],
    ]);
    const companyOf = new Map([["family.com", "c-family"]]);
    overrideDomains(
      kinds,
      companyOf,
      domainOverrides([
        corr("domain_kind", { domain: "family.com", domainKind: "mailbox_provider" }, []),
        corr("domain_kind", { domain: "mybiz.co", domainKind: "organization", companyId: "c-mybiz" }, []),
      ]),
    );
    expect(kinds.get("family.com")).toEqual({ kind: "mailbox_provider", confidence: 1 });
    expect(companyOf.has("family.com")).toBe(false);
    expect(kinds.get("mybiz.co")).toEqual({ kind: "organization", confidence: 1 });
    expect(companyOf.get("mybiz.co")).toBe("c-mybiz");
  });
});
