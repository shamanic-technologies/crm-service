/**
 * HTTP client for chat-service LLM completion (POST /complete).
 *
 * crm-service uses it for work that WRITES text: reading a Matrix thread into a lead (a next step, a summary) and
 * translating a Unibox thread's messages (UNIBOX-TRANSLATE-1126, `people/translation.ts`). Every CLASSIFICATION (column typing,
 * stage meanings) goes through the judgments client instead — cheaper, and it
 * reports its own confidence.
 *
 * chat-service owns the LLM cost: it self-declares the spend against the run id
 * crm-service forwards (x-run-id = this service's own run). crm-service imports
 * NO LLM SDK and declares NO cost of its own.
 */

export type ChatProvider = "google" | "anthropic" | "zai" | "deepseek";
export type ChatModel =
  | "flash"
  | "flash-lite"
  | "flash-pro"
  | "pro"
  | "sonnet"
  | "haiku"
  | "opus"
  | "glm-flash"
  | "deepseek-flash";

export interface ChatCompleteParams {
  message: string;
  systemPrompt: string;
  provider: ChatProvider;
  model: ChatModel;
  responseFormat?: "json";
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  disableThinking?: boolean;
  /** Round-trip ceiling for THIS call (default CHAT_SERVICE_TIMEOUT_MS / 25 s). */
  timeoutMs?: number;
}

export interface ChatCompleteResult {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

/** Identity/tracking headers forwarded to chat-service for cost attribution. */
export interface ChatTrackingHeaders {
  orgId: string;
  userId: string;
  /** Outbound x-run-id: this service's own runId, not the inbound parent. */
  runId: string;
  brandIds?: string[];
}

function baseUrl(): string {
  const url = process.env.CHAT_SERVICE_URL;
  if (!url) throw new Error("[crm-service] CHAT_SERVICE_URL is required");
  return url;
}

/**
 * Hard ceiling on the /complete round-trip, so a stalled chat-service can never
 * hold a sync pass open indefinitely. Override via CHAT_SERVICE_TIMEOUT_MS.
 */
const COMPLETE_TIMEOUT_MS = Number(process.env.CHAT_SERVICE_TIMEOUT_MS) || 25_000;

function buildHeaders(tracking: ChatTrackingHeaders): Record<string, string> {
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[crm-service] CHAT_SERVICE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": tracking.orgId,
    "x-user-id": tracking.userId,
    "x-run-id": tracking.runId,
  };
  if (tracking.brandIds?.length) headers["x-brand-id"] = tracking.brandIds.join(",");
  return headers;
}

export async function chatComplete(
  params: ChatCompleteParams,
  tracking: ChatTrackingHeaders,
): Promise<ChatCompleteResult> {
  const body = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
    ...(params.responseFormat && { responseFormat: params.responseFormat }),
    ...(params.responseSchema && { responseSchema: params.responseSchema }),
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
    ...(params.disableThinking !== undefined && { disableThinking: params.disableThinking }),
  };

  const timeoutMs = params.timeoutMs ?? COMPLETE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/complete`, {
      method: "POST",
      headers: buildHeaders(tracking),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[crm-service][chat-client] POST /complete returned ${res.status}: ${text}`);
    }

    return (await res.json()) as ChatCompleteResult;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `[crm-service][chat-client] POST /complete aborted after ${timeoutMs}ms (chat-service unresponsive)`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
