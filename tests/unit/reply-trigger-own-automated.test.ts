import { describe, it, expect } from "vitest";
import { automatedEchoes, ECHO_AFTER_MS, ECHO_BEFORE_MS } from "../../src/lib/reply-trigger/own-automated.js";

const at = Date.parse("2026-10-23T03:19:57.963Z");
const msg = (eventId: string, t: number, text: string) => ({ eventId, at: new Date(t).toISOString(), text });

describe("automatedEchoes (SOPHIE-BOT-LOOP-1023)", () => {
  const sends = [{ text: "Sorry, something went wrong on my side.", at: new Date(at) }];

  it("the same text received around our send to this account is ours (prod: -0.44 s to +0.3 s)", () => {
    const out = automatedEchoes([msg("$a", at - 440, "Sorry, something went wrong on my side."), msg("$b", at + 300, " Sorry, something went wrong on my side. ")], sends);
    expect([...out]).toEqual(["$a", "$b"]);
  });

  it("other words, or the same words far from the send, are a person's", () => {
    const out = automatedEchoes(
      [
        msg("$x", at + 1000, "Hi Sophie"),
        msg("$y", at + ECHO_BEFORE_MS + 1, "Sorry, something went wrong on my side."),
        msg("$z", at - ECHO_AFTER_MS - 1, "Sorry, something went wrong on my side."),
      ],
      sends,
    );
    expect(out.size).toBe(0);
  });

  it("no send = nothing is ours", () => {
    expect(automatedEchoes([msg("$a", at, "Sorry, something went wrong on my side.")], []).size).toBe(0);
  });
});
