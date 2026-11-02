import { describe, it, expect } from "vitest";
import { composeAssistantPingText, isAssistantAccountType } from "../../src/lib/assistant-pings.js";
import { splitTelegramText, TELEGRAM_MESSAGE_MAX } from "../../src/lib/owner-telegram.js";

/** SOPHIE-ONLY-TG-1102: only the AI's lines ping the owner, and every ping carries the whole message. */
describe("which linked account is the assistant", () => {
  it("only an account typed pro_ai; a human's line (pro or personal) or an untyped one never", () => {
    expect(isAssistantAccountType("pro_ai")).toBe(true);
    expect(isAssistantAccountType("pro_human")).toBe(false);
    expect(isAssistantAccountType("personal_human")).toBe(false);
    expect(isAssistantAccountType(null)).toBe(false);
  });
});

describe("the ping carries the whole message", () => {
  const base = {
    channel: "whatsapp",
    direction: "inbound" as const,
    assistantName: "Sophie",
    name: "Jane Doe",
    phone: "+33612345678",
    email: null,
    orgName: null,
    threadUrl: "https://dashboard.distribute.you/v2/x",
  };

  it("a 6,000-char message is never clipped and goes out as 2 Telegram messages, nothing dropped", () => {
    const long = Array.from({ length: 700 }, (_, i) => `word${i}`).join(" ").padEnd(6000, "z");
    expect([...long].length).toBe(6000);
    const text = composeAssistantPingText({ ...base, text: long });
    expect(text).toContain(long);
    expect(text).not.toContain("…");
    const parts = splitTelegramText(text);
    expect(parts).toHaveLength(2);
    for (const p of parts) expect([...p].length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
    expect(parts.join(" ")).toBe(text);
  });

  it("keeps the message's own line breaks", () => {
    expect(composeAssistantPingText({ ...base, text: "line one\n\nline two" })).toContain('Message: "line one\n\nline two"');
  });
});

describe("splitTelegramText", () => {
  it("a short text is one part", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
  });

  it("cuts on a line break, else a space, else hard on code points; the parts give the text back", () => {
    expect(splitTelegramText("aaaaaa\nbbbb", 8)).toEqual(["aaaaaa", "bbbb"]);
    expect(splitTelegramText("aaaaaa bbbb", 8)).toEqual(["aaaaaa", "bbbb"]);
    expect(splitTelegramText("😀".repeat(10), 4)).toEqual(["😀😀😀😀", "😀😀😀😀", "😀😀"]);
  });
});
