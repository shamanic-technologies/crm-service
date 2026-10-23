import { describe, it, expect } from "vitest";
import {
  coldEmailSequenceOwns,
  leadResolveItem,
  outcomeAtDetection,
  outcomeBackoffMs,
  positiveReplyOutcomeBody,
} from "../../src/lib/reply-trigger/outcome.js";
import { readEmailThreadForReply } from "../../src/lib/reply-trigger/email-thread.js";

const LEAD = "e9f0a1b2-5555-4555-8555-0000000000d1";

describe("Positive reply declaration (COST-ACCOUNTING-1023-P1)", () => {
  it("pins the outcome keys and the subject: conversation produced, message_sent consumed, on the lead-service lead", () => {
    expect(positiveReplyOutcomeBody(LEAD, true)).toEqual({
      produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: LEAD }],
      consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD }],
    });
    expect(positiveReplyOutcomeBody(LEAD, false)).toEqual({
      produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: LEAD }],
      consumed: [],
    });
  });

  it("declares only a burst Jev judged AND reported, on its judge run", () => {
    const now = 1_000;
    expect(outcomeAtDetection({ judged: true, reported: true, judgeRunId: "r", wroteBefore: true, now })).toEqual({
      judgeRunId: "r", wroteBefore: true, outcomeStatus: "pending", outcomeNextAt: new Date(now),
    });
    // Judged, not positive: the run is kept, nothing to declare.
    expect(outcomeAtDetection({ judged: true, reported: false, judgeRunId: "r", wroteBefore: true, now }).outcomeStatus).toBeNull();
    // Jev down = reported without a judgment: no occurrence of ours.
    expect(outcomeAtDetection({ judged: false, reported: true, judgeRunId: "r", wroteBefore: true, now })).toMatchObject({ judgeRunId: null, outcomeStatus: null });
  });

  it("asks lead-service with the address the person wrote from, else the person's first", () => {
    const person = { emails: ["lead@x.com", "other@x.com"], phones: [], humanId: null, presences: [] };
    expect(leadResolveItem({ orgId: "o", brandId: "b", address: "other@x.com" }, person)).toEqual({ orgId: "o", brandIds: ["b"], email: "other@x.com" });
    expect(leadResolveItem({ orgId: "o", brandId: "b", address: null }, person)).toEqual({ orgId: "o", brandIds: ["b"], email: "lead@x.com" });
    expect(leadResolveItem({ orgId: "o", brandId: "b", address: null }, { ...person, emails: [] })).toBeNull();
    // A WhatsApp writer with no email: named by human-service's id and their number.
    const HUMAN = "e9f0a1b2-5555-4555-8555-0000000000a1";
    expect(leadResolveItem({ orgId: "o", brandId: "b", address: null }, { emails: [], phones: ["33612345678", "+33612345678"], humanId: HUMAN, presences: [] })).toEqual({
      orgId: "o", brandIds: ["b"], humanId: HUMAN, phone: "+33612345678",
    });
  });

  it("a Gmail person our cold email wrote to is instantly-service's; WhatsApp stays ours", () => {
    const person = { emails: [], phones: [], humanId: null, presences: [{ source: "instantly" }] } as never;
    expect(coldEmailSequenceOwns({ source: "gmail" }, person)).toBe(true);
    expect(coldEmailSequenceOwns({ source: "matrix" }, person)).toBe(false);
  });

  it("backs off 1, 2, 4 minutes, capped at an hour", () => {
    expect([1, 2, 3, 10].map(outcomeBackoffMs)).toEqual([60_000, 120_000, 240_000, 3_600_000]);
  });

  it("an email thread says whether the mailbox wrote before the burst", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 23, 10, m));
    const msg = (k: string, m: number, direction: string) => ({ messageKey: k, at: at(m), direction, subject: "s", text: "t", to: [], threadId: null });
    expect(readEmailThreadForReply([msg("a", 1, "inbound")])).toMatchObject({ kind: "unanswered", wroteBefore: false });
    expect(readEmailThreadForReply([msg("o", 0, "outbound"), msg("a", 1, "inbound")])).toMatchObject({ kind: "unanswered", wroteBefore: true });
  });
});
