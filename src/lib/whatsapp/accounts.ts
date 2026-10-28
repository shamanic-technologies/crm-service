/**
 * The brand's linked WhatsApp accounts, as the send and the phone resolution
 * use them: the dedicated Matrix account, its sync token, and the bridge login
 * (the account's own number). Connected = the bridge says CONNECTED right now.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixLinks } from "../../db/schema.js";
import { bridgeLogins, type BridgeLogin } from "../matrix/bridge.js";
import { personaOf, type SenderPersona } from "../matrix/persona.js";
import { isAccountType, type AccountType } from "../matrix/account-types.js";

export { personaOf, type SenderPersona };

export interface WhatsappAccount {
  linkId: string;
  connectionId: string;
  matrixUserId: string;
  accessToken: string;
  /** The account's own number, digits (the bridge login id). */
  loginId: string;
  /** The brand marked this account as the one first messages go out from. */
  outreachDefault: boolean;
  /**
   * The brand allows automated sends from this account (SOPHIE-WA-1016, `matrix_links.automation_allowed`).
   * A personal line is never written from whatever this says (`automationOn`, ACCOUNT-TYPES-1028).
   */
  automationAllowed: boolean;
  /** Who writes from this account, as the brand states it. */
  persona: SenderPersona | null;
  /** The type the brand picked for this account (ACCOUNT-TYPES-1028, account-types.ts), null when not typed. */
  accountType: AccountType | null;
}


/** Every linked WhatsApp account of the brand with a token and a login, oldest link first. */
export async function linkedWhatsappAccounts(orgId: string, brandId: string): Promise<WhatsappAccount[]> {
  const rows = await db
    .select({
      linkId: matrixLinks.id,
      connectionId: matrixConnections.id,
      matrixUserId: matrixConnections.matrixUserId,
      accessToken: matrixConnections.accessToken,
      connStatus: matrixConnections.status,
      loginId: matrixLinks.remoteLoginId,
      outreachDefault: matrixLinks.outreachDefault,
      automationAllowed: matrixLinks.automationAllowed,
      personaName: matrixLinks.personaName,
      personaRole: matrixLinks.personaRole,
      personaInstructions: matrixLinks.personaInstructions,
      accountType: matrixLinks.accountType,
    })
    .from(matrixLinks)
    .innerJoin(matrixConnections, eq(matrixConnections.id, matrixLinks.connectionId))
    .where(
      and(
        eq(matrixLinks.orgId, orgId),
        eq(matrixLinks.brandId, brandId),
        eq(matrixLinks.channel, "whatsapp"),
        eq(matrixLinks.status, "linked"),
      ),
    )
    .orderBy(asc(matrixLinks.linkedAt), asc(matrixLinks.id));
  return rows
    .filter((r) => !!r.accessToken && !!r.loginId && r.connStatus !== "paused")
    .map((r) => ({
      linkId: r.linkId,
      connectionId: r.connectionId,
      matrixUserId: r.matrixUserId,
      accessToken: r.accessToken!,
      loginId: r.loginId!,
      outreachDefault: r.outreachDefault,
      automationAllowed: r.automationAllowed,
      persona: personaOf(r),
      accountType: isAccountType(r.accountType) ? r.accountType : null,
    }));
}

/**
 * WHAT THE BRIDGE SAYS ABOUT ONE ACCOUNT, RIGHT NOW (WA-NOT-CONNECTED-1019).
 *
 * Prod 2026-10-18/19: Sophie's number was refused `whatsapp_not_connected`
 * minutes after a successful send. Not a flapping read: WhatsApp itself removed
 * the linked device 2 s after a send (`stream:error 401 device_removed`, right
 * after a `reachout_timelock` notice), so the bridge said BAD_CREDENTIALS
 * "You were logged out from another device" until a relink. The refusal was
 * true but named no cause; and a TRANSIENT state (a reconnect lasts ~1 s) would
 * have been refused the same way, "relink" included, and recorded as final.
 *  - `connected`: CONNECTED (or BACKFILLING, connected and catching up);
 *  - `logged_out`: BAD_CREDENTIALS / LOGGED_OUT, or the login is gone: only a relink helps;
 *  - `transient`: anything else (CONNECTING, TRANSIENT_DISCONNECT, STARTING,
 *    BRIDGE_UNREACHABLE, UNKNOWN_ERROR, no state yet): the bridge reconnects on its own.
 */
export type LoginStatus =
  | { kind: "connected" }
  | { kind: "transient"; stateEvent: string | null }
  | {
      kind: "logged_out";
      stateEvent: string | null;
      /** The bridge's own words ("You were logged out from another device…"), null when the login is gone. */
      message: string | null;
      /** When the bridge stated it. */
      since: Date | null;
      /** WhatsApp limits this number from writing to new people until then (its anti-spam lock), when it says so. */
      reachoutLockedUntil: Date | null;
    };

const CONNECTED_STATES = new Set(["CONNECTED", "BACKFILLING"]);
const LOGGED_OUT_STATES = new Set(["BAD_CREDENTIALS", "LOGGED_OUT"]);

/** PURE: one account's status from the bridge's `/whoami` logins. */
export function loginStatus(logins: BridgeLogin[], loginId: string): LoginStatus {
  const login = logins.find((l) => l.id === loginId);
  if (!login) return { kind: "logged_out", stateEvent: null, message: null, since: null, reachoutLockedUntil: null };
  const ev = login.state?.state_event ?? null;
  if (ev && CONNECTED_STATES.has(ev)) return { kind: "connected" };
  if (ev && LOGGED_OUT_STATES.has(ev)) {
    const lock = login.state?.info?.reachout_timelock_until;
    const lockAt = typeof lock === "string" ? new Date(lock) : null;
    const ts = login.state?.timestamp;
    return {
      kind: "logged_out",
      stateEvent: ev,
      message: login.state?.message ?? login.state?.error ?? null,
      since: typeof ts === "number" ? new Date(ts * 1000) : null,
      reachoutLockedUntil: lockAt && !Number.isNaN(lockAt.getTime()) ? lockAt : null,
    };
  }
  return { kind: "transient", stateEvent: ev };
}

/** PURE: the refusal's words for accounts WhatsApp logged out: which number, when, the bridge's reason. */
export function describeLoggedOut(accounts: { loginId: string; status: Extract<LoginStatus, { kind: "logged_out" }> }[], now: Date): string {
  const parts = accounts.map(({ loginId, status }) => {
    const when = status.since ? ` at ${status.since.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    const why = status.message ? ` (the bridge says: "${status.message}")` : " (its login is gone from the bridge)";
    const lock =
      status.reachoutLockedUntil && status.reachoutLockedUntil > now
        ? ` WhatsApp also limits this number from writing to new people until ${status.reachoutLockedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC.`
        : "";
    return `WhatsApp logged out +${loginId}${when}${why}.${lock}`;
  });
  return `${parts.join(" ")} Relink it from the Integrations page.`;
}

/** The subset the bridge reports CONNECTED right now (one `/whoami` per account). No wait: a background read. */
export async function connectedOnly(accounts: WhatsappAccount[]): Promise<WhatsappAccount[]> {
  const out: WhatsappAccount[] = [];
  for (const a of accounts) {
    if (loginStatus(await bridgeLogins("whatsapp", a.matrixUserId), a.loginId).kind === "connected") out.push(a);
  }
  return out;
}

export interface SendReadiness {
  connected: WhatsappAccount[];
  /** Accounts only a relink brings back. */
  loggedOut: { account: WhatsappAccount; status: Extract<LoginStatus, { kind: "logged_out" }> }[];
  /** Accounts still reconnecting after the wait. */
  reconnecting: { account: WhatsappAccount; stateEvent: string | null }[];
}

const RECONNECT_WAIT_MS = () => Number(process.env.WHATSAPP_RECONNECT_WAIT_MS ?? 10_000);
const RECONNECT_POLL_MS = () => Number(process.env.WHATSAPP_RECONNECT_POLL_MS ?? 1_000);

/**
 * For a SEND (or its reach check): which accounts can send now. When none is
 * connected but one is only reconnecting, asks again every second for up to
 * `WHATSAPP_RECONNECT_WAIT_MS` (10 s): a reconnect lasts ~1 s in prod.
 */
export async function sendReadiness(accounts: WhatsappAccount[]): Promise<SendReadiness> {
  const deadline = Date.now() + RECONNECT_WAIT_MS();
  for (;;) {
    const r: SendReadiness = { connected: [], loggedOut: [], reconnecting: [] };
    for (const a of accounts) {
      const st = loginStatus(await bridgeLogins("whatsapp", a.matrixUserId), a.loginId);
      if (st.kind === "connected") r.connected.push(a);
      else if (st.kind === "logged_out") r.loggedOut.push({ account: a, status: st });
      else r.reconnecting.push({ account: a, stateEvent: st.stateEvent });
    }
    if (r.connected.length > 0 || r.reconnecting.length === 0 || Date.now() >= deadline) return r;
    await new Promise((res) => setTimeout(res, RECONNECT_POLL_MS()));
  }
}
