import { describe, it, expect } from "vitest";
import { narrowByLine } from "../../src/lib/whatsapp/line-roles.js";

const a = (loginId: string, lineRole: "assistant" | "founder" | null) => ({ loginId, lineRole });

describe("narrowByLine (SOPHIE-SENDS-1028)", () => {
  const lines = [a("33611111111", "founder"), a("33622222222", "assistant"), a("33633333333", null)];

  it("nothing stated: every line, as before", () => {
    const plain = [a("1", null), a("2", null)];
    expect(narrowByLine(plain, { fromAccountDigits: null, fromLine: null })).toEqual({ accounts: plain, by: "none" });
  });
  it("an assistant line stated: only it", () => {
    expect(narrowByLine(lines, { fromAccountDigits: null, fromLine: null })).toEqual({ accounts: [lines[1]], by: "assistant" });
  });
  it("a role asked: only the line holding it, none when not stated", () => {
    expect(narrowByLine(lines, { fromAccountDigits: null, fromLine: "founder" }).accounts).toEqual([lines[0]]);
    expect(narrowByLine([a("1", null)], { fromAccountDigits: null, fromLine: "founder" })).toEqual({ accounts: [], by: "line" });
  });
  it("a number asked wins over the assistant line", () => {
    expect(narrowByLine(lines, { fromAccountDigits: "33633333333", fromLine: null })).toEqual({ accounts: [lines[2]], by: "account" });
  });
});
