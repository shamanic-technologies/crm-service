import { describe, it, expect } from "vitest";
import { burstVerdict, type Judgment } from "../../src/lib/reply-trigger/watch.js";

const judged = (probabilities: Record<string, number>): Judgment => ({
  status: "ok",
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
  confidence: 0.9,
  model: "jev",
  error: null,
  probabilities,
  positive: (probabilities.interested ?? 0) + (probabilities.info_requested ?? 0) + (probabilities.meeting_requested ?? 0),
});

describe("burstVerdict — only a positive answer rings positive_reply_received", () => {
  it("interested / info requested / meeting requested are reported", () => {
    expect(burstVerdict(judged({ interested: 0.9, neutral: 0.1 }))).toEqual({ report: true });
    expect(burstVerdict(judged({ info_requested: 0.8, neutral: 0.2 }))).toEqual({ report: true });
    expect(burstVerdict(judged({ meeting_requested: 0.7, interested: 0.2, neutral: 0.1 }))).toEqual({ report: true });
  });

  it("the three positive kinds are summed: split 0.3 / 0.3 is still positive", () => {
    expect(burstVerdict(judged({ interested: 0.3, info_requested: 0.3, neutral: 0.4 }))).toEqual({ report: true });
  });

  it("a refusal, a stop, a wrong person, a plain ok are not_positive", () => {
    for (const k of ["not_interested", "opt_out", "wrong_person", "neutral"]) {
      expect(burstVerdict(judged({ [k]: 0.9, interested: 0.1 }))).toEqual({ report: false, reason: "not_positive" });
    }
  });

  it("an automatic reply at 0.75+ is automated_reply; below, it is judged on positivity", () => {
    expect(burstVerdict(judged({ automated: 0.8, neutral: 0.2 }))).toEqual({ report: false, reason: "automated_reply" });
    expect(burstVerdict(judged({ automated: 0.6, neutral: 0.4 }))).toEqual({ report: false, reason: "not_positive" });
  });

  it("Jev down = reported (a person is never silenced by an unavailable judge)", () => {
    expect(burstVerdict({ status: "failed", choice: null, confidence: null, model: null, error: "timeout" })).toEqual({ report: true });
  });
});
