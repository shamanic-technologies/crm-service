import { describe, it, expect } from "vitest";
import {
  MAX_TWIN_GROUP,
  companyTwinPairs,
  nameTwinPairs,
  newestMessages,
  twinPairs,
  sameHumanQuestion,
  twinEvidence,
  twinName,
  twinVerdict,
  type TwinPerson,
} from "../../src/lib/people/name-twins.js";

const person = (over: Partial<TwinPerson> & { personKey: string }): TwinPerson => ({
  humanId: null,
  identityKeys: [over.personKey],
  displayName: null,
  company: null,
  emails: [],
  phones: [],
  sources: ["gmail"],
  presenceNames: [],
  companies: [],
  conversationIds: [],
  automated: false,
  groupOnly: false,
  firstActivityAt: null,
  lastActivityAt: null,
  ...over,
});

describe("twinName: a FULL name, folded, or nothing", () => {
  it.each([
    ["Lukas Stankevicius", "lukas stankevicius"],
    ["  LUKAS   Stankevičius ", "lukas stankevicius"],
    ["Dev-raj Mandroop", "dev-raj mandroop"],
  ])("%s -> %s", (raw, want) => expect(twinName(raw)).toBe(want));

  it.each(["Lukas", "Lukas (WA)", "lukas@stankamera.com", "+33 6 12 34 56 78", "", null, "Visitor from acme.com"])(
    "%s is no full name",
    (raw) => expect(twinName(raw as string | null)).toBeNull(),
  );
});

describe("nameTwinPairs: two people of the brand sharing a full name", () => {
  const lukasPro = person({
    personKey: "email:lukas@stankamera.com",
    humanId: "h1",
    displayName: "Lukas (WA)",
    presenceNames: ["Lukas Stankevicius", "Lukas (WA)"],
  });
  const lukasGmail = person({ personKey: "email:lukstan14@gmail.com", humanId: "h2", presenceNames: ["Lukas Stankevicius"] });

  it("pairs them once, keys sorted, whatever the order they come in", () => {
    const { pairs } = nameTwinPairs([lukasGmail, lukasPro]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].name).toBe("lukas stankevicius");
    expect(pairs[0].a.personKey).toBe("email:lukas@stankamera.com");
    expect(pairs[0].b.personKey).toBe("email:lukstan14@gmail.com");
  });

  it("two people human-service already holds as one human are no question", () => {
    expect(nameTwinPairs([lukasPro, { ...lukasGmail, humanId: "h1" }]).pairs).toHaveLength(0);
  });

  it("an automated sender or a silent group member is never asked about", () => {
    expect(nameTwinPairs([lukasPro, { ...lukasGmail, automated: true }]).pairs).toHaveLength(0);
    expect(nameTwinPairs([lukasPro, { ...lukasGmail, groupOnly: true }]).pairs).toHaveLength(0);
  });

  it(`a name more than ${MAX_TWIN_GROUP} people carry is too common to ask about: skipped and counted`, () => {
    const many = Array.from({ length: MAX_TWIN_GROUP + 1 }, (_, i) =>
      person({ personKey: `email:j${i}@x.com`, humanId: `h${i}`, presenceNames: ["John Smith"] }),
    );
    const r = nameTwinPairs(many);
    expect(r.pairs).toHaveLength(0);
    expect(r.commonNamesSkipped).toBe(1);
    const few = nameTwinPairs(many.slice(0, 3));
    expect(few.pairs).toHaveLength(3);
  });
});

describe("sameHumanQuestion", () => {
  const a = person({ personKey: "email:lukas@stankamera.com", identityKeys: ["email:lukas@stankamera.com"], emails: ["lukas@stankamera.com"] });
  const b = person({ personKey: "email:lukstan14@gmail.com", identityKeys: ["email:lukstan14@gmail.com"], emails: ["lukstan14@gmail.com"] });

  it("one choice, same_human | different_humans, both cards in the state", () => {
    const q = sameHumanQuestion({ name: "lukas stankevicius", a, b }, { a: [], b: [{ at: "2026-10-22T10:00:00.000Z", direction: "inbound", subject: "Re: call", text: "Perfect, talk soon in 25min" }] }, "Distribute.you");
    expect(Object.keys(q.question.criteria).sort()).toEqual(["different_humans", "same_human"]);
    expect(JSON.stringify(q.state)).toContain("lukstan14@gmail.com");
    expect(JSON.stringify(q.state)).toContain("talk soon in 25min");
  });

  it("the hash keys on who the two are (their keys and the name), never on new messages", () => {
    const h1 = sameHumanQuestion({ name: "lukas stankevicius", a, b }, { a: [], b: [] }, "X").hash;
    const h2 = sameHumanQuestion({ name: "lukas stankevicius", a, b }, { a: [{ at: null, direction: "inbound", subject: null, text: "hi" }], b: [] }, "X").hash;
    const h3 = sameHumanQuestion({ name: "lukas stankevicius", a: { ...a, identityKeys: [...a.identityKeys, "phone:+33611111111"] }, b }, { a: [], b: [] }, "X").hash;
    expect(h2).toBe(h1);
    expect(h3).not.toBe(h1);
  });
});

describe("twinVerdict: same from 50% sure (owner 2026-10-14)", () => {
  it.each([
    [0.5, "same"],
    [0.49, "different"],
    [0.9, "same"],
  ])("P(same)=%s -> %s", (p, want) =>
    expect(twinVerdict({ type: "choice", choice: "x", confidence: 1, probabilities: { same_human: p, different_humans: 1 - p } })).toBe(want),
  );
});

describe("twinEvidence: a same verdict ties every key both people held", () => {
  it("is a judgment of Jev, both sides stated", () => {
    const e = twinEvidence({
      id: "v1",
      keysA: ["email:lukas@stankamera.com", "matrix:ee06"],
      keysB: ["email:lukstan14@gmail.com"],
    });
    expect(e).toMatchObject({
      kind: "name_twin",
      ref: "v1",
      judgedBy: "jev",
      emails: ["lukas@stankamera.com", "lukstan14@gmail.com"],
      keys: ["email:lukas@stankamera.com", "email:lukstan14@gmail.com", "matrix:ee06"],
      sides: [
        { emails: ["lukas@stankamera.com"], phones: [] },
        { emails: ["lukstan14@gmail.com"], phones: [] },
      ],
    });
  });
});

describe("companyTwinPairs: one human, two names, the same small company (ZARINA-CLIENT-AS-PROSPECT-1104)", () => {
  const living = { companyId: "c-living", domain: "livingvital.ch" };
  // Her company mailbox, signed "Zarina Birnbacher, LivingVital".
  const mailbox = person({ personKey: "email:info@livingvital.ch", humanId: "h1", displayName: "Aronia Vital", companies: [living] });
  // Her signup + payment + WhatsApp, a Gmail; company from the Clerk organization she created.
  const account = person({
    personKey: "email:marketingaronia@gmail.com",
    humanId: "h2",
    displayName: "Living Vital",
    phones: ["+41799389795"],
    sources: ["matrix", "posthog", "stripe", "clerk"],
    companies: [living],
    conversationIds: ["conv-wa"],
  });

  it("different names, different addresses, one company: asked once", () => {
    const { pairs } = companyTwinPairs([account, mailbox]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ basis: "company", name: "company:livingvital.ch" });
    expect(pairs[0].a.personKey).toBe("email:info@livingvital.ch");
  });

  it("already one human, no company, automated or group-only = no question", () => {
    expect(companyTwinPairs([mailbox, { ...account, humanId: "h1" }]).pairs).toHaveLength(0);
    expect(companyTwinPairs([mailbox, { ...account, companies: [] }]).pairs).toHaveLength(0);
    expect(companyTwinPairs([mailbox, { ...account, automated: true }]).pairs).toHaveLength(0);
  });

  it("a company more than MAX_TWIN_GROUP people speak for is colleagues: never asked", () => {
    const staff = Array.from({ length: MAX_TWIN_GROUP + 1 }, (_, i) => person({ personKey: `email:p${i}@acme.com`, companies: [{ companyId: "c-acme", domain: "acme.com" }] }));
    expect(companyTwinPairs(staff)).toEqual({ pairs: [], largeCompaniesSkipped: 1 });
  });

  it("a pair sharing a full name AND a company is asked once, as a name twin", () => {
    const a = person({ personKey: "email:jo@acme.com", presenceNames: ["Jo Smith"], companies: [{ companyId: "c", domain: "acme.com" }] });
    const b = person({ personKey: "email:jo.smith@gmail.com", presenceNames: ["Jo Smith"], companies: [{ companyId: "c", domain: "acme.com" }] });
    const { pairs } = twinPairs([a, b]);
    expect(pairs.map((p) => p.basis)).toEqual(["name"]);
  });

  it("Jev sees the shared company, each side's company domains, sources and its chat messages", () => {
    const [pair] = companyTwinPairs([account, mailbox]).pairs;
    const messages = {
      a: [{ at: "2026-10-20T10:00:00Z", direction: "inbound", subject: "Campaign", text: "Thanks!\nZarina Birnbacher\nLivingVital\nwww.livingvital.ch" }],
      b: [{ at: "2026-10-14T09:42:00Z", direction: "inbound", subject: null, text: "I added the $400 credits" }],
    };
    const { state, question, hash } = sameHumanQuestion(pair, messages, "distribute.you");
    const s = state as { sharedCompany: string; personA: Record<string, unknown>; personB: Record<string, unknown> };
    expect(s.sharedCompany).toBe("livingvital.ch");
    expect(s.personA).toMatchObject({ names: ["Aronia Vital"], addresses: [], companyDomains: ["livingvital.ch"], latestMessages: messages.a });
    expect(s.personB).toMatchObject({ names: ["Living Vital"], seenOn: ["matrix", "posthog", "stripe", "clerk"], latestMessages: messages.b });
    expect(question.type).toBe("choice");
    expect(Object.keys((question as { criteria: object }).criteria)).toEqual(["same_human", "different_humans"]);
    expect(question.instructions).toContain("livingvital.ch");
    // The verdict is keyed on who the two are, never on their messages.
    expect(sameHumanQuestion(pair, { a: [], b: [] }, null).hash).toBe(hash);
  });

  it("newestMessages: Gmail and chat merged, newest first, 3 at most", () => {
    const m = (at: string) => ({ at, direction: "inbound", subject: null, text: at });
    expect(newestMessages([[m("2026-01-01"), m("2026-03-01")], [m("2026-02-01"), m("2026-04-01")]]).map((x) => x.at)).toEqual([
      "2026-04-01",
      "2026-03-01",
      "2026-02-01",
    ]);
  });
});
