import { describe, it, expect } from "vitest";
import { contentHash, parseModelAnswer, readsAsEnglish } from "../../src/lib/people/translation.js";

describe("readsAsEnglish (UNIBOX-TRANSLATE-1126): only a sure English message skips the model", () => {
  it("English mail = English", () => {
    expect(readsAsEnglish("Re: First outreach email", "Hi Kevin\n\nI noticed I did not paste the link from that research.\n\nThank you")).toBe(true);
  });
  it("German or French = not English", () => {
    expect(readsAsEnglish("AW: Flohsamenschalen", "Guten Tag\n\nWir sind aktuell bereits gut mit Flohsamenschalen eingedeckt.\n\nFreundliche Grüsse")).toBe(false);
    expect(readsAsEnglish(null, "Ça y est, GTA 6 est sorti la semaine dernière. Plus de dix ans d'attente, deux reports.")).toBe(false);
  });
  it("an English reply quoting a German mail goes to the model", () => {
    expect(readsAsEnglish("Re: Muster", "Thanks a lot, we will send the sample tomorrow morning.\n\n> Guten Tag\n> Wir möchten gerne ein Gratismuster bestellen, bitte.")).toBe(false);
  });
  it("nothing readable (ok, a photo line) = not sure, goes to the model", () => {
    expect(readsAsEnglish(null, "ok")).toBe(false);
    expect(readsAsEnglish(null, "📷 Photo")).toBe(false);
  });
  it("the hash keys subject AND text", () => {
    expect(contentHash("a", "b")).not.toBe(contentHash(null, "ab"));
    expect(contentHash("a", "b")).toBe(contentHash("a", "b"));
  });
});

describe("parseModelAnswer", () => {
  const asked = { subject: "Betreff", text: "Hallo\n\nWelt" };
  it("reads the json field or the content", () => {
    const m = { messages: [{ id: "1", sourceLanguage: "DE", alreadyInTarget: false, subject: "Subject", text: "Hello\n\nWorld" }] };
    expect(parseModelAnswer(m, "", asked)).toEqual({ sourceLanguage: "de", alreadyInTarget: false, subject: "Subject", text: "Hello\n\nWorld" });
    expect(parseModelAnswer(undefined, "```json\n" + JSON.stringify(m) + "\n```", asked).text).toBe("Hello\n\nWorld");
  });
  it("refuses an answer that drops a part or holds two messages", () => {
    expect(() => parseModelAnswer({ messages: [{ id: "1", sourceLanguage: "de", alreadyInTarget: false, subject: null, text: "Hello" }] }, "", asked)).toThrow(/subject/);
    expect(() => parseModelAnswer({ messages: [] }, "", asked)).toThrow(/exactly one/);
    expect(() => parseModelAnswer(undefined, "not json", asked)).toThrow();
  });
  it("a null subject asked stays null", () => {
    const m = { messages: [{ id: "1", sourceLanguage: "fr", alreadyInTarget: false, subject: "invented", text: "Hello" }] };
    expect(parseModelAnswer(m, "", { subject: null, text: "Bonjour" }).subject).toBeNull();
  });
});
