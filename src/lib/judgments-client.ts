/**
 * HTTP client for chat-service typed judgments (POST /orgs/judgments).
 *
 * A judgment is not a completion: the answer is a TYPE plus the model's own
 * probability distribution, served by TypeSafe's Jev. It is what a
 * classification should use — cheaper than a completion (input tokens only,
 * output is free) and it says how sure it is, which a completion does not.
 *
 * chat-service owns the model, the vendor key and the cost declaration, against
 * the run id crm-service forwards. crm-service declares no cost of its own.
 */

import type { ChatTrackingHeaders } from "./chat-client.js";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option name to its description. */
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JudgmentsResult {
  model: string;
  answers: Record<string, ChoiceAnswer>;
}

const JUDGMENTS_TIMEOUT_MS = Number(process.env.CHAT_SERVICE_JUDGMENTS_TIMEOUT_MS) || 60_000;

export async function judgeChoices(
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  tracking: ChatTrackingHeaders,
  timeoutMs: number = JUDGMENTS_TIMEOUT_MS,
): Promise<JudgmentsResult> {
  const url = process.env.CHAT_SERVICE_URL;
  if (!url) throw new Error("[crm-service] CHAT_SERVICE_URL is required");
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/orgs/judgments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[crm-service][judgments] POST /orgs/judgments returned ${res.status}: ${text}`);
    }
    return (await res.json()) as JudgmentsResult;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `[crm-service][judgments] POST /orgs/judgments aborted after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
