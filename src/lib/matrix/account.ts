/**
 * The brand's DEDICATED Matrix account, one per self-serve link.
 *
 * crm-service is registered on the homeserver as an appservice (id `crm`) that
 * exclusively owns the `@crm_*` user namespace. That gives it two powers and
 * nothing else it uses:
 *  - create an account in its namespace (`m.login.application_service` register),
 *  - log that account in to get an access token for `/sync`.
 *
 * Why an account per link: the WhatsApp bridge keeps one login per Matrix
 * account and invites only that account to the login's rooms. A dedicated
 * account per (org, brand, channel) is therefore what makes one customer's DMs
 * unreachable from any other brand's /sync — isolation by construction, not by
 * a filter.
 *
 * The same appservice token is configured on the bridge as its double-puppet
 * secret for this server, so the bridge sends the user's OWN WhatsApp messages
 * as this account (sender == account → outbound) and joins its rooms itself.
 *
 * There is no message-sending call here. This module creates and logs in
 * accounts; it never writes to a room.
 */

import { randomBytes } from "node:crypto";
import { homeserverUrl } from "./client.js";

const ACCOUNT_TIMEOUT_MS = 15_000;

function appserviceToken(): string {
  const token = process.env.MATRIX_APPSERVICE_TOKEN;
  if (!token) throw new Error("[crm-service] MATRIX_APPSERVICE_TOKEN is required to link an account");
  return token;
}

/** Is the homeserver side of self-serve linking configured at all? */
export function accountProvisioningConfigured(): boolean {
  return !!process.env.MATRIX_APPSERVICE_TOKEN && !!process.env.MATRIX_HOMESERVER_URL;
}

async function hsPost(path: string, body: unknown, token: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCOUNT_TIMEOUT_MS);
  try {
    const res = await fetch(`${homeserverUrl()}/_matrix/client/v3${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`[crm-service][matrix] POST ${path} returned ${res.status}: ${text}`);
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } finally {
    clearTimeout(timer);
  }
}

/** Create a fresh `@crm_<random>` account. Returns its MXID. */
export async function createLinkAccount(): Promise<string> {
  const localpart = `crm_${randomBytes(8).toString("hex")}`;
  const body = await hsPost(
    "/register",
    { type: "m.login.application_service", username: localpart, inhibit_login: true },
    appserviceToken(),
  );
  const userId = body.user_id;
  if (typeof userId !== "string") {
    throw new Error(`[crm-service][matrix] register returned no user_id: ${JSON.stringify(body)}`);
  }
  return userId;
}

/** Log the account in through the appservice. Returns an access token for /sync. */
export async function loginLinkAccount(userId: string): Promise<string> {
  const localpart = userId.replace(/^@/, "").split(":")[0];
  const body = await hsPost(
    "/login",
    {
      type: "m.login.application_service",
      identifier: { type: "m.id.user", user: localpart },
      initial_device_display_name: "crm-service sync",
    },
    appserviceToken(),
  );
  const token = body.access_token;
  if (typeof token !== "string") {
    throw new Error(`[crm-service][matrix] login returned no access_token for ${userId}`);
  }
  return token;
}

/**
 * Revoke an account's sync token. A 401 means it is already revoked — the
 * outcome the caller wants — so it is not an error; anything else is.
 */
export async function logoutLinkAccount(accessToken: string): Promise<void> {
  try {
    await hsPost("/logout", {}, accessToken);
  } catch (err) {
    if ((err as Error).message.includes("returned 401")) return;
    throw err;
  }
}
