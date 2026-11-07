import { describe, it, expect } from "vitest";
import { batchesOf, clipText, hasWords, judgmentInput, verdictOf, type ClientMessage } from "../../src/lib/people/client-satisfaction.js";
import { LEAD_BUCKET_STEPS, OUTCOME_STEPS, STEP_FACT_TYPES } from "../../src/lib/people/outcomes.js";

const msg = (personKey: string, text: string, i = 0): ClientMessage => ({
  naturalKey: `matrix|$e${personKey}${i}`,
  personKey,
  source: "matrix",
  channel: "whatsapp",
  at: `2026-10-0${(i % 9) + 1}T10:00:00.000Z`,
  text,
  previous: null,
});

describe("CLIENT-SATISFIED-1107 client satisfaction (pure)", () => {
  it("positive only at P(positive) >= 0.75 (plain politeness sat at 0.53-0.70 in prod); otherwise the likelier of neutral / negative", () => {
    expect(verdictOf({ positive: 0.75, neutral: 0.2, negative: 0.05 }).verdict).toBe("positive");
    expect(verdictOf({ positive: 0.7, neutral: 0.2, negative: 0.1 }).verdict).toBe("neutral");
    expect(verdictOf({ positive: 0.6, neutral: 0.1, negative: 0.3 }).verdict).toBe("negative");
    expect(verdictOf({ positive: 0.49, neutral: 0.5, negative: 0.01 }).verdict).toBe("neutral");
    expect(verdictOf({ positive: 0.1, neutral: 0.2, negative: 0.7 }).verdict).toBe("negative");
    expect(verdictOf({ positive: 0.1, neutral: 0.2, negative: 0.7 }).pPositive).toBe(0.1);
  });

  it("asks one question per message, keyed m0.., the message and its context in the state", () => {
    const { state, questions } = judgmentInput([
      { ...msg("p", "You guys are amazing"), previous: { fromUs: true, text: "Your campaign is live" } },
      msg("p", "ok", 1),
    ]);
    expect(Object.keys(questions)).toEqual(["m0", "m1"]);
    expect(questions.m0.type).toBe("choice");
    expect(Object.keys(questions.m0.criteria)).toEqual(["positive", "neutral", "negative"]);
    expect(questions.m1.instructions).toContain("m1");
    const s = state as { messages: { id: string; text: string; previous: { fromUs: boolean } | null }[] };
    expect(s.messages.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(s.messages[0].previous).toEqual({ fromUs: true, text: "Your campaign is live" });
  });

  it("one person per Jev call, at most 20 messages each", () => {
    const list = [...Array.from({ length: 25 }, (_, i) => msg("a", `hi ${i}`, i)), msg("b", "great")];
    const batches = batchesOf(list);
    expect(batches.map((b) => b.length)).toEqual([20, 5, 1]);
    expect(batches.every((b) => new Set(b.map((m) => m.personKey)).size === 1)).toBe(true);
  });

  it("a message with no letter or digit is not sent to Jev; text is clipped on code points", () => {
    expect(hasWords("👍")).toBe(false);
    expect(hasWords("  ")).toBe(false);
    expect(hasWords("Merci !")).toBe(true);
    expect(clipText("😀😀😀", 2)).toBe("😀😀…");
    expect(clipText("a\uD800b", 10)).toBe("a�b");
  });

  it("client_satisfied is an outcome step but no lead-service bucket (the campaigns reach never asks for it)", () => {
    expect(OUTCOME_STEPS).toContain("client_satisfied");
    expect(LEAD_BUCKET_STEPS as readonly string[]).not.toContain("client_satisfied");
    expect(STEP_FACT_TYPES.client_satisfied).toEqual([]);
  });
});
