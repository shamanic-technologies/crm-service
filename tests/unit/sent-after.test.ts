import { describe, expect, it } from "vitest";
import { sentAfterStatus, summarizeSent, type SentAfterGap, type SentMessage } from "../../src/lib/people/sent-after.js";

const m = (at: string, source: SentMessage["source"] = "matrix", channel = "whatsapp"): SentMessage => ({ at, source, channel, sentBy: null, from: null, text: null, ref: { id: at } });
const gap: SentAfterGap = { source: "instantly", address: "a@b.co", connectionId: null, reason: "read_failed", error: "502" };

describe("sentAfterStatus", () => {
  it("sent wins over gaps", () => {
    expect(sentAfterStatus([m("2026-11-02T15:08:13.678Z")], [gap])).toEqual({ status: "sent", reason: null });
  });
  it("nothing found with a gap is unreadable, never nothing_sent", () => {
    expect(sentAfterStatus([], [gap])).toEqual({ status: "unreadable", reason: "source_unreadable" });
  });
  it("nothing found, everything read: nothing_sent", () => {
    expect(sentAfterStatus([], [])).toEqual({ status: "nothing_sent", reason: null });
  });
});

describe("summarizeSent", () => {
  it("takes the earliest as firstSent, the latest time, and a window per source + channel", () => {
    const out = summarizeSent([m("2026-11-02T16:00:00.000Z", "instantly", "email"), m("2026-11-02T15:08:13.678Z"), m("2026-11-02T15:08:25.799Z")]);
    expect(out.firstSent?.at).toBe("2026-11-02T15:08:13.678Z");
    expect(out.lastSentAt).toBe("2026-11-02T16:00:00.000Z");
    expect(out.bySource).toEqual([
      { source: "matrix", channel: "whatsapp", firstAt: "2026-11-02T15:08:13.678Z", lastAt: "2026-11-02T15:08:25.799Z" },
      { source: "instantly", channel: "email", firstAt: "2026-11-02T16:00:00.000Z", lastAt: "2026-11-02T16:00:00.000Z" },
    ]);
  });
  it("is empty on nothing", () => {
    expect(summarizeSent([])).toEqual({ firstSent: null, lastSentAt: null, bySource: [] });
  });
});
