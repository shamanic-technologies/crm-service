import { describe, it, expect } from "vitest";
import { emailKeys, matrixContactKeys } from "../../src/lib/people/stated-not-to-brand.js";

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
