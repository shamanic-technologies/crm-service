import { describe, it, expect } from "vitest";
import { personReplied, wroteToPerson } from "../../src/lib/people/conversation.js";

const p = (source: string, inboundCount: number | null, outboundCount: number | null, detail: Record<string, unknown> = {}) => ({
  source: source as never,
  inboundCount,
  outboundCount,
  detail,
});

describe("written to / replied, read off presences", () => {
  it("a Gmail or WhatsApp message from the person is an answer; ours is a write", () => {
    expect(personReplied([p("gmail", 0, 2)])).toBe(false);
    expect(wroteToPerson([p("gmail", 0, 2)])).toBe(true);
    expect(personReplied([p("matrix", 1, 0)])).toBe(true);
  });

  it("any answer to our cold email counts, a stop included; every cold email is a write", () => {
    expect(personReplied([p("instantly", null, null, { replied: false, anyReply: true })])).toBe(true);
    expect(personReplied([p("instantly", null, null, { replied: false })])).toBe(false);
    expect(wroteToPerson([p("instantly", null, null)])).toBe(true);
  });

  it("Copilot and API use is the product being used, not a conversation", () => {
    expect(personReplied([p("copilot", 5, 5), p("api", 3, 3), p("clerk", null, null)])).toBe(false);
    expect(wroteToPerson([p("copilot", 5, 5)])).toBe(false);
  });
});
