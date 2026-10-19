import { describe, expect, it } from "vitest";
import { factKeysOf } from "../../src/lib/people/fact-ids.js";
import { itemKey, type TimelineItem } from "../../src/lib/people/timeline.js";

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  at: "2026-10-15T18:01:55.000Z", source: "matrix", channel: "whatsapp", kind: "message", direction: "outbound",
  subject: null, text: "hi", from: "@crm_x:hs", to: [], ref: {}, textClean: null, outreachFact: null, event: null, ...over,
});

describe("factKeysOf (UNIBOX-FACT-ID-1019)", () => {
  it("a Matrix message is the fact matrix|<event id>, both directions", () => {
    expect(factKeysOf(item({ ref: { eventId: "$e1", roomId: "!r" } }), [])).toEqual(["matrix|$e1"]);
    expect(factKeysOf(item({ direction: "inbound", ref: { eventId: "$e2" } }), [])).toEqual(["matrix|$e2"]);
  });

  it("a Gmail message keys on the person's address on its side first, then every other address", () => {
    const out = item({ source: "gmail", channel: "email", from: "me@brand.com", to: ["B@x.com"], ref: { gmailMessageId: "m1" } });
    expect(factKeysOf(out, ["a@x.com", "b@x.com"])).toEqual(["gmail|b@x.com|m1", "gmail|a@x.com|m1"]);
    const inbound = item({ source: "gmail", channel: "email", direction: "inbound", from: "a@x.com", to: ["me@brand.com"], ref: { gmailMessageId: "m2" } });
    expect(factKeysOf(inbound, ["b@x.com", "a@x.com"])).toEqual(["gmail|a@x.com|m2", "gmail|b@x.com|m2"]);
  });

  it("anything that is no message fact keys on nothing", () => {
    expect(factKeysOf(item({ kind: "event", direction: null, ref: { eventId: "$e" } }), [])).toEqual([]);
    expect(factKeysOf(item({ source: "gmail", direction: "other", ref: { gmailMessageId: "m" } }), ["a@x.com"])).toEqual([]);
    expect(factKeysOf(item({ source: "instantly", channel: "email", ref: { campaignId: "c" } }), ["a@x.com"])).toEqual([]);
    expect(factKeysOf(item({ source: "api", channel: "api", ref: { callId: "c" } }), ["a@x.com"])).toEqual([]);
    expect(factKeysOf(item({ source: "copilot", channel: "chat", ref: { messageId: "m" } }), ["a@x.com"])).toEqual([]);
  });

  it("factId never moves an item's page position", () => {
    const a = item({ ref: { eventId: "$e1" } });
    const b = item({ ref: { eventId: "$e1", factId: "7a4d71b7-5200-4ea1-a733-77529a171596" } });
    expect(itemKey(b)).toBe(itemKey(a));
  });
});
