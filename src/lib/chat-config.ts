import { ChatProvider, ChatModel } from "./chat-client.js";

/**
 * Named chat CONFIGS — never a hardcoded model at the call site.
 *
 * Each config is resolved from an env var holding `"<provider>/<model>"`, so
 * pointing a task at a different (e.g. cheaper) provider landing in chat-service
 * later is a CONFIG change on the box with ZERO code change here.
 *
 * Fails loud: an unset or malformed config throws rather than silently falling
 * back to some default model that would quietly change cost and quality.
 */

export interface ChatConfig {
  provider: ChatProvider;
  model: ChatModel;
}

const PROVIDERS: readonly ChatProvider[] = ["google", "anthropic", "zai", "deepseek"];
const MODELS: readonly ChatModel[] = [
  "flash",
  "flash-lite",
  "flash-pro",
  "pro",
  "sonnet",
  "haiku",
  "opus",
  "glm-flash",
  "deepseek-flash",
];

/** Parse a `"<provider>/<model>"` config value. Throws on anything else. */
export function parseChatConfig(envName: string, raw: string | undefined): ChatConfig {
  if (!raw || raw.trim() === "") {
    throw new Error(`[crm-service] ${envName} is required (format: "<provider>/<model>")`);
  }
  const [providerRaw, modelRaw, ...rest] = raw.trim().split("/");
  if (rest.length > 0 || !providerRaw || !modelRaw) {
    throw new Error(`[crm-service] ${envName} must be "<provider>/<model>", got: ${raw}`);
  }
  if (!(PROVIDERS as readonly string[]).includes(providerRaw)) {
    throw new Error(`[crm-service] ${envName} has unknown provider: ${providerRaw}`);
  }
  if (!(MODELS as readonly string[]).includes(modelRaw)) {
    throw new Error(`[crm-service] ${envName} has unknown model: ${modelRaw}`);
  }
  return { provider: providerRaw as ChatProvider, model: modelRaw as ChatModel };
}

/**
 * The config used to READ a Matrix conversation thread into the gold leads
 * layer (status / next step / estimated value / summary).
 */
export const LEAD_READING_CHAT_CONFIG_ENV = "CRM_LEAD_READING_CHAT_CONFIG";

export function leadReadingChatConfig(): ChatConfig {
  return parseChatConfig(
    LEAD_READING_CHAT_CONFIG_ENV,
    process.env[LEAD_READING_CHAT_CONFIG_ENV],
  );
}


/**
 * UNIBOX-TRANSLATE-1126: the config that translates a Unibox thread's messages into English (`people/translation.ts`).
 * Owner 2026-11-26: « le moins cher possible qui peut le faire ». Box value `zai/glm-flash` (GLM-5.3-Flash, $0.15 in /
 * $0.50 out per 1M), picked on real German / French Unibox messages against Claude Haiku 5.5, DeepSeek V4.1 Flash and
 * Gemini 3.5 Flash-Lite (all four translated correctly; GLM was the cheapest MEASURED).
 */
export const TRANSLATION_CHAT_CONFIG_ENV = "CRM_TRANSLATION_CHAT_CONFIG";

export function translationChatConfig(): ChatConfig {
  return parseChatConfig(TRANSLATION_CHAT_CONFIG_ENV, process.env[TRANSLATION_CHAT_CONFIG_ENV]);
}
