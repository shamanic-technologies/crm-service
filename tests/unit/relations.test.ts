import { describe, it, expect } from "vitest";
import { capacityOf, correctPointTags, knownCompanies, personRelations, readPoints, type PointCompany } from "../../src/lib/people/relations.js";
import type { TagLookups, TagScores } from "../../src/lib/people/connection-tags.js";
import type { DomainKind } from "../../src/lib/people/organizations.js";
import type { Presence } from "../../src/lib/people/identity.js";
import type { PeopleCorrection } from "../../src/db/schema.js";

const PID = "c941f9b3-262f-4df0-8cc5-3c63b598a7b5";
const CIFACOM = "aaaaaaaa-2222-4222-8222-000000000001";
const scores = (p: Partial<TagScores>): TagScores => ({ personal_to_user: 0, personal_not_to_user: 0, professional_to_brand: 0, professional_not_to_brand: 0, ...p });
const presence = (source: string, ref: string, extra: Partial<Presence> = {}): Presence =>
  ({ source, sourceRef: ref, displayName: null, company: null, emails: [], phones: [], firstActivityAt: null, lastActivityAt: null, messageCount: null, detail: {}, ...extra }) as Presence;

// Adam (prod 2026-10-17): a Clerk account at cifacom.com, a Gmail thread + Stripe + Clerk on gmail.com, a WhatsApp chat with the user.
const ADAM = [
  presence("clerk", "k-cifa", { emails: ["adam-nasri@cifacom.com"], detail: { externalId: "user_cifa" } }),
  presence("clerk", "k-gm", { emails: ["adam2d3d@gmail.com"], detail: { externalId: "user_gm" } }),
  presence("stripe", "k-st", { emails: ["adam2d3d@gmail.com"], detail: { externalId: "cus_1" } }),
  presence("gmail", "adam2d3d@gmail.com", { emails: ["adam2d3d@gmail.com"] }),
  presence("matrix", "k-wa", { detail: { kind: "dm", conversationId: "cfa3", contactId: "k-wa", groups: [] } }),
];
const lookups: TagLookups = {
  brandId: "brand-1",
  automated: false,
  conversations: new Map([
    ["gmail:adam2d3d@gmail.com", { tags: ["professional_to_brand"], scores: scores({ professional_to_brand: 0.8 }), userIds: ["u-kevin"] }],
    ["matrix:cfa3", { tags: ["personal_to_user", "professional_not_to_brand"], scores: scores({ personal_to_user: 0.9, professional_not_to_brand: 0.6 }), userIds: ["u-kevin"] }],
  ]),
  groups: new Map(),
  posters: new Map(),
};
const kinds = new Map<string, { kind: DomainKind; confidence: number }>([
  ["cifacom.com", { kind: "organization", confidence: 0.97 }],
  ["gmail.com", { kind: "mailbox_provider", confidence: 0.99 }],
]);
const companyOf = new Map([["cifacom.com", CIFACOM]]);
const corr = (kind: string, target: Record<string, unknown>): PeopleCorrection =>
  ({ id: `c-${kind}`, orgId: "o", brandId: "b", kind, personId: PID, personKeys: [], target, targetKey: kind, reason: null, statedByUserId: "u-kevin", runId: null, createdAt: new Date(), undoneAt: null, undoneByUserId: null }) as PeopleCorrection;
const keysOf = (rels: { relationKey: string; contactPoints: { id: string }[] }[]) =>
  Object.fromEntries(rels.map((r) => [r.relationKey.replace(`rel:${PID}:`, ""), r.contactPoints.map((c) => c.id).sort()]));

describe("capacityOf", () => {
  it("business with the brand wins; else personal; else work elsewhere; untagged = not judged", () => {
    expect(capacityOf(["personal_to_user", "professional_to_brand"])).toBe("professional");
    expect(capacityOf(["personal_to_user", "professional_not_to_brand"])).toBe("personal");
    expect(capacityOf(["professional_not_to_brand"])).toBe("professional");
    expect(capacityOf([])).toBeNull();
  });
});

describe("personRelations (PERSON-RELATIONS-1017)", () => {
  const readings = readPoints(ADAM, lookups, kinds, companyOf, () => null);

  it("Adam: @Cifacom by evidence, gmail.com points professional with company unknown, the WhatsApp chat personal", () => {
    const rels = personRelations(PID, readings, new Map(), []);
    expect(keysOf(rels)).toEqual({
      [`org:${CIFACOM}`]: ["clerk:user_cifa"],
      personal: ["matrix:k-wa"],
      pro: ["clerk:user_gm", "gmail:adam2d3d@gmail.com", "stripe:cus_1"],
    });
    const cifa = rels.find((r) => r.companyId === CIFACOM)!;
    expect(cifa).toMatchObject({ capacity: "professional", domain: "cifacom.com", emails: ["adam-nasri@cifacom.com"] });
    // The professional rows never carry the personal chat or its tags.
    const pro = rels.find((r) => r.relationKey.endsWith(":pro"))!;
    expect(pro.emails).toEqual(["adam2d3d@gmail.com"]);
    expect(pro.tags.map((t) => t.tag)).toEqual(["professional_to_brand"]);
  });

  it("Jev reads Cifacom in a gmail.com point: that point joins the @Cifacom relation", () => {
    expect(knownCompanies(readings).map((k) => k.companyId)).toEqual([CIFACOM]);
    const jev = new Map<string, PointCompany | null>([["gmail:adam2d3d@gmail.com", { companyId: CIFACOM, domain: "cifacom.com", basis: "jev" }]]);
    const rels = personRelations(PID, readings, jev, []);
    expect(keysOf(rels)[`org:${CIFACOM}`]).toEqual(["clerk:user_cifa", "gmail:adam2d3d@gmail.com"]);
    expect(keysOf(rels).pro).toEqual(["clerk:user_gm", "stripe:cus_1"]);
  });

  it("the user's correction wins: a point moved to a company, then a person-level add claims the unknown ones", () => {
    const one = personRelations(PID, readings, new Map(), [corr("organization_add", { companyId: CIFACOM, domain: "cifacom.com", contactPoint: "stripe:cus_1" })]);
    expect(keysOf(one)[`org:${CIFACOM}`]).toEqual(["clerk:user_cifa", "stripe:cus_1"]);
    const all = personRelations(PID, readings, new Map(), [corr("organization_add", { companyId: CIFACOM, domain: "cifacom.com" })]);
    expect(keysOf(all).pro).toBeUndefined();
    const removed = personRelations(PID, readings, new Map(), [corr("organization_remove", { companyId: CIFACOM, contactPoint: "clerk:user_cifa" })]);
    expect(keysOf(removed)[`org:${CIFACOM}`]).toBeUndefined();
    expect(keysOf(removed).pro).toContain("clerk:user_cifa");
  });

  it("a tag corrected on one point moves only that point (the chat said to be business with the brand)", () => {
    const corrected = correctPointTags(readings, [corr("tag_add", { tag: "professional_to_brand", contactPoint: "matrix:k-wa" })], "brand-1");
    const rels = personRelations(PID, corrected, new Map(), []);
    expect(keysOf(rels).personal).toBeUndefined();
    expect(keysOf(rels).pro).toContain("matrix:k-wa");
  });
});
