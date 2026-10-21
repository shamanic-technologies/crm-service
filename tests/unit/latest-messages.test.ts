import { describe, expect, it } from "vitest";
import { clipText, latestOf, relationStatus, type Candidate, type LatestMessage } from "../../src/lib/people/latest-messages.js";

const msg = (over: Partial<LatestMessage> = {}): LatestMessage => ({
  at: null,
  source: "instantly",
  channel: "email",
  direction: "outbound",
  sentBy: null,
  subject: null,
  text: "x",
  textBasis: "original",
  textCleanStatus: null,
  textTruncated: false,
  from: null,
  ref: {},
  ...over,
});
const cand = (at: number | null, key: string): Candidate => ({ at, key, message: msg({ text: key }) });

describe("latestOf", () => {
  it("takes the newest dated message", () => {
    expect(latestOf([cand(1, "a"), cand(3, "b"), cand(2, "c")])?.key).toBe("b");
  });
  it("breaks a tie on the same instant by identity, whatever the input order", () => {
    expect(latestOf([cand(5, "a"), cand(5, "z")])?.key).toBe("z");
    expect(latestOf([cand(5, "z"), cand(5, "a")])?.key).toBe("z");
  });
  it("answers an undated message only when nothing is dated", () => {
    expect(latestOf([cand(null, "u"), cand(1, "d")])?.key).toBe("d");
    expect(latestOf([cand(1, "d"), cand(null, "u")])?.key).toBe("d");
    expect(latestOf([cand(null, "u")])?.key).toBe("u");
  });
  it("is null on no message", () => {
    expect(latestOf([])).toBeNull();
  });
});

describe("clipText", () => {
  it("keeps a short text whole", () => {
    expect(clipText("hello", 10)).toEqual({ text: "hello", truncated: false });
  });
  it("cuts on code points, never a lone surrogate", () => {
    const r = clipText("ab😀cd", 3);
    expect(r).toEqual({ text: "ab😀", truncated: true });
  });
  it("null stays null", () => {
    expect(clipText(null)).toEqual({ text: null, truncated: false });
  });
});

describe("relationStatus", () => {
  const gap = { source: "instantly" as const, address: "a@x.com", reason: "read_failed" as const, error: "500" };
  it("a message answers message, even beside a gap", () => {
    expect(relationStatus(msg(), [gap])).toEqual({ status: "message", reason: null });
  });
  it("nothing found while a thread could not be read is unreadable, never no_message", () => {
    expect(relationStatus(null, [gap])).toEqual({ status: "unreadable", reason: "source_unreadable" });
  });
  it("nothing found and every thread read is no_message", () => {
    expect(relationStatus(null, [])).toEqual({ status: "no_message", reason: null });
  });
});
