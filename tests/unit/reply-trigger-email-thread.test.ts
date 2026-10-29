import { describe, it, expect } from "vitest";
import { readEmailThreadForReply, type StoredEmail } from "../../src/lib/reply-trigger/email-thread.js";
import { gmailIdempotencyKey, gmailReplyBody } from "../../src/lib/reply-trigger/gmail.js";

const m = (key: string, minute: number, direction: string, text: string | null = "hi", subject: string | null = null): StoredEmail => ({
  messageKey: key, at: new Date(Date.UTC(2026, 9, 15, 10, minute)), direction, subject, text, to: [], threadId: "t",
});

describe("readEmailThreadForReply", () => {
  it("the person's mails since our last outbound are one burst", () => {
    const r = readEmailThreadForReply([m("a", 1, "inbound"), m("o", 2, "outbound"), m("b", 3, "inbound"), m("c", 4, "inbound")]);
    expect(r.kind === "unanswered" && r.burst.map((x) => x.messageId)).toEqual(["b", "c"]);
  });
  it("our last word means nobody is waiting", () => {
    expect(readEmailThreadForReply([m("a", 1, "inbound"), m("o", 2, "outbound")])).toEqual({ kind: "answered" });
  });
  it("third-party mails, undated mails and empty mails are not words from the person", () => {
    const r = readEmailThreadForReply([m("x", 1, "other"), { ...m("u", 2, "inbound"), at: null }, m("e", 3, "inbound", "  ", null)]);
    expect(r).toEqual({ kind: "answered" });
  });
  it("order is by send time, whatever order the store returns", () => {
    const r = readEmailThreadForReply([m("b", 5, "inbound"), m("o", 3, "outbound"), m("a", 1, "inbound")]);
    expect(r.kind === "unanswered" && r.burst.map((x) => x.messageId)).toEqual(["b"]);
  });
  it("a subject-only mail counts, its subject is its text", () => {
    const r = readEmailThreadForReply([m("s", 1, "inbound", null, "Call me")]);
    expect(r.kind === "unanswered" && r.burst[0].text).toBe("Call me");
  });
});

describe("gmailReplyBody", () => {
  it("is brand-scoped in its idempotency key and omits absent values", () => {
    const body = gmailReplyBody({
      triggerId: "message_received",
      brandId: "b1", offerId: "o1", anchorMessageId: "m1",
      person: { email: "qa@distribute.you", name: null, phone: null, personId: null },
      messages: [{ messageId: "m1", at: "2026-10-15T10:00:00.000Z", subject: "s", text: "t", to: [], threadId: "t1" }],
    });
    expect(body.idempotencyKey).toBe(gmailIdempotencyKey("b1", "m1"));
    expect(body.triggerId).toBe("message_received");
    expect(body.person).toEqual({ email: "qa@distribute.you" });
    expect(body.item).toMatchObject({ source: "gmail", channel: "email", threadId: "t1", campaignId: null });
  });
});
