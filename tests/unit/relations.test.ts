import { describe, it, expect } from "vitest";
import {
  ANOTHER_COMPANY,
  ANY_KNOWN,
  capacityOf,
  correctPointTags,
  knownCompanies,
  personRelations,
  pointOrgAnswer,
  pointOrgQuestion,
  readPoints,
  pointConversationKeys,
  resolvePointCompanies,
  type PointCompany,
} from "../../src/lib/people/relations.js";
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
    const jev = new Map<string, PointCompany[] | null>([["gmail:adam2d3d@gmail.com", [{ companyId: CIFACOM, domain: "cifacom.com", basis: "jev" }]]]);
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

// WA-SPLIT-RELATION-1026 (prod 2026-10-26): Noah Lucia, noah@daybookhealthcare.com + a WhatsApp chat about the offer
// that never names Daybook. Jev was asked "which company does it name?" and said unknown: the chat sat on a
// company-less relation, the Daybook row (his lead, his follow-ups) never saw it.
describe("a professional point without a company speaks for the person's known work (WA-SPLIT-RELATION-1026)", () => {
  const DAYBOOK = "b86c4ccb-4b49-4aaa-9101-6d35f377204e";
  const OTHER = "aaaaaaaa-2222-4222-8222-000000000002";
  const daybook: PointCompany = { companyId: DAYBOOK, domain: "daybookhealthcare.com", basis: "evidence" };
  const other: PointCompany = { companyId: OTHER, domain: "other.io", basis: "evidence" };
  const NOAH = [
    presence("instantly", "noah@daybookhealthcare.com", { emails: ["noah@daybookhealthcare.com"] }),
    presence("matrix", "k-wa", { phones: ["+15854852133"], detail: { kind: "dm", conversationId: "noah-wa", contactId: "k-wa", groups: [] } }),
  ];
  const noahLookups: TagLookups = {
    ...lookups,
    conversations: new Map([["matrix:noah-wa", { tags: ["professional_to_brand"], scores: scores({ professional_to_brand: 0.95 }), userIds: [] }]]),
  };
  const noahKinds = new Map<string, { kind: DomainKind; confidence: number }>([["daybookhealthcare.com", { kind: "organization", confidence: 0.95 }]]);
  // Instantly carries no tag of its own in this fixture: tag it professional by correction.
  const noahReadings = correctPointTags(
    readPoints(NOAH, noahLookups, noahKinds, new Map([["daybookhealthcare.com", DAYBOOK]]), () => null),
    [corr("tag_add", { tag: "professional_to_brand", contactPoint: "instantly:noah@daybookhealthcare.com" })],
    "brand-1",
  );

  it("the question defaults to the known company; 'another company' needs content showing one; 'any of them' only with two or more", () => {
    const one = pointOrgQuestion([daybook]);
    expect(Object.keys(one.criteria)).toEqual([DAYBOOK, ANOTHER_COMPANY]);
    expect(one.instructions).toMatch(/UNLESS/);
    // The option that licensed "unknown" for a chat naming no company is gone.
    expect(JSON.stringify(one)).not.toMatch(/nothing in it says which/);
    expect(Object.keys(pointOrgQuestion([daybook, other]).criteria)).toEqual([DAYBOOK, OTHER, ANY_KNOWN, ANOTHER_COMPANY]);
  });

  it("answers: one company, every known one, or none (another company, unsure, a legacy 'unknown')", () => {
    expect(pointOrgAnswer(DAYBOOK, 0.9, [daybook])).toEqual([{ companyId: DAYBOOK, domain: "daybookhealthcare.com", basis: "jev" }]);
    expect(pointOrgAnswer(ANY_KNOWN, 0.9, [daybook, other])!.map((c) => c.companyId)).toEqual([DAYBOOK, OTHER]);
    expect(pointOrgAnswer(ANY_KNOWN, 0.9, [daybook])).toBeNull();
    expect(pointOrgAnswer(ANOTHER_COMPANY, 0.9, [daybook])).toBeNull();
    expect(pointOrgAnswer(DAYBOOK, 0.2, [daybook])).toBeNull();
    expect(pointOrgAnswer("unknown", 1, [daybook])).toBeNull();
  });

  it("Noah: the WhatsApp chat joins the Daybook relation, no company-less sibling left", () => {
    expect(knownCompanies(noahReadings).map((k) => k.companyId)).toEqual([DAYBOOK]);
    const jev = new Map([["matrix:k-wa", pointOrgAnswer(DAYBOOK, 0.9, [daybook])]]);
    const rels = personRelations(PID, noahReadings, jev, []);
    expect(keysOf(rels)).toEqual({ [`org:${DAYBOOK}`]: ["instantly:noah@daybookhealthcare.com", "matrix:k-wa"] });
    expect(rels[0].phones).toEqual(["+15854852133"]);
  });

  it("two known companies and nothing tells which: the chat reaches both rows", () => {
    const jev = new Map([["matrix:k-wa", pointOrgAnswer(ANY_KNOWN, 0.8, [daybook, other])]]);
    const rels = personRelations(PID, noahReadings, jev, []);
    expect(keysOf(rels)[`org:${OTHER}`]).toEqual(["matrix:k-wa"]);
    expect(keysOf(rels)[`org:${DAYBOOK}`]).toContain("matrix:k-wa");
  });

  it("a PERSONAL WhatsApp is never asked and never joins a professional relation (Adam)", async () => {
    const adam = readPoints(ADAM, lookups, kinds, companyOf, () => null).filter((r) => r.source !== "gmail" && r.id !== "clerk:user_gm" && r.id !== "stripe:cus_1");
    const res = await resolvePointCompanies({ orgId: "o", brandId: "b", userId: "u", runId: "r" } as never, [{ readings: adam, known: knownCompanies(adam) }]);
    expect(res.summary.candidates).toBe(0);
    const rels = personRelations(PID, adam, new Map([["matrix:k-wa", [{ companyId: CIFACOM, domain: "cifacom.com", basis: "jev" }]]]), []);
    expect(keysOf(rels).personal).toEqual(["matrix:k-wa"]);
    expect(keysOf(rels)[`org:${CIFACOM}`]).toEqual(["clerk:user_cifa"]);
  });
});

// WA-SPLIT-RELATION-1026: MARTIAN's WhatsApp contact holds two threads (2026-10-12 LID chat, 2026-10-22 phone chat),
// one point. The reading kept only the last presence read, so Jev judged the stale 3-message thread.
describe("one contact point, several threads: one reading over all of them", () => {
  const wa = (conv: string, last: string, extra: Partial<Presence> = {}) =>
    presence("matrix", `pres-${conv}`, { phones: ["+19032259297"], lastActivityAt: last, detail: { kind: "dm", conversationId: conv, channelHandle: "@whatsapp_lid-1:x", groups: [] }, ...extra });
  const x: TagLookups = {
    ...lookups,
    conversations: new Map([
      ["matrix:new", { tags: ["professional_to_brand"], scores: scores({ professional_to_brand: 0.9 }), userIds: [] }],
      ["matrix:old", { tags: ["professional_to_brand"], scores: scores({ professional_to_brand: 0.7 }), userIds: [] }],
    ]),
  };
  it("both threads are read, the record is the latest one, whatever the order they arrive in", () => {
    const [r] = readPoints([wa("new", "2026-10-22T22:20:50Z"), wa("old", "2026-10-12T15:39:07Z", { emails: ["info@gowhite.xyz"] })], x, kinds, companyOf, () => null);
    expect(r.id).toBe("matrix:@whatsapp_lid-1:x");
    expect(r.presences).toHaveLength(2);
    expect(r.presence.detail.conversationId).toBe("new");
    expect(pointConversationKeys(r).sort()).toEqual(["matrix:new", "matrix:old"]);
    expect(r.capacity).toBe("professional");
    // The relation carries every thread's addresses, not only the last read.
    const rels = personRelations(PID, [r], new Map(), []);
    expect(rels[0].emails).toEqual(["info@gowhite.xyz"]);
  });
});
