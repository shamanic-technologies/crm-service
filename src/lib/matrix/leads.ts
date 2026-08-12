/**
 * GOLD — reading a conversation thread into a lead.
 *
 * This is the ONLY place an LLM touches the Matrix pipeline: bronze is verbatim
 * and silver is a deterministic aggregation. The call goes through chat-service
 * `POST /complete`, which self-declares the LLM cost against the run id we
 * forward — crm-service imports no LLM SDK, holds no provider key, and declares
 * NO cost of its own.
 *
 * The model comes from a named chat CONFIG (env), never a hardcoded id.
 */

import { chatComplete, ChatTrackingHeaders } from "../chat-client.js";
import { leadReadingChatConfig } from "../chat-config.js";
import type { ThreadLine } from "./events.js";

export const LEAD_STATUSES = [
  "new",
  "qualifying",
  "negotiating",
  "won",
  "lost",
  "unresponsive",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** How many of the most recent messages are sent to the model. */
export const THREAD_WINDOW = Number(process.env.CRM_LEAD_THREAD_WINDOW) || 60;

export interface LeadReading {
  status: LeadStatus;
  nextStep: string;
  estimatedValueUsd: number;
  summary: string;
  /** Versioned model id chat-service actually used — stored as provenance. */
  model: string;
}

const SYSTEM_PROMPT =
  "You read inbound sales conversations. Each thread is a direct-message " +
  "exchange between the business owner (outbound) and a person who contacted " +
  "them first (inbound). Report where the deal stands, the single most useful " +
  "next step for the owner, the estimated deal value in whole US dollars (0 " +
  "when the thread gives no basis for one), and a short factual summary. Do " +
  "not invent facts that are not in the thread.";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: [...LEAD_STATUSES] },
    nextStep: { type: "string" },
    estimatedValueUsd: { type: "integer" },
    summary: { type: "string" },
  },
  required: ["status", "nextStep", "estimatedValueUsd", "summary"],
};

export interface ThreadContext {
  channel: string;
  contactName: string | null;
  contactHandle: string;
  lines: ThreadLine[];
}

/**
 * One chat-service call per CHANGED conversation. Fails loud: a malformed or
 * out-of-enum reading throws instead of being silently coerced to a default.
 */
export async function readThread(
  ctx: ThreadContext,
  tracking: ChatTrackingHeaders,
): Promise<LeadReading> {
  const config = leadReadingChatConfig();

  const message = [
    `Channel: ${ctx.channel}`,
    `Contact: ${ctx.contactName ?? "(unknown name)"} (${ctx.contactHandle})`,
    "",
    "Thread (oldest first):",
    ...ctx.lines.map((l) => `[${l.at}] ${l.direction}: ${l.body}`),
  ].join("\n");

  const result = await chatComplete(
    {
      message,
      systemPrompt: SYSTEM_PROMPT,
      provider: config.provider,
      model: config.model,
      responseFormat: "json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      maxTokens: 1024,
      disableThinking: true,
    },
    tracking,
  );

  const json = result.json as Record<string, unknown> | undefined;
  if (!json) {
    throw new Error("[crm-service][matrix] lead reading: chat-service returned no json");
  }

  const status = String(json.status ?? "");
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`[crm-service][matrix] lead reading: unknown status "${status}"`);
  }
  const nextStep = json.nextStep;
  const summary = json.summary;
  const estimated = json.estimatedValueUsd;
  if (typeof nextStep !== "string" || nextStep.trim() === "") {
    throw new Error("[crm-service][matrix] lead reading: nextStep missing");
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error("[crm-service][matrix] lead reading: summary missing");
  }
  if (typeof estimated !== "number" || !Number.isFinite(estimated)) {
    throw new Error("[crm-service][matrix] lead reading: estimatedValueUsd is not a number");
  }

  return {
    status: status as LeadStatus,
    nextStep: nextStep.trim(),
    estimatedValueUsd: Math.max(0, Math.round(estimated)),
    summary: summary.trim(),
    model: result.model,
  };
}
