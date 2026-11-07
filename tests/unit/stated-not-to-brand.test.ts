import { describe, it, expect } from "vitest";
import { emailKeys, matrixContactKeys, statedEmailSets } from "../../src/lib/people/stated-not-to-brand.js";

// DUALIST-WA-SILENCE-1104: the keys a mirrored thread states are the ones the brand's statement was recorded with.
describe("matrixContactKeys", () => {
  it("a WhatsApp LID ghost: its own contact key + its handle, the same handle on every linked account", () => {
    const keys = (contactId: string) =>
      matrixContactKeys({ contactId, channel: "whatsapp", channelHandle: "@whatsapp_lid-12769105592331:matrix.distribute.you", counterpartPrefix: "@whatsapp_" });
    expect(keys("c1")).toEqual(["matrix:c1", "msg:whatsapp:12769105592331@lid"]);
    expect(keys("c2")[1]).toBe(keys("c1")[1]);
  });

  it("a known phone is a key too; a ghost outside the bridge namespace states no handle", () => {
    expect(matrixContactKeys({ contactId: "c1", channel: "whatsapp", channelHandle: "@other:hs", counterpartPrefix: "@whatsapp_", phone: "+15149523629" })).toEqual([
      "matrix:c1",
      "phone:+15149523629",
    ]);
  });

  it("emails are keyed lower-cased, blanks dropped", () => {
    expect(emailKeys(["A@B.io", null, ""])).toEqual(["email:a@b.io"]);
  });
});

// STATUS-CRM-TIMEOUT-1107: the whole answer read once; an address in a set = stated on the per-address read.
describe("statedEmailSets", () => {
  const B1 = "b1";
  const B2 = "b2";
  it("a statement's own email keys, plus every address of the brand's built person sharing a key with it", () => {
    const sets = statedEmailSets(
      [{ id: "s1", brandId: B1, personKeys: ["phone:+33611111111"] }],
      [
        { brandId: B1, identityKeys: ["email:both@x.test", "phone:+33611111111", "email:alt@x.test"] },
        { brandId: B1, identityKeys: ["email:other@x.test"] },
      ],
    );
    expect(sets).toEqual([{ correctionId: "s1", brandId: B1, emails: ["alt@x.test", "both@x.test"] }]);
  });

  it("a person of ANOTHER brand holding the same key never widens the statement", () => {
    const sets = statedEmailSets(
      [{ id: "s1", brandId: B1, personKeys: ["email:a@x.test"] }],
      [{ brandId: B2, identityKeys: ["email:a@x.test", "email:b@x.test"] }],
    );
    expect(sets[0].emails).toEqual(["a@x.test"]);
  });

  it("keeps the statements' order; a statement on a phone nobody built holds no address", () => {
    const sets = statedEmailSets(
      [
        { id: "s1", brandId: B1, personKeys: ["phone:+1"] },
        { id: "s2", brandId: B2, personKeys: ["email:z@x.test", "matrix:c1"] },
      ],
      [],
    );
    expect(sets.map((s) => [s.correctionId, s.emails])).toEqual([
      ["s1", []],
      ["s2", ["z@x.test"]],
    ]);
  });
});
