/**
 * Self-serve linking: a signed-in user links the brand's WhatsApp (or, once its
 * bridge runs, Telegram) from the dashboard. No staff step.
 *
 *   start  → a dedicated Matrix account for the link (account.ts), a bridge login
 *            process (bridge.ts), the first QR / pairing code written to
 *            `matrix_links`, and a background DRIVER that long-polls the bridge.
 *   driver → every refreshed code is written to the row; completion opens the
 *            brand's `matrix_connections` row (the account's own sync token) and
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

import { and, eq } from "drizzle-orm";
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
  COUNTERPART_PREFIX,
  LINK_METHODS,
  bridgeLogins,
  cancelLogin,
  channelAvailability,
  logoutAll,
  startLogin,
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

export class LinkUnavailableError extends Error {
  constructor(readonly channel: MatrixChannel, readonly reason: string) {
    super(reason);
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
  userId: string;
  runId: string | null;
}

async function findLink(scope: LinkScope): Promise<MatrixLink | undefined> {
  const [row] = await db
    .select()
    .from(matrixLinks)
    .where(
      and(
        eq(matrixLinks.orgId, scope.orgId),
        eq(matrixLinks.brandId, scope.brandId),
        eq(matrixLinks.channel, scope.channel),
      ),
    );
  return row;
}

/**
 * Start (or restart) linking. Answers with the link as it stands once the
 * bridge has produced its first code. An already-linked channel is returned
 * as-is: relinking another account means unlinking first.
 *
 * Throws `LinkUnavailableError` for a channel whose bridge is not configured,
 * and `BridgeError` when the bridge refuses (its code + message are also
 * recorded on the row, so the next poll shows the same reason).
 */
export async function startLink(params: StartLinkParams): Promise<MatrixLink> {
  const availability = channelAvailability(params.channel);
  if (!availability.available) {
    throw new LinkUnavailableError(params.channel, availability.unavailableReason!);
  }

  const existing = await findLink(params);
  if (existing?.status === "linked") return existing;

  // A code already on screen for this brand is superseded by the new start.
  if (existing?.status === "waiting" && existing.matrixUserId && existing.bridgeProcessId) {
    await cancelLogin(params.channel, existing.matrixUserId, existing.bridgeProcessId);
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
    remoteLoginId: null,
    remoteName: null,
    errorCode: null,
    errorMessage: null,
    connectionId: null,
    runId: params.runId,
    startedAt: now,
    linkedAt: null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(matrixLinks)
    .values({ orgId: params.orgId, brandId: params.brandId, channel: params.channel, ...fresh })
    .onConflictDoUpdate({
      target: [matrixLinks.orgId, matrixLinks.brandId, matrixLinks.channel],
      set: fresh,
    })
    .returning();

  let step: LoginStep;
  try {
    step = await startLogin(params.channel, matrixUserId, params.method);
    if (step.type === "user_input") {
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

/** Route one bridge step: show a code and keep waiting, or finish. */
async function applyStep(linkId: string, channel: MatrixChannel, matrixUserId: string, step: LoginStep) {
  if (step.type === "complete") {
    await finalizeLink(linkId, step);
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

/** Write the current code. False when the row moved on (superseded/unlinked). */
async function writeDisplay(linkId: string, step: LoginStep): Promise<boolean> {
  const rows = await db
    .update(matrixLinks)
    .set({
      bridgeStepId: step.step_id,
      displayType: step.display_and_wait?.type ?? null,
      displayData: step.display_and_wait?.data ?? null,
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

async function markFailed(linkId: string, processId: string, code: string, message: string) {
  await db
    .update(matrixLinks)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: message,
      displayType: null,
      displayData: null,
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
 * login completes, fails, or the row is superseded.
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
 * The phone is linked: open (or re-point) the brand's Matrix connection on the
 * account's own sync token, mark the link linked, kick the first sync.
 */
async function finalizeLink(linkId: string, step: LoginStep) {
  const [link] = await db.select().from(matrixLinks).where(eq(matrixLinks.id, linkId));
  if (!link || link.status !== "waiting" || link.bridgeProcessId !== step.login_id || !link.matrixUserId) return;
  const channel = link.channel as MatrixChannel;

  const accessToken = await loginLinkAccount(link.matrixUserId);
  const connection = await db.transaction(async (tx) => {
    const values = {
      matrixUserId: link.matrixUserId!,
      counterpartPrefix: COUNTERPART_PREFIX[channel],
      accessToken,
      createdByUserId: link.createdByUserId,
      status: "active",
      lastError: null,
      // A new account has its own stream: never resume another account's cursor.
      sinceToken: null,
    };
    const [conn] = await tx
      .insert(matrixConnections)
      .values({ orgId: link.orgId, brandId: link.brandId, channel, ...values })
      .onConflictDoUpdate({
        target: [matrixConnections.orgId, matrixConnections.brandId, matrixConnections.channel],
        set: values,
      })
      .returning();
    await tx
      .update(matrixLinks)
      .set({
        status: "linked",
        remoteLoginId: step.complete?.user_login_id ?? null,
        connectionId: conn.id,
        displayType: null,
        displayData: null,
        instructions: step.instructions ?? null,
        linkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(matrixLinks.id, linkId));
    return conn;
  });

  console.log(`[crm-service][link] linked ${channel} link=${linkId} connection=${connection.id}`);
  setImmediate(() => {
    runSyncPass(connection.id).catch((err) =>
      console.error(`[crm-service][link] first sync failed connection=${connection.id}:`, err),
    );
  });
}

// ─── Read ────────────────────────────────────────────────────────────────────

export interface LinkView {
  channel: MatrixChannel;
  available: boolean;
  unavailableReason: string | null;
  methods: readonly LinkMethod[];
  status: "not_linked" | "waiting" | "linked" | "failed";
  method: LinkMethod | null;
  qr: { data: string; imageDataUrl: string } | null;
  pairingCode: string | null;
  instructions: string | null;
  codeIssuedAt: Date | null;
  account: { id: string; name: string | null } | null;
  bridgeState: { state: string | null; reason: string | null } | null;
  bridgeStateError: string | null;
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

/** Every channel for one brand, with what the dashboard shows for each. */
export async function listLinks(orgId: string, brandId: string): Promise<LinkView[]> {
  const rows = await db
    .select()
    .from(matrixLinks)
    .where(and(eq(matrixLinks.orgId, orgId), eq(matrixLinks.brandId, brandId)));
  const conns = await db
    .select()
    .from(matrixConnections)
    .where(and(eq(matrixConnections.orgId, orgId), eq(matrixConnections.brandId, brandId)));

  const views: LinkView[] = [];
  for (const channel of MATRIX_CHANNELS) {
    let link = rows.find((r) => r.channel === channel);
    if (link?.status === "waiting" && (!link.bridgeProcessId || !activeDrivers.has(link.bridgeProcessId))) {
      link = await interrupt(link);
    }
    const conn = link?.connectionId ? conns.find((c) => c.id === link!.connectionId) : undefined;
    views.push(await toView(channel, link, conn));
  }
  return views;
}

async function interrupt(link: MatrixLink): Promise<MatrixLink> {
  const [row] = await db
    .update(matrixLinks)
    .set({
      status: "failed",
      errorCode: INTERRUPTED.code,
      errorMessage: INTERRUPTED.message,
      displayType: null,
      displayData: null,
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

export async function toView(
  channel: MatrixChannel,
  link: MatrixLink | undefined,
  conn: MatrixConnection | undefined,
): Promise<LinkView> {
  const availability = channelAvailability(channel);
  const status: LinkView["status"] =
    !link || link.status === "unlinked" ? "not_linked" : (link.status as LinkView["status"]);
  const showing = status === "waiting" && link?.displayData ? link : null;

  let bridgeState: LinkView["bridgeState"] = null;
  let bridgeStateError: string | null = null;
  let accountName: string | null = null;
  if (status === "linked" && link?.matrixUserId && availability.available) {
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
    available: availability.available,
    unavailableReason: availability.unavailableReason,
    methods: availability.available ? LINK_METHODS : [],
    status,
    method: status === "not_linked" ? null : ((link?.method as LinkMethod) ?? null),
    qr:
      showing?.displayType === "qr"
        ? { data: showing.displayData!, imageDataUrl: await QRCode.toDataURL(showing.displayData!, { margin: 1, width: 320 }) }
        : null,
    pairingCode: showing?.displayType === "code" ? showing.displayData : null,
    instructions: status === "waiting" || status === "linked" ? (link?.instructions ?? null) : null,
    codeIssuedAt: showing ? showing.displayIssuedAt : null,
    account: status === "linked" && link?.remoteLoginId ? { id: link.remoteLoginId, name: accountName } : null,
    bridgeState,
    bridgeStateError,
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
    linkedAt: status === "linked" ? (link?.linkedAt ?? null) : null,
  };
}

export async function getLinkView(scope: LinkScope): Promise<LinkView> {
  const views = await listLinks(scope.orgId, scope.brandId);
  return views.find((v) => v.channel === scope.channel)!;
}

// ─── Unlink ──────────────────────────────────────────────────────────────────

export interface UnlinkResult {
  unlinked: boolean;
  contactsRemoved: number;
  connectionRemoved: boolean;
}

/**
 * Unlink: the bridge logs the account out (no more DMs reach it), the sync token
 * is revoked, and everything mirrored for the link's connection is deleted —
 * raw events, conversations and leads by cascade, Matrix contacts explicitly
 * (they carry the connection id but no foreign key). The next people build no
 * longer sees them; one is kicked right away.
 *
 * Only the connection THIS link opened is removed: a connection registered by
 * hand is not this route's to delete. Returns null when there is no link.
 */
export async function unlink(scope: LinkScope): Promise<UnlinkResult | null> {
  const link = await findLink(scope);
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
        instructions: null,
        remoteLoginId: null,
        remoteName: null,
        errorCode: null,
        errorMessage: null,
        connectionId: null,
        updatedAt: new Date(),
      })
      .where(eq(matrixLinks.id, link.id));
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

  return { unlinked: true, contactsRemoved, connectionRemoved: !!conn };
}
