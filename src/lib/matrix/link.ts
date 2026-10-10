/**
 * Self-serve linking: a signed-in user links the brand's WhatsApp, LinkedIn
 * (or, once its bridge runs, Telegram) from the dashboard. No staff step.
 *
 * A brand links N accounts per channel (a founder's WhatsApp AND a sales rep's).
 * Each account is its own `matrix_links` row with its own dedicated Matrix
 * account and, once linked, its own `matrix_connections` row. A link is
 * addressed by its id; starting a link never touches an account already linked.
 *
 *   start  → a dedicated Matrix account for the link (account.ts), a bridge login
 *            process (bridge.ts), the first QR / pairing code written to
 *            `matrix_links`, and a background DRIVER that long-polls the bridge.
 *   input  → a flow that needs the USER (LinkedIn: email + password, then the
 *            code LinkedIn emails; or browser cookies) records the bridge's
 *            step on the row; the answer is relayed and never stored.
 *   driver → every refreshed code is written to the row; completion opens the
 *            account's `matrix_connections` row (the account's own sync token) and
 *            kicks its first sync; a refusal is recorded with the bridge's OWN
 *            code + message.
 *   read   → the dashboard polls the row. A waiting link whose driver is not
 *            alive in this process (service restarted) is marked failed, with a
 *            reason, instead of posing as still waiting.
 *   unlink → bridge logout, sync token revoked, everything mirrored for the
 *            connection deleted, people rebuilt.
 *
 * Read-only by design: nothing here (or in the modules it calls) sends a message.
 */

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "../../db/index.js";
import {
  contacts,
  matrixConnections,
  matrixLinks,
  peopleScopes,
  type MatrixConnection,
  type MatrixLink,
} from "../../db/schema.js";
import { createLinkAccount, loginLinkAccount, logoutLinkAccount } from "./account.js";
import {
  BridgeError,
  CHANNEL_METHODS,
  COUNTERPART_PREFIX,
  bridgeLogins,
  cancelLogin,
  channelAvailability,
  isInputStep,
  logoutAll,
  startLogin,
  submitStepInput,
  submitUserInput,
  waitForNextStep,
  type LinkMethod,
  type LoginStep,
} from "./bridge.js";
import { MATRIX_CHANNELS, type MatrixChannel } from "./events.js";
import { runSyncPass } from "./sync.js";
import { runPeopleBuildPass } from "../people/build.js";

/** Bridge login processes driven by THIS process. */
const activeDrivers = new Set<string>();

/** An input step the user never answered stops posing as live after this long. */
export const INPUT_WAIT_MS = 10 * 60_000;

export class LinkUnavailableError extends Error {
  constructor(readonly channel: MatrixChannel, readonly reason: string) {
    super(reason);
  }
}

/** A request the link cannot serve as asked: answered 4xx with `type` + words. */
export class LinkRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface LinkScope {
  orgId: string;
  brandId: string;
  channel: MatrixChannel;
}

// ─── Start ───────────────────────────────────────────────────────────────────

export interface StartLinkParams extends LinkScope {
  method: LinkMethod;
  phoneNumber?: string;
  /** Relink THIS account (an expired session) instead of adding a new one. */
  linkId?: string;
  userId: string;
  runId: string | null;
}

export async function findLinkById(scope: LinkScope, linkId: string): Promise<MatrixLink | undefined> {
  const [row] = await db
    .select()
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.id, linkId),
        eq(matrixLinks.orgId, scope.orgId),
        eq(matrixLinks.brandId, scope.brandId),
        eq(matrixLinks.channel, scope.channel),
      ),
    );
  return row;
}

/**
 * The row a NEW account's link reuses: the channel's latest attempt that never
 * linked an account (waiting, failed or unlinked, and carrying no connection).
 * A linked account, or a relink of one, is never reused for another account.
 */
async function reusableAttempt(scope: LinkScope): Promise<MatrixLink | undefined> {
  const [row] = await db
    .select()
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.orgId, scope.orgId),
        eq(matrixLinks.brandId, scope.brandId),
        eq(matrixLinks.channel, scope.channel),
        inArray(matrixLinks.status, ["waiting", "failed", "unlinked"]),
        isNull(matrixLinks.connectionId),
      ),
    )
    .orderBy(desc(matrixLinks.updatedAt), desc(matrixLinks.id))
    .limit(1);
  return row;
}

/**
 * Start a link. Without `linkId` this ADDS an account: a fresh link flow (its
 * own QR / code / login form) on its own Matrix account, never the account
 * already linked. With `linkId` it re-runs the login of that account (an
 * expired session): same Matrix account, same connection, nothing re-mirrored.
 *
 * Throws `LinkUnavailableError` for a channel whose bridge is not configured,
 * `LinkRequestError` for a method the channel does not offer or an unknown
 * link, and `BridgeError` when the bridge refuses (its code + message are also
 * recorded on the row, so the next poll shows the same reason).
 */
export async function startLink(params: StartLinkParams): Promise<MatrixLink> {
  const availability = channelAvailability(params.channel);
  if (!availability.available) {
    throw new LinkUnavailableError(params.channel, availability.unavailableReason!);
  }
  if (!CHANNEL_METHODS[params.channel].includes(params.method)) {
    throw new LinkRequestError(
      400,
      "validation",
      `${params.channel} offers ${CHANNEL_METHODS[params.channel].join("|")}, not '${params.method}'`,
    );
  }

  let existing: MatrixLink | undefined;
  if (params.linkId) {
    existing = await findLinkById(params, params.linkId);
    if (!existing || existing.status === "unlinked") {
      throw new LinkRequestError(404, "not_found", "no such link for this brand and channel");
    }
  } else {
    existing = await reusableAttempt(params);
  }

  // A code already on screen for this attempt is superseded by the new start.
  if (existing?.status === "waiting" && existing.matrixUserId && existing.bridgeProcessId) {
    await cancelLogin(params.channel, existing.matrixUserId, existing.bridgeProcessId);
    activeDrivers.delete(existing.bridgeProcessId);
  }

  const matrixUserId = existing?.matrixUserId ?? (await createLinkAccount());
  const now = new Date();
  const fresh = {
    createdByUserId: params.userId,
    matrixUserId,
    status: "waiting",
    method: params.method,
    bridgeProcessId: null,
    bridgeStepId: null,
    displayType: null,
    displayData: null,
    instructions: null,
    displayIssuedAt: null,
    inputStep: null,
    errorCode: null,
    errorMessage: null,
    runId: params.runId,
    startedAt: now,
    updatedAt: now,
  };
  // A relink keeps what identifies the account it is re-logging.
  const reset = existing?.connectionId
    ? {}
    : { remoteLoginId: null, remoteName: null, connectionId: null, linkedAt: null };
  const [row] = existing
    ? await db.update(matrixLinks).set({ ...fresh, ...reset }).where(eq(matrixLinks.id, existing.id)).returning()
    : await db
        .insert(matrixLinks)
        .values({ orgId: params.orgId, brandId: params.brandId, channel: params.channel, ...fresh })
        .returning();

  let step: LoginStep;
  try {
    step = await startLogin(params.channel, matrixUserId, params.method);
    // WhatsApp's phone flow: the number came with the start, answer its one field now.
    if (step.type === "user_input" && params.method === "phone") {
      const field = step.user_input?.fields?.find((f) => f.type === "phone_number") ?? step.user_input?.fields?.[0];
      if (!field) throw new BridgeError(502, "BRIDGE_UNEXPECTED_STEP", "bridge asked for input without naming a field");
      if (!params.phoneNumber) {
        await cancelLogin(params.channel, matrixUserId, step.login_id);
        throw new BridgeError(400, "PHONE_NUMBER_REQUIRED", "A phone number is required to get a pairing code");
      }
      step = await submitUserInput(params.channel, matrixUserId, step, { [field.id]: params.phoneNumber });
    }
  } catch (err) {
    const e =
      err instanceof BridgeError ? err : new BridgeError(500, "INTERNAL", (err as Error).message);
    await db
      .update(matrixLinks)
      .set({ status: "failed", errorCode: e.code, errorMessage: e.bridgeMessage, updatedAt: new Date() })
      .where(eq(matrixLinks.id, row.id));
    throw e;
  }

  await db
    .update(matrixLinks)
    .set({ bridgeProcessId: step.login_id, updatedAt: new Date() })
    .where(eq(matrixLinks.id, row.id));

  await applyStep(row.id, params.channel, matrixUserId, step);
  return (await db.select().from(matrixLinks).where(eq(matrixLinks.id, row.id)))[0];
}

// ─── Input (LinkedIn login form, emailed code, cookies) ─────────────────────

export interface SubmitInputParams extends LinkScope {
  linkId: string;
  /** Field id → value, exactly as the recorded step names its fields. Never stored. */
  input: Record<string, string>;
}

/**
 * Answer the step the link is waiting on. The step is CLAIMED first (one
 * conditional update), so two submits of one step cannot both reach the bridge.
 * The bridge's next step is applied like any other: another form (LinkedIn's
 * emailed code), a code to show, or completion.
 */
export async function submitLinkInput(params: SubmitInputParams): Promise<MatrixLink> {
  const link = await findLinkById(params, params.linkId);
  if (!link || link.status === "unlinked") {
    throw new LinkRequestError(404, "not_found", "no such link for this brand and channel");
  }
  const step = link.inputStep as LoginStep | null;
  if (link.status !== "waiting" || !step || !link.matrixUserId || !link.bridgeProcessId) {
    throw new LinkRequestError(409, "no_input_awaited", "this link is not waiting for any input; start it again");
  }
  const expected = inputFieldIds(step);
  const missing = expected.required.filter((id) => !params.input[id]);
  if (missing.length) {
    throw new LinkRequestError(400, "validation", `missing input: ${missing.join(", ")}`, { fields: expected.all });
  }
  const unknown = Object.keys(params.input).filter((id) => !expected.all.includes(id));
  if (unknown.length) {
    throw new LinkRequestError(400, "validation", `unknown input: ${unknown.join(", ")}`, { fields: expected.all });
  }

  const claimed = await db
    .update(matrixLinks)
    .set({ inputStep: null, updatedAt: new Date() })
    .where(
      and(
        eq(matrixLinks.id, link.id),
        eq(matrixLinks.status, "waiting"),
        eq(matrixLinks.bridgeProcessId, link.bridgeProcessId),
        sql`${matrixLinks.inputStep}->>'step_id' = ${step.step_id}`,
      ),
    )
    .returning({ id: matrixLinks.id });
  if (claimed.length === 0) {
    throw new LinkRequestError(409, "no_input_awaited", "this step was already answered; poll the link");
  }

  const channel = params.channel;
  let next: LoginStep;
  try {
    next = await submitStepInput(channel, link.matrixUserId, step, params.input);
  } catch (err) {
    const e = err instanceof BridgeError ? err : new BridgeError(500, "INTERNAL", (err as Error).message);
    await markFailed(link.id, link.bridgeProcessId, e.code, e.bridgeMessage);
    await cancelLogin(channel, link.matrixUserId, link.bridgeProcessId).catch((c) =>
      console.error(`[crm-service][link] cancel after refused input failed link=${link.id}:`, c),
    );
    throw e;
  }
  await applyStep(link.id, channel, link.matrixUserId, next);
  return (await db.select().from(matrixLinks).where(eq(matrixLinks.id, link.id)))[0];
}

/** The field ids a recorded input step accepts, and which of them it requires. */
export function inputFieldIds(step: LoginStep): { all: string[]; required: string[] } {
  if (step.type === "cookies") {
    const fields = step.cookies?.fields ?? [];
    return { all: fields.map((f) => f.id), required: fields.filter((f) => f.required).map((f) => f.id) };
  }
  const fields = step.user_input?.fields ?? [];
  return { all: fields.map((f) => f.id), required: fields.map((f) => f.id) };
}

/** Route one bridge step: show a code and keep waiting, ask the user, or finish. */
async function applyStep(linkId: string, channel: MatrixChannel, matrixUserId: string, step: LoginStep) {
  if (step.type === "complete") {
    await finalizeLink(linkId, step);
    return;
  }
  if (isInputStep(step)) {
    if (!(await writeInputStep(linkId, step))) await cancelLogin(channel, matrixUserId, step.login_id);
    return;
  }
  if (step.type !== "display_and_wait") {
    await markFailed(
      linkId,
      step.login_id,
      "BRIDGE_UNEXPECTED_STEP",
      `the bridge asked for a '${step.type}' step, which this flow does not support`,
    );
    await cancelLogin(channel, matrixUserId, step.login_id);
    return;
  }
  const written = await writeDisplay(linkId, step);
  if (!written) {
    await cancelLogin(channel, matrixUserId, step.login_id);
    return;
  }
  activeDrivers.add(step.login_id);
  setImmediate(() => {
    drive(linkId, channel, matrixUserId, step).catch((err) =>
      console.error(`[crm-service][link] driver crashed link=${linkId}:`, err),
    );
  });
}

/** Record the step the user must answer. False when the row moved on. */
async function writeInputStep(linkId: string, step: LoginStep): Promise<boolean> {
  const rows = await db
    .update(matrixLinks)
    .set({
      bridgeStepId: step.step_id,
      inputStep: step as unknown as Record<string, unknown>,
      displayType: null,
      displayData: null,
      instructions: step.instructions ?? null,
      displayIssuedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(matrixLinks.id, linkId),
        eq(matrixLinks.bridgeProcessId, step.login_id),
        eq(matrixLinks.status, "waiting"),
      ),
    )
    .returning({ id: matrixLinks.id });
  return rows.length > 0;
}

/** Write the current code. False when the row moved on (superseded/unlinked). */
async function writeDisplay(linkId: string, step: LoginStep): Promise<boolean> {
  const rows = await db
    .update(matrixLinks)
    .set({
      bridgeStepId: step.step_id,
      displayType: step.display_and_wait?.type ?? null,
      displayData: step.display_and_wait?.data ?? null,
      instructions: step.instructions ?? null,
      inputStep: null,
      displayIssuedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(matrixLinks.id, linkId),
        eq(matrixLinks.bridgeProcessId, step.login_id),
        eq(matrixLinks.status, "waiting"),
      ),
    )
    .returning({ id: matrixLinks.id });
  return rows.length > 0;
}

async function markFailed(linkId: string, processId: string, code: string, message: string) {
  await db
    .update(matrixLinks)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: message,
      displayType: null,
      displayData: null,
      inputStep: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(matrixLinks.id, linkId),
        eq(matrixLinks.bridgeProcessId, processId),
        eq(matrixLinks.status, "waiting"),
      ),
    );
}

/**
 * The background DRIVER: long-poll the bridge for the next step until the
 * login completes, fails, asks the user something, or the row is superseded.
 */
export async function drive(linkId: string, channel: MatrixChannel, matrixUserId: string, first: LoginStep) {
  const processId = first.login_id;
  activeDrivers.add(processId);
  try {
    let current = first;
    for (;;) {
      const next = await waitForNextStep(channel, matrixUserId, current);
      if (next.type === "display_and_wait") {
        if (!(await writeDisplay(linkId, next))) {
          await cancelLogin(channel, matrixUserId, processId);
          return;
        }
        current = next;
        continue;
      }
      if (next.type === "complete") {
        await finalizeLink(linkId, next);
        return;
      }
      if (isInputStep(next)) {
        if (!(await writeInputStep(linkId, next))) await cancelLogin(channel, matrixUserId, processId);
        return;
      }
      await markFailed(
        linkId,
        processId,
        "BRIDGE_UNEXPECTED_STEP",
        `the bridge asked for a '${next.type}' step, which this flow does not support`,
      );
      await cancelLogin(channel, matrixUserId, processId);
      return;
    }
  } catch (err) {
    if (err instanceof BridgeError) {
      await markFailed(linkId, processId, err.code, err.bridgeMessage);
    } else {
      console.error(`[crm-service][link] link=${linkId} failed:`, err);
      await markFailed(linkId, processId, "INTERNAL", (err as Error).message);
    }
  } finally {
    activeDrivers.delete(processId);
  }
}

/**
 * The account is linked: open (or re-point) ITS Matrix connection on the
 * account's own sync token, mark the link linked, kick the first sync.
 *
 * The same remote account (one WhatsApp number, one LinkedIn member) linked
 * twice on a brand would mirror every thread twice: the second login is
 * refused (`ACCOUNT_ALREADY_LINKED`) and logged out of the bridge.
 */
async function finalizeLink(linkId: string, step: LoginStep) {
  const [link] = await db.select().from(matrixLinks).where(eq(matrixLinks.id, linkId));
  if (!link || link.status !== "waiting" || link.bridgeProcessId !== step.login_id || !link.matrixUserId) return;
  const channel = link.channel as MatrixChannel;
  const remoteLoginId = step.complete?.user_login_id ?? null;

  if (remoteLoginId) {
    const [twin] = await db
      .select({ id: matrixLinks.id })
      .from(matrixLinks)
      .where(
        and(
          eq(matrixLinks.orgId, link.orgId),
          eq(matrixLinks.brandId, link.brandId),
          eq(matrixLinks.channel, channel),
          eq(matrixLinks.status, "linked"),
          eq(matrixLinks.remoteLoginId, remoteLoginId),
          ne(matrixLinks.id, link.id),
        ),
      );
    if (twin) {
      await markFailed(
        link.id,
        step.login_id,
        "ACCOUNT_ALREADY_LINKED",
        "This account is already linked to this brand.",
      );
      await logoutAll(channel, link.matrixUserId).catch((err) =>
        console.error(`[crm-service][link] logout of duplicate login failed link=${link.id}:`, err),
      );
      return;
    }
  }

  const [previous] = link.connectionId
    ? await db.select().from(matrixConnections).where(eq(matrixConnections.id, link.connectionId))
    : [];
  const accessToken = await loginLinkAccount(link.matrixUserId);
  const connection = await db.transaction(async (tx) => {
    const values = {
      counterpartPrefix: COUNTERPART_PREFIX[channel],
      accessToken,
      createdByUserId: link.createdByUserId,
      status: "active",
      lastError: null,
      // A new token is a new device: start its stream from scratch (events are idempotent).
      sinceToken: null,
    };
    const [conn] = await tx
      .insert(matrixConnections)
      .values({ orgId: link.orgId, brandId: link.brandId, channel, matrixUserId: link.matrixUserId!, ...values })
      .onConflictDoUpdate({
        target: [
          matrixConnections.orgId,
          matrixConnections.brandId,
          matrixConnections.channel,
          matrixConnections.matrixUserId,
        ],
        set: values,
      })
      .returning();
    await tx
      .update(matrixLinks)
      .set({
        status: "linked",
        remoteLoginId,
        connectionId: conn.id,
        displayType: null,
        displayData: null,
        inputStep: null,
        instructions: step.instructions ?? null,
        linkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(matrixLinks.id, linkId));
    return conn;
  });

  // A relink minted a new token: the old device's token is revoked.
  if (previous?.accessToken && previous.accessToken !== accessToken) {
    await logoutLinkAccount(previous.accessToken).catch((err) =>
      console.error(`[crm-service][link] revoking the previous token failed link=${linkId}:`, err),
    );
  }

  console.log(`[crm-service][link] linked ${channel} link=${linkId} connection=${connection.id}`);
  setImmediate(() => {
    runSyncPass(connection.id).catch((err) =>
      console.error(`[crm-service][link] first sync failed connection=${connection.id}:`, err),
    );
  });
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** What a waiting link needs the USER to answer (LinkedIn login form, emailed code, cookies). */
export interface LinkInputView {
  /** 'user_input' = a form of fields; 'cookies' = values read from a logged-in browser. */
  type: string;
  stepId: string;
  instructions: string | null;
  /** user_input: the bridge's fields verbatim (id, type, name, description, pattern, options). */
  fields: { id: string; type: string; name: string | null; description: string | null; pattern: string | null; options: string[] | null }[];
  /** cookies: where to log in and which values to read; null for a form. */
  cookies: {
    url: string | null;
    userAgent: string | null;
    extractJs: string | null;
    fields: { id: string; required: boolean; sources: { type: string; name: string; cookieDomain: string | null }[]; pattern: string | null }[];
  } | null;
}

export interface LinkView {
  channel: MatrixChannel;
  /** This account's link. Null on a channel with nothing linked or attempted yet. */
  linkId: string | null;
  available: boolean;
  unavailableReason: string | null;
  methods: readonly LinkMethod[];
  status: "not_linked" | "waiting" | "linked" | "failed";
  method: LinkMethod | null;
  qr: { data: string; imageDataUrl: string } | null;
  pairingCode: string | null;
  /** Set while the bridge waits for the user to answer (submit it with `linkId` + `input`). */
  input: LinkInputView | null;
  instructions: string | null;
  codeIssuedAt: Date | null;
  account: { id: string; name: string | null } | null;
  bridgeState: { state: string | null; reason: string | null } | null;
  bridgeStateError: string | null;
  /** The bridge says this account's session is gone: relink it (POST with its `linkId`). */
  needsRelink: boolean;
  /** Accounts currently linked on this channel for the brand (every link, not only this one). */
  linkedAccounts: number;
  connection: {
    id: string;
    status: string;
    synced: boolean;
    lastSyncedAt: Date | null;
    lastError: string | null;
  } | null;
  error: { code: string; message: string } | null;
  startedAt: Date | null;
  linkedAt: Date | null;
}

const INTERRUPTED = {
  code: "INTERRUPTED",
  message: "The link was interrupted by a service restart. Start again to get a new code.",
};

const EXPIRED = {
  code: "EXPIRED",
  message: "The login was not finished in time. Start again.",
};

/** Bridge states that mean the login is gone and only a relink brings it back. */
const RELINK_STATES = new Set(["BAD_CREDENTIALS", "LOGGED_OUT"]);

export interface BrandLinks {
  /** One per channel, the account the channel's tile shows (pre-multi-account shape). */
  links: LinkView[];
  /** Every account, linked or in progress, on every channel. */
  accounts: LinkView[];
}

/**
 * Every link of one brand. `accounts` lists each account on its own; `links`
 * keeps one entry per channel for callers built before several accounts
 * existed: the attempt in progress if any, else the latest linked account,
 * else the latest failure.
 */
export async function brandLinks(orgId: string, brandId: string): Promise<BrandLinks> {
  const rows = await db
    .select()
    .from(matrixLinks)
    .where(and(eq(matrixLinks.orgId, orgId), eq(matrixLinks.brandId, brandId)));
  const conns = await db
    .select()
    .from(matrixConnections)
    .where(and(eq(matrixConnections.orgId, orgId), eq(matrixConnections.brandId, brandId)));

  const links: LinkView[] = [];
  const accounts: LinkView[] = [];
  for (const channel of MATRIX_CHANNELS) {
    const live: MatrixLink[] = [];
    for (let link of rows.filter((r) => r.channel === channel && r.status !== "unlinked")) {
      link = await expireStale(link);
      live.push(link);
    }
    live.sort(
      (a, b) =>
        (a.startedAt?.getTime() ?? a.createdAt.getTime()) - (b.startedAt?.getTime() ?? b.createdAt.getTime()) ||
        (a.id < b.id ? -1 : 1),
    );
    const linkedAccounts = live.filter((l) => l.status === "linked").length;
    const views: LinkView[] = [];
    for (const link of live) {
      const conn = link.connectionId ? conns.find((c) => c.id === link.connectionId) : undefined;
      views.push(await toView(channel, link, conn, linkedAccounts));
    }
    accounts.push(...views);
    const latest = (status: string, at: (v: LinkView) => Date | null) =>
      views
        .filter((v) => v.status === status)
        .sort((a, b) => (at(b)?.getTime() ?? 0) - (at(a)?.getTime() ?? 0))[0];
    links.push(
      latest("waiting", (v) => v.startedAt) ??
        latest("linked", (v) => v.linkedAt) ??
        latest("failed", (v) => v.startedAt) ??
        (await toView(channel, undefined, undefined, 0)),
    );
  }
  return { links, accounts };
}

/** Every channel for one brand, one entry each (see `brandLinks`). */
export async function listLinks(orgId: string, brandId: string): Promise<LinkView[]> {
  return (await brandLinks(orgId, brandId)).links;
}

/**
 * A waiting link that can no longer complete is turned failed with a reason:
 * a code whose driver died with the process, or a form nobody answered.
 */
async function expireStale(link: MatrixLink): Promise<MatrixLink> {
  if (link.status !== "waiting") return link;
  if (link.inputStep) {
    const since = (link.displayIssuedAt ?? link.updatedAt).getTime();
    return Date.now() - since > INPUT_WAIT_MS ? interrupt(link, EXPIRED) : link;
  }
  if (!link.bridgeProcessId || !activeDrivers.has(link.bridgeProcessId)) return interrupt(link, INTERRUPTED);
  return link;
}

async function interrupt(link: MatrixLink, reason: { code: string; message: string }): Promise<MatrixLink> {
  const [row] = await db
    .update(matrixLinks)
    .set({
      status: "failed",
      errorCode: reason.code,
      errorMessage: reason.message,
      displayType: null,
      displayData: null,
      inputStep: null,
      updatedAt: new Date(),
    })
    .where(and(eq(matrixLinks.id, link.id), eq(matrixLinks.status, "waiting")))
    .returning();
  if (row && link.matrixUserId && link.bridgeProcessId) {
    await cancelLogin(link.channel as MatrixChannel, link.matrixUserId, link.bridgeProcessId).catch((err) =>
      console.error(`[crm-service][link] cancel of interrupted login ${link.bridgeProcessId} failed:`, err),
    );
  }
  return row ?? (await db.select().from(matrixLinks).where(eq(matrixLinks.id, link.id)))[0];
}

export function toInputView(step: LoginStep): LinkInputView {
  return {
    type: step.type,
    stepId: step.step_id,
    instructions: step.instructions ?? null,
    fields: (step.user_input?.fields ?? []).map((f) => ({
      id: f.id,
      type: f.type,
      name: f.name ?? null,
      description: f.description ?? null,
      pattern: f.pattern ?? null,
      options: f.options ?? null,
    })),
    cookies:
      step.type === "cookies"
        ? {
            url: step.cookies?.url ?? null,
            userAgent: step.cookies?.user_agent ?? null,
            extractJs: step.cookies?.extract_js ?? null,
            fields: (step.cookies?.fields ?? []).map((f) => ({
              id: f.id,
              required: !!f.required,
              sources: (f.sources ?? []).map((src) => ({
                type: src.type,
                name: src.name,
                cookieDomain: src.cookie_domain ?? null,
              })),
              pattern: f.pattern ?? null,
            })),
          }
        : null,
  };
}

export async function toView(
  channel: MatrixChannel,
  link: MatrixLink | undefined,
  conn: MatrixConnection | undefined,
  linkedAccounts: number,
): Promise<LinkView> {
  const availability = channelAvailability(channel);
  const status: LinkView["status"] =
    !link || link.status === "unlinked" ? "not_linked" : (link.status as LinkView["status"]);
  const showing = status === "waiting" && link?.displayData ? link : null;
  const awaiting = status === "waiting" && link?.inputStep ? (link.inputStep as unknown as LoginStep) : null;

  let bridgeState: LinkView["bridgeState"] = null;
  let bridgeStateError: string | null = null;
  let accountName: string | null = null;
  if ((status === "linked" || link?.connectionId) && link?.matrixUserId && availability.available) {
    try {
      const logins = await bridgeLogins(channel, link.matrixUserId);
      const login = logins.find((l) => l.id === link.remoteLoginId) ?? logins[0];
      if (login) {
        accountName = login.name || null;
        bridgeState = {
          state: login.state?.state_event ?? null,
          reason: login.state?.message ?? login.state?.reason ?? login.state?.error ?? null,
        };
      } else {
        bridgeState = { state: "LOGGED_OUT", reason: "The bridge holds no login for this account any more." };
      }
    } catch (err) {
      bridgeStateError = (err as Error).message;
    }
  }

  return {
    channel,
    linkId: status === "not_linked" ? null : link!.id,
    available: availability.available,
    unavailableReason: availability.unavailableReason,
    methods: availability.available ? CHANNEL_METHODS[channel] : [],
    status,
    method: status === "not_linked" ? null : ((link?.method as LinkMethod) ?? null),
    qr:
      showing?.displayType === "qr"
        ? { data: showing.displayData!, imageDataUrl: await QRCode.toDataURL(showing.displayData!, { margin: 1, width: 320 }) }
        : null,
    pairingCode: showing?.displayType === "code" ? showing.displayData : null,
    input: awaiting ? toInputView(awaiting) : null,
    instructions: status === "waiting" || status === "linked" ? (link?.instructions ?? null) : null,
    codeIssuedAt: showing ? showing.displayIssuedAt : null,
    account: link?.remoteLoginId && (status === "linked" || link.connectionId) ? { id: link.remoteLoginId, name: accountName } : null,
    bridgeState,
    bridgeStateError,
    needsRelink: status === "linked" && !!bridgeState?.state && RELINK_STATES.has(bridgeState.state),
    linkedAccounts,
    connection: conn
      ? {
          id: conn.id,
          status: conn.status,
          synced: conn.sinceToken !== null,
          lastSyncedAt: conn.lastSyncedAt,
          lastError: conn.lastError,
        }
      : null,
    error: status === "failed" && link?.errorCode ? { code: link.errorCode, message: link.errorMessage ?? "" } : null,
    startedAt: status === "not_linked" ? null : (link?.startedAt ?? null),
    linkedAt: link?.connectionId ? (link?.linkedAt ?? null) : null,
  };
}

/** One account's view, by its link id. */
export async function getLinkViewById(orgId: string, brandId: string, linkId: string): Promise<LinkView | undefined> {
  return (await brandLinks(orgId, brandId)).accounts.find((v) => v.linkId === linkId);
}

/** The channel's tile (see `brandLinks`). */
export async function getLinkView(scope: LinkScope): Promise<LinkView> {
  const views = await listLinks(scope.orgId, scope.brandId);
  return views.find((v) => v.channel === scope.channel)!;
}

// ─── Unlink ──────────────────────────────────────────────────────────────────

export interface UnlinkResult {
  unlinked: boolean;
  linkId: string;
  contactsRemoved: number;
  connectionRemoved: boolean;
}

/**
 * Unlink ONE account: the bridge logs it out (no more DMs reach it), its sync
 * token is revoked, and everything mirrored for its connection is deleted —
 * raw events, conversations and leads by cascade, Matrix contacts explicitly
 * (they carry the connection id but no foreign key). Every other account of the
 * brand, on this channel or another, is untouched. The next people build no
 * longer sees it; one is kicked right away.
 *
 * Without `linkId` the channel's only account is meant; when the channel holds
 * several, which one is ambiguous and the call is refused (409 with their ids)
 * rather than guessed. Returns null when there is nothing to unlink.
 */
export async function unlink(scope: LinkScope, linkId?: string): Promise<UnlinkResult | null> {
  let link: MatrixLink | undefined;
  if (linkId) {
    link = await findLinkById(scope, linkId);
  } else {
    const live = await db
      .select()
      .from(matrixLinks)
      .where(
        and(
          eq(matrixLinks.orgId, scope.orgId),
          eq(matrixLinks.brandId, scope.brandId),
          eq(matrixLinks.channel, scope.channel),
          ne(matrixLinks.status, "unlinked"),
        ),
      );
    if (live.length > 1) {
      throw new LinkRequestError(
        409,
        "link_id_required",
        `this brand has ${live.length} ${scope.channel} links: name the one to unlink with linkId`,
        { linkIds: live.map((l) => l.id) },
      );
    }
    link = live[0];
  }
  if (!link || link.status === "unlinked") return null;
  const channel = scope.channel;

  if (link.matrixUserId) {
    if (link.status === "waiting" && link.bridgeProcessId) {
      await cancelLogin(channel, link.matrixUserId, link.bridgeProcessId);
    }
    await logoutAll(channel, link.matrixUserId);
  }

  const [conn] = link.connectionId
    ? await db.select().from(matrixConnections).where(eq(matrixConnections.id, link.connectionId))
    : [];
  if (conn?.accessToken) await logoutLinkAccount(conn.accessToken);

  const contactsRemoved = await db.transaction(async (tx) => {
    let removed = 0;
    if (conn) {
      const gone = await tx
        .delete(contacts)
        .where(
          and(
            eq(contacts.orgId, scope.orgId),
            eq(contacts.brandId, scope.brandId),
            eq(contacts.source, "matrix"),
            eq(contacts.sourceConnectionId, conn.id),
          ),
        )
        .returning({ id: contacts.id });
      removed = gone.length;
      await tx.delete(matrixConnections).where(eq(matrixConnections.id, conn.id));
    }
    await tx
      .update(matrixLinks)
      .set({
        status: "unlinked",
        matrixUserId: null,
        bridgeProcessId: null,
        bridgeStepId: null,
        displayType: null,
        displayData: null,
        inputStep: null,
        instructions: null,
        remoteLoginId: null,
        remoteName: null,
        errorCode: null,
        errorMessage: null,
        connectionId: null,
        linkedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(matrixLinks.id, link!.id));
    return removed;
  });

  const [scopeRow] = await db
    .select({ id: peopleScopes.id })
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, scope.orgId), eq(peopleScopes.brandId, scope.brandId)));
  if (scopeRow) {
    setImmediate(() => {
      runPeopleBuildPass(scopeRow.id).catch((err) =>
        console.error(`[crm-service][link] people rebuild after unlink failed scope=${scopeRow.id}:`, err),
      );
    });
  }

  return { unlinked: true, linkId: link.id, contactsRemoved, connectionRemoved: !!conn };
}
