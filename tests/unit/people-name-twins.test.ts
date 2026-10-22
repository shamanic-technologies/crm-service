import { describe, it, expect } from "vitest";
import {
  MAX_TWIN_GROUP,
  nameTwinPairs,
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
