import { describe, it, expect, afterEach } from "vitest";
import {
  LEAD_READING_CHAT_CONFIG_ENV,
  leadReadingChatConfig,
  parseChatConfig,
} from "../../src/lib/chat-config.js";

describe("parseChatConfig", () => {
  it("parses a provider/model config", () => {
    expect(parseChatConfig("X", "anthropic/haiku")).toEqual({
      provider: "anthropic",
      model: "haiku",
    });
    expect(parseChatConfig("X", "google/flash-lite")).toEqual({
      provider: "google",
      model: "flash-lite",
    });
  });

  it("fails loud instead of defaulting to some model", () => {
    expect(() => parseChatConfig("X", undefined)).toThrow(/X is required/);
    expect(() => parseChatConfig("X", "")).toThrow(/X is required/);
    expect(() => parseChatConfig("X", "haiku")).toThrow(/must be "<provider>\/<model>"/);
    expect(() => parseChatConfig("X", "openai/gpt")).toThrow(/unknown provider/);
    expect(() => parseChatConfig("X", "anthropic/nope")).toThrow(/unknown model/);
  });
});

describe("leadReadingChatConfig", () => {
  const original = process.env[LEAD_READING_CHAT_CONFIG_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LEAD_READING_CHAT_CONFIG_ENV];
    else process.env[LEAD_READING_CHAT_CONFIG_ENV] = original;
  });

  it("reads the model from config, so switching provider needs no code change", () => {
    process.env[LEAD_READING_CHAT_CONFIG_ENV] = "google/flash";
    expect(leadReadingChatConfig()).toEqual({ provider: "google", model: "flash" });
    process.env[LEAD_READING_CHAT_CONFIG_ENV] = "anthropic/haiku";
    expect(leadReadingChatConfig()).toEqual({ provider: "anthropic", model: "haiku" });
  });
});
