/**
 * The mautrix bridges' PROVISIONING API (bridgev2, `/_matrix/provision/v3`) —
 * how a self-serve link starts, waits and ends. Contract checked against the
 * deployed mautrix-whatsapp v26.07 on the box, 2026-10-01.
 *
 * Auth is the bridge's shared secret plus `?user_id=<the brand's account>`; the
 * secret never leaves this service. Every call here manages a LOGIN — there is
 * no message, room or contact call in this module, by design.
 *
 * A channel is linkable only when its bridge's provisioning URL + secret are
 * configured. Telegram's bridge needs a platform Telegram app credential
 * (api_id / api_hash) that is not provisioned yet, so it is not started and its
 * env is absent: Telegram answers "not available yet" until it is.
 */

import type { MatrixChannel } from "./events.js";
import { accountProvisioningConfigured } from "./account.js";

/** The bridge's ghost-user namespace per channel — routes a room to a connection. */
export const COUNTERPART_PREFIX: Record<MatrixChannel, string> = {
  whatsapp: "@whatsapp_",
  telegram: "@telegram_",
  discord: "@discord_",
};

const CHANNEL_LABEL: Record<MatrixChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
};

/** What a link may use on each channel (bridgev2 login flow ids). */
export const LINK_METHODS = ["qr", "phone"] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

interface BridgeConfig {
  url: string;
  secret: string;
}

function bridgeConfig(channel: MatrixChannel): BridgeConfig | null {
  const key = channel.toUpperCase();
  const url = process.env[`MATRIX_${key}_PROVISIONING_URL`];
  const secret = process.env[`MATRIX_${key}_PROVISIONING_SECRET`];
  if (!url || !secret) return null;
  return { url: url.replace(/\/+$/, ""), secret };
}

export interface ChannelAvailability {
  available: boolean;
  /** Present when `available` is false: why, in words a customer can read. */
  unavailableReason: string | null;
}

export function channelAvailability(channel: MatrixChannel): ChannelAvailability {
  if (!accountProvisioningConfigured() || !bridgeConfig(channel)) {
    return {
      available: false,
      unavailableReason: `Linking ${CHANNEL_LABEL[channel]} is not available yet.`,
    };
  }
  return { available: true, unavailableReason: null };
}

/** A refusal from the bridge, carrying ITS OWN code + message verbatim. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly bridgeMessage: string,
  ) {
    super(`[crm-service][bridge] ${status} ${code}: ${bridgeMessage}`);
  }
  /** 4xx = the bridge (or WhatsApp behind it) refused; 5xx/transport = it broke. */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** A login step as bridgev2 serves it (`RespSubmitLogin`). */
export interface LoginStep {
  login_id: string;
  type: "display_and_wait" | "user_input" | "cookies" | "webauthn" | "complete" | string;
  step_id: string;
  instructions?: string;
  display_and_wait?: { type: "qr" | "code" | "emoji" | "nothing" | string; data?: string };
  user_input?: { fields?: { type: string; id: string }[] };
  complete?: { user_login_id?: string };
}

export interface BridgeLogin {
  id: string;
  name: string;
  state: { state_event?: string; reason?: string; error?: string; message?: string } | null;
}

/** How long one display_and_wait may block: WhatsApp refreshes a QR every ≤60s. */
const WAIT_TIMEOUT_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 45_000;

async function call<T>(
  channel: MatrixChannel,
  userId: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const cfg = bridgeConfig(channel);
  if (!cfg) throw new BridgeError(503, "CHANNEL_UNAVAILABLE", channelAvailability(channel).unavailableReason!);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${cfg.url}/_matrix/provision/v3${path}?user_id=${encodeURIComponent(userId)}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${cfg.secret}`, "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new BridgeError(res.status || 502, "BRIDGE_NON_JSON", text.slice(0, 300));
    }
    if (!res.ok) {
      throw new BridgeError(
        res.status,
        typeof parsed.errcode === "string" ? parsed.errcode : "BRIDGE_ERROR",
        typeof parsed.error === "string" ? parsed.error : text.slice(0, 300),
      );
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new BridgeError(504, "BRIDGE_TIMEOUT", `bridge did not answer within ${timeoutMs}ms`);
    }
    throw new BridgeError(502, "BRIDGE_UNREACHABLE", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export function startLogin(channel: MatrixChannel, userId: string, method: LinkMethod) {
  return call<LoginStep>(channel, userId, "POST", `/login/start/${method}`, {}, CALL_TIMEOUT_MS);
}

export function submitUserInput(
  channel: MatrixChannel,
  userId: string,
  step: LoginStep,
  input: Record<string, string>,
) {
  return call<LoginStep>(
    channel,
    userId,
    "POST",
    `/login/step/${encodeURIComponent(step.login_id)}/${encodeURIComponent(step.step_id)}/user_input`,
    input,
    CALL_TIMEOUT_MS,
  );
}

/** Blocks until the bridge has a NEXT step: a refreshed code, completion, or an error. */
export function waitForNextStep(channel: MatrixChannel, userId: string, step: LoginStep) {
  return call<LoginStep>(
    channel,
    userId,
    "POST",
    `/login/step/${encodeURIComponent(step.login_id)}/${encodeURIComponent(step.step_id)}/display_and_wait`,
    {},
    WAIT_TIMEOUT_MS,
  );
}

export async function cancelLogin(channel: MatrixChannel, userId: string, processId: string) {
  try {
    await call(channel, userId, "POST", `/login/cancel/${encodeURIComponent(processId)}`, {}, CALL_TIMEOUT_MS);
  } catch (err) {
    // 404 = the bridge no longer has that process (finished, timed out, restarted).
    if (err instanceof BridgeError && err.status === 404) return;
    throw err;
  }
}

/** Log the account's bridge login(s) out — the bridge stops receiving its DMs. */
export async function logoutAll(channel: MatrixChannel, userId: string) {
  await call(channel, userId, "POST", "/logout/all", {}, CALL_TIMEOUT_MS);
}

/** The account's live bridge logins, with the bridge's own connection state. */
export async function bridgeLogins(channel: MatrixChannel, userId: string): Promise<BridgeLogin[]> {
  const resp = await call<{ logins?: { id: string; name?: string; state?: BridgeLogin["state"] }[] }>(
    channel,
    userId,
    "GET",
    "/whoami",
    undefined,
    CALL_TIMEOUT_MS,
  );
  return (resp.logins ?? []).map((l) => ({ id: l.id, name: l.name ?? "", state: l.state ?? null }));
}
