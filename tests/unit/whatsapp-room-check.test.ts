import { describe, it, expect } from "vitest";
import { expectedChannelIds, roomDeliversTo } from "../../src/lib/whatsapp/room-check.js";

const info = (channelId: string | null, receiver: string | null = "33680478702") => ({
  type: "m.bridge",
  channelId,
  receiver,
  displayname: null,
});

describe("room-check: a send only goes into a room that delivers to the resolved person", () => {
  const expected = expectedChannelIds("lid-132010718851317", "+33770657585");

  it("accepts the person's LID or phone JID on the sending login", () => {
    expect([...expected].sort()).toEqual(["132010718851317@lid", "33770657585@s.whatsapp.net"]);
    expect(roomDeliversTo([info("132010718851317@lid")], expected, "33680478702")).toEqual({ ok: true });
    expect(roomDeliversTo([info("33770657585@s.whatsapp.net", null)], expected, "+33680478702")).toEqual({ ok: true });
  });

  it("refuses the prod case: the owner's DM room whose bridge channel is James", () => {
    const v = roomDeliversTo([info("152128261730337@lid"), { ...info("152128261730337@lid"), type: "uk.half-shot.bridge" }], expected, "33680478702");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.actual).toContain("152128261730337@lid");
  });

  it("refuses a room with no bridge state, a mixed one, or another login's portal", () => {
    expect(roomDeliversTo([], expected, "33680478702").ok).toBe(false);
    expect(roomDeliversTo([info("132010718851317@lid"), info("152128261730337@lid")], expected, "33680478702").ok).toBe(false);
    expect(roomDeliversTo([info("132010718851317@lid", "33770657585")], expected, "33680478702").ok).toBe(false);
  });

  it("reads a phone-shaped resolved id as its JID", () => {
    expect(expectedChannelIds("33600000002", "+33600000002")).toEqual(new Set(["33600000002@s.whatsapp.net"]));
  });
});
