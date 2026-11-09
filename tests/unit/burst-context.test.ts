import { describe, it, expect } from "vitest";
import { burstJudgeState, chatThreadLines, emailThreadLines, fitThread, type BurstThreadLine } from "../../src/lib/reply-trigger/burst-context.js";
import { REPLY_KINDS, burstVerdict } from "../../src/lib/reply-trigger/watch.js";

const business = {
  brand: { name: "Distribute.you", website: "distribute.you", description: "Sales meetings for B2B founders." },
  offers: [{ offerId: "o", name: "Agency", whatWeOffer: "Sales meetings" }],
  otherBrandsOfTheSameOwner: [],
  hash: "h",
};

describe("JEV-WHOLE-THREAD-1109: what Jev reads to judge a burst", () => {
  it("the Chaim case: the whole mail thread with From / To, the client's reply-all to HIS prospect marked new", () => {
    const at = (s: string) => new Date(s);
    const lines = emailThreadLines(
      [
        { messageKey: "m3", at: at("2026-11-08T17:53:17Z"), direction: "inbound", from: "chaim@beyondlogic.tech", to: ["k.lourd@hellodistribute.com"], subject: "Re: custom software builds", text: "Hi Mario, happy to scope it. - Chaim" },
        { messageKey: "m1", at: at("2026-11-05T03:23:33Z"), direction: "other", from: "k.lourd@hellodistribute.com", to: ["mario@applandtech.com"], subject: "Re: custom software builds", text: "Yes, Beyond Logic provides a written project scope." },
        { messageKey: "empty", at: at("2026-11-06T00:00:00Z"), direction: "other", from: "x@y.z", to: [], subject: null, text: "  " },
      ],
      new Set(["m3"]),
    );
    const state = burstJudgeState("email", { business, person: { name: "Chaim Tesser", email: "chaim@beyondlogic.tech" }, thread: lines }) as {
      business: { name: string };
      thread: Record<string, unknown>[];
    };
    expect(state.business.name).toBe("Distribute.you");
    expect(state.thread).toEqual([
      { at: "2026-11-05T03:23:33.000Z", writtenBy: "not the person", from: "k.lourd@hellodistribute.com", to: ["mario@applandtech.com"], subject: "Re: custom software builds", text: "Yes, Beyond Logic provides a written project scope." },
      { at: "2026-11-08T17:53:17.000Z", writtenBy: "the person", from: "chaim@beyondlogic.tech", to: ["k.lourd@hellodistribute.com"], subject: "Re: custom software builds", text: "Hi Mario, happy to scope it. - Chaim", new: true },
    ]);
  });

  it("a chat thread keeps every worded message, oldest first", () => {
    const lines = chatThreadLines(
      [
        { eventId: "b", at: 2, byThePerson: true, text: "how much?" },
        { eventId: "a", at: 1, byThePerson: false, text: "Hi, we book meetings" },
        { eventId: "c", at: 3, byThePerson: true, text: " " },
      ],
      new Set(["b"]),
    );
    expect(lines.map((l) => [l.text, l.byThePerson, l.new ?? false])).toEqual([
      ["Hi, we book meetings", false, false],
      ["how much?", true, true],
    ]);
  });

  it("the thread is cut to Jev's context: the oldest go first, the new ones never", () => {
    const line = (i: number, isNew = false): BurstThreadLine => ({ at: null, byThePerson: true, text: `m${i} ${"x".repeat(1000)}`, ...(isNew ? { new: true } : {}) });
    const thread = [...Array.from({ length: 10 }, (_, i) => line(i)), line(10, true)];
    const { lines, olderOmitted } = fitThread(thread, 4 * 1300);
    expect(lines.map((l) => l.text.split(" ")[0])).toEqual(["m7", "m8", "m9", "m10"]);
    expect(olderOmitted).toBe(7);
  });

  it("Jev's 'not written to this business' skips the burst; a positive reply still rings", () => {
    expect(REPLY_KINDS).toContain("not_to_business");
    expect(burstVerdict({ status: "ok", choice: "not_to_business", confidence: 0.8, model: "jev", error: null, probabilities: { not_to_business: 0.85, interested: 0.1 }, positive: 0.1 })).toEqual({
      report: false,
      reason: "not_to_business",
    });
    expect(burstVerdict({ status: "ok", choice: "interested", confidence: 0.8, model: "jev", error: null, probabilities: { not_to_business: 0.1, interested: 0.89 }, positive: 0.89 })).toMatchObject({ report: true, positive: true });
  });
});
