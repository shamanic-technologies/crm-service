/**
 * The mautrix bridges' PROVISIONING API (bridgev2, `/_matrix/provision/v3`) —
 * how a self-serve link starts, waits and ends. Contract checked against the
 * deployed mautrix-whatsapp v26.07 on the box, 2026-10-01.
 *
 * Auth is the bridge's shared secret plus `?user_id=<the brand's account>`; the
 * secret never leaves this service. Every call here manages a LOGIN, except the
 * two a WhatsApp SEND needs (`resolveIdentifier`, `createDm`: owner 2026-10-12,
 * a campaign writes first from the brand's linked number). Neither sends
 * anything: the message itself goes through the Matrix client-server API
 * (`client.ts` `sendText`).
 *
 * A channel is linkable only when its bridge's provisioning URL + secret are
 * configured. Telegram's bridge needs a platform Telegram app credential
 * (api_id / api_hash) that is not provisioned yet, so it is not started and its
 * env is absent: Telegram answers "not available yet" until it is.
 *
 * LinkedIn (mautrix-linkedin, bridgev2) has no QR: its flows are `password`
 * (email/phone + password, then possibly a 6-digit code LinkedIn emails) and
 * `cookies` (the browser's session headers). Both are USER INPUT steps the
 * bridge describes field by field; the link records the step and the user's
 * answer is relayed back (contract read from the deployed bridge, 2026-10-10).
 */

import type { MatrixChannel } from "./events.js";
import { accountProvisioningConfigured } from "./account.js";

/** The bridge's ghost-user namespace per channel — routes a room to a connection. */
export const COUNTERPART_PREFIX: Record<MatrixChannel, string> = {
  whatsapp: "@whatsapp_",
  telegram: "@telegram_",
  discord: "@discord_",
  linkedin: "@linkedin_",
};

const CHANNEL_LABEL: Record<MatrixChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  linkedin: "LinkedIn",
};

/** Every login method any channel offers (bridgev2 login flow ids). */
export const LINK_METHODS = ["qr", "phone", "password", "cookies"] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

/** The flows each channel's bridge serves, in the order the dashboard should offer them. */
export const CHANNEL_METHODS: Record<MatrixChannel, readonly LinkMethod[]> = {
  whatsapp: ["qr", "phone"],
  telegram: ["qr", "phone"],
  discord: ["qr"],
  linkedin: ["password", "cookies"],
};

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

/** One field of a user_input step, as bridgev2 describes it. */
export interface LoginInputField {
  type: string;
  id: string;
  name?: string;
  description?: string;
  pattern?: string;
  options?: string[];
  default_value?: string;
}

/** One value of a cookies step: where the browser holds it (cookie, header, local storage…). */
export interface LoginCookieField {
  id: string;
  required?: boolean;
  sources?: { type: string; name: string; cookie_domain?: string }[];
  pattern?: string;
}

/** A login step as bridgev2 serves it (`RespSubmitLogin`). */
export interface LoginStep {
  login_id: string;
  type: "display_and_wait" | "user_input" | "cookies" | "webauthn" | "complete" | string;
  step_id: string;
  instructions?: string;
  display_and_wait?: { type: "qr" | "code" | "emoji" | "nothing" | string; data?: string };
  user_input?: { fields?: LoginInputField[] };
  cookies?: { url?: string; user_agent?: string; fields?: LoginCookieField[]; extract_js?: string };
  complete?: { user_login_id?: string };
}

/** Steps whose answer comes from the USER, relayed by `submitStepInput`. */
export const INPUT_STEP_TYPES = ["user_input", "cookies"] as const;
export function isInputStep(step: LoginStep): boolean {
  return (INPUT_STEP_TYPES as readonly string[]).includes(step.type);
}

export interface BridgeLogin {
  id: string;
  name: string;
  state: {
    state_event?: string;
    reason?: string;
    error?: string;
    message?: string;
    /** Unix SECONDS the bridge stated it. */
    timestamp?: number;
    /** WhatsApp: `reachout_timelock_until` (ISO) = WhatsApp limits the number from writing to new people. */
    info?: Record<string, unknown>;
  } | null;
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
  extraQuery: Record<string, string> = {},
): Promise<T> {
  const cfg = bridgeConfig(channel);
  if (!cfg) throw new BridgeError(503, "CHANNEL_UNAVAILABLE", channelAvailability(channel).unavailableReason!);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const query = new URLSearchParams({ user_id: userId, ...extraQuery }).toString();
  const url = `${cfg.url}/_matrix/provision/v3${path}?${query}`;
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

/** Answer an input step (`user_input` or `cookies`) with the user's values, verbatim. */
export function submitStepInput(
  channel: MatrixChannel,
  userId: string,
  step: Pick<LoginStep, "login_id" | "step_id" | "type">,
  input: Record<string, string>,
) {
  return call<LoginStep>(
    channel,
    userId,
    "POST",
    `/login/step/${encodeURIComponent(step.login_id)}/${encodeURIComponent(step.step_id)}/${step.type}`,
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

/** Who a phone number is on the network, as the bridge resolves it for one login. */
export interface ResolvedIdentifier {
  /** The network's own id (WhatsApp: `lid-…` or the phone digits). */
  id: string;
  name: string | null;
  /** The bridge ghost standing for that person in Matrix rooms. */
  mxid: string;
  /** The existing DM room with that person, when there is one. */
  dmRoomId: string | null;
}

interface RawResolved {
  id?: string;
  name?: string;
  mxid?: string;
  dm_room_mxid?: string;
}

function toResolved(raw: RawResolved, identifier: string): ResolvedIdentifier {
  if (typeof raw.mxid !== "string" || typeof raw.id !== "string") {
    throw new BridgeError(502, "BRIDGE_BAD_RESOLVE", `the bridge resolved ${identifier} without an id or ghost`);
  }
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : null,
    mxid: raw.mxid,
    dmRoomId: typeof raw.dm_room_mxid === "string" && raw.dm_room_mxid ? raw.dm_room_mxid : null,
  };
}

/**
 * Ask the bridge who `identifier` (an international phone, `+<digits>`) is on
 * the network, through the account's login `loginId`. WhatsApp answers 404
 * `M_NOT_FOUND` "… is not on WhatsApp" for a number with no account (checked on
 * the deployed bridge, 2026-10-12). Reads only, sends nothing.
 */
export async function resolveIdentifier(
  channel: MatrixChannel,
  userId: string,
  loginId: string,
  identifier: string,
): Promise<ResolvedIdentifier> {
  const raw = await call<RawResolved>(
    channel,
    userId,
    "GET",
    `/resolve_identifier/${encodeURIComponent(identifier)}`,
    undefined,
    CALL_TIMEOUT_MS,
    { login_id: loginId },
  );
  return toResolved(raw, identifier);
}

/** Open (or find) the DM room with `identifier`; the bridge invites the account. */
export async function createDm(
  channel: MatrixChannel,
  userId: string,
  loginId: string,
  identifier: string,
): Promise<ResolvedIdentifier> {
  const raw = await call<RawResolved>(
    channel,
    userId,
    "POST",
    `/create_dm/${encodeURIComponent(identifier)}`,
    {},
    CALL_TIMEOUT_MS,
    { login_id: loginId },
  );
  return toResolved(raw, identifier);
}
