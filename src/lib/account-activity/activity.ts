/**
 * CLIENT-ACTIVITY-1030 (owner 2026-10-30: « ajouter une ligne quand un client update les budgets d'une de ses
 * campagnes, édite / crée une campagne ? Aussi envoie un message TG quand une de ces choses arrive »): what a client
 * DID on their account with us, one line on their staff Unibox thread + one owner Telegram per fact.
 *
 * ONE generic intake for every producer (`POST /internal/account-activity`): the service that performed the action
 * (campaign-service: created / edited / paused / resumed; billing-service: a campaign budget changed; any later one)
 * reports it after its write committed, forwarding the request's identity headers (x-org-id, x-user-id, x-email).
 * The producer states the words (`title`, the subject's name, each change's before / after as the customer reads
 * them); crm-service composes the line, never a per-producer branch.
 *
 * Rules (fleet, owner-stated):
 *  - never the owner's own actions, never a test: a staff address, a user id ever seen with one, an act inside the
 *    staff org = stored `skipped`, no line, no Telegram. A client acting through the AI Copilot is the client;
 *  - never fails or slows the reporter: the route stores and answers, the rest runs in the background, never throws;
 *    a step that could not run (client-service down) stays `pending` and the loop retries it for 24 h;
 *  - never twice: one row per (producer, activityId); the ping is claimed on the row (`ping_status` null → sending)
 *    before the send, so a retried report or two passes at once ping once;
 *  - never history: a fact older than 24 h when filed is shown on the thread, never pinged;
 *  - no em / en dash in the line or the ping (owner copy rule), stripped from the producer's words.
 */

import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { accountActivities, type AccountActivity } from "../../db/schema.js";
import { copilotDestination, type CopilotDestination } from "../copilot/messages.js";
import { isStaffActor, mintPersonId, readOrg, uniboxThreadUrl } from "../conversation-pings.js";
import { emailKey, normalizeEmail } from "../people/identity.js";
import { activityLine, noDashes, type ActivityChange } from "./line.js";

export { activityLine, noDashes, type ActivityChange };
import { siblingGet, type SiblingIdentity } from "../people/siblings.js";
import { brandNamesFor } from "../people/timeline.js";
import { sendOwnerTelegram } from "../owner-telegram.js";

/** A fact older than this when filed is shown, never pinged (never history). */
export const ACTIVITY_PING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A row still unresolved after this is left alone (logged once per pass). */
const ACTIVITY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_WATCH_INTERVAL_MS = 60_000;

export interface ActivitySubject {
  kind: string;
  id?: string | null;
  name?: string | null;
}

export interface AccountActivityInput {
  producer: string;
  activityId: string;
  type: string;
  title: string;
  subject?: ActivitySubject | null;
  changes?: ActivityChange[];
  via?: string | null;
  brandId?: string | null;
  occurredAt: string;
}

export interface ActivityActor {
  orgId: string;
  userId: string | null;
  email: string | null;
  name: string | null;
}

// ─── pure ───────────────────────────────────────────────────────────────────

export interface ActivityPingContent {
  line: string;
  email: string;
  name: string | null;
  orgName: string | null;
  brandName: string | null;
  via: string | null;
  threadUrl: string | null;
}

/**
 * PURE: the owner's Telegram, one fact per line (same family as the conversation / assistant pings):
 *   Chaim Tesser · Campaign created: "ABA Owners Meetings"
 *   Who: Chaim Tesser (chaim@aba.com)
 *   Org: ABA Owners
 *   Brand: ABA
 *   Via: AI Copilot
 *   Thread: https://dashboard.distribute.you/v2/orgs/…/unibox?person=…
 */
export function composeActivityPing(c: ActivityPingContent): string {
  const lines = [c.line];
  lines.push(`Who: ${c.name ? `${c.name} (${c.email})` : c.email}`);
  if (c.orgName) lines.push(`Org: ${c.orgName}`);
  if (c.brandName) lines.push(`Brand: ${c.brandName}`);
  if (c.via) lines.push(`Via: ${c.via}`);
  if (c.threadUrl) lines.push(`Thread: ${c.threadUrl}`);
  return lines.map(noDashes).join("\n");
}

// ─── intake ─────────────────────────────────────────────────────────────────

/** Stores one reported fact. Idempotent on (producer, activityId): a retried report stores nothing. */
export async function storeActivity(
  input: AccountActivityInput,
  actor: ActivityActor,
  runId: string,
): Promise<{ id: string; duplicate: boolean }> {
  const [row] = await db
    .insert(accountActivities)
    .values({
      producer: input.producer,
      activityId: input.activityId,
      type: input.type,
      title: noDashes(input.title),
      subject: input.subject
        ? { kind: input.subject.kind, id: input.subject.id ?? null, name: input.subject.name ? noDashes(input.subject.name) : null }
        : null,
      changes: (input.changes ?? []).map((c) => ({
        label: noDashes(c.label),
        before: c.before == null ? null : noDashes(c.before),
        after: c.after == null ? null : noDashes(c.after),
      })),
      via: input.via?.trim() || null,
      accountOrgId: actor.orgId,
      accountBrandId: input.brandId ?? null,
      actorUserId: actor.userId,
      actorEmail: normalizeEmail(actor.email),
      actorName: actor.name?.trim() || null,
      occurredAt: new Date(input.occurredAt),
      runId,
    })
    .onConflictDoNothing({ target: [accountActivities.producer, accountActivities.activityId] })
    .returning({ id: accountActivities.id });
  if (row) return { id: row.id, duplicate: false };
  const [existing] = await db
    .select({ id: accountActivities.id })
    .from(accountActivities)
    .where(and(eq(accountActivities.producer, input.producer), eq(accountActivities.activityId, input.activityId)))
    .limit(1);
  return { id: existing.id, duplicate: true };
}

// ─── resolving the actor, filing, pinging ───────────────────────────────────

async function readUser(userId: string, identity: SiblingIdentity): Promise<{ email: string | null; name: string | null } | null> {
  const r = await siblingGet("client", `/internal/users/${encodeURIComponent(userId)}`, identity);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`client-service GET /internal/users/${userId} returned ${r.status}`);
  const u = (r.body as { user?: { email?: string | null; firstName?: string | null; lastName?: string | null } }).user;
  const name = [u?.firstName, u?.lastName].map((x) => x?.trim()).filter(Boolean).join(" ");
  return { email: normalizeEmail(u?.email ?? null), name: name || null };
}

/** Each lookup on its own: one that fails drops its line from the ping, logged, never the ping. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[crm-service][activity] ping: ${what} unreadable:`, (err as Error).message);
    return null;
  }
}

async function setRow(id: string, patch: Partial<typeof accountActivities.$inferInsert>): Promise<void> {
  await db.update(accountActivities).set({ ...patch, updatedAt: new Date() }).where(eq(accountActivities.id, id));
}

export type ActivityOutcome =
  | { status: "filed"; ping: "sent" | "failed" | "unconfigured" | "skipped" | "already" }
  | { status: "skipped"; reason: string }
  | { status: "pending"; error: string }
  | { status: "not_configured" };

/** Resolves who acted (filed or skipped). Writes the row. Throws only on a database error. */
async function resolve(row: AccountActivity, dest: CopilotDestination, runId: string): Promise<AccountActivity | ActivityOutcome> {
  if (row.accountOrgId === dest.orgId) {
    await setRow(row.id, { status: "skipped", reason: "staff_org" });
    return { status: "skipped", reason: "staff_org" };
  }
  // Only a person acts on an account; a fact no user stated (a scheduled job) is nobody's line.
  if (!row.actorUserId) {
    await setRow(row.id, { status: "skipped", reason: "no_actor" });
    return { status: "skipped", reason: "no_actor" };
  }
  let email = row.actorEmail;
  let name = row.actorName;
  if (!email || !name) {
    try {
      const u = await readUser(row.actorUserId, { orgId: dest.orgId, userId: row.actorUserId, runId, brandId: dest.brandId });
      email ??= u?.email ?? null;
      name ??= u?.name ?? null;
    } catch (err) {
      if (!email) {
        const error = (err as Error).message;
        await setRow(row.id, { attempts: row.attempts + 1, lastError: error });
        return { status: "pending", error };
      }
    }
  }
  if (!email) {
    await setRow(row.id, { status: "skipped", reason: "actor_unknown" });
    return { status: "skipped", reason: "actor_unknown" };
  }
  // A staff address, or a user id ever seen with one (a session of a person ever him), is never a client.
  if (await isStaffActor(email, row.actorUserId)) {
    await setRow(row.id, { status: "skipped", reason: "staff", actorEmail: email, actorName: name });
    return { status: "skipped", reason: "staff" };
  }
  await setRow(row.id, { status: "filed", reason: null, lastError: null, actorEmail: email, actorName: name });
  return { ...row, status: "filed", actorEmail: email, actorName: name };
}

async function ping(row: AccountActivity, dest: CopilotDestination, runId: string): Promise<"sent" | "failed" | "unconfigured" | "skipped" | "already"> {
  if (Date.now() - row.occurredAt.getTime() > ACTIVITY_PING_MAX_AGE_MS) {
    const [claimed] = await db
      .update(accountActivities)
      .set({ pingStatus: "skipped", pingError: "older than 24 h when filed (never history)", updatedAt: new Date() })
      .where(and(eq(accountActivities.id, row.id), isNull(accountActivities.pingStatus)))
      .returning({ id: accountActivities.id });
    return claimed ? "skipped" : "already";
  }
  // Claimed BEFORE the send: a retried report or a concurrent pass never pings again.
  const [claimed] = await db
    .update(accountActivities)
    .set({ pingStatus: "sending", updatedAt: new Date() })
    .where(and(eq(accountActivities.id, row.id), isNull(accountActivities.pingStatus)))
    .returning({ id: accountActivities.id });
  if (!claimed) return "already";

  const email = row.actorEmail!;
  const identity: SiblingIdentity = { orgId: dest.orgId, userId: row.actorUserId!, runId, brandId: dest.brandId };
  const [org, brandNames, staffOrg, personId] = await Promise.all([
    attempt("client org", () => readOrg(row.accountOrgId, identity)),
    row.accountBrandId ? brandNamesFor([row.accountBrandId], identity) : Promise.resolve(new Map<string, string>()),
    attempt("staff org Clerk id", () => readOrg(dest.orgId, identity)),
    attempt("person id", () => mintPersonId(dest, emailKey(email))),
  ]);
  if (!staffOrg?.externalId) console.error(`[crm-service][activity] no Clerk id for the staff org ${dest.orgId}: sent without a thread link`);
  const text = composeActivityPing({
    line: activityLine({ title: row.title, subject: row.subject, changes: row.changes, actorName: row.actorName }),
    email,
    name: row.actorName,
    orgName: org?.name ?? null,
    brandName: row.accountBrandId ? brandNames.get(row.accountBrandId) ?? null : null,
    via: row.via,
    threadUrl: staffOrg?.externalId && personId ? uniboxThreadUrl(staffOrg.externalId, dest.brandId, personId) : null,
  });
  const result = await sendOwnerTelegram(text);
  await setRow(row.id, {
    pingStatus: result.status,
    pingText: text,
    pingError: result.status === "sent" ? null : result.error,
    telegramMessageId: result.status === "sent" ? result.messageId : null,
    pingedAt: new Date(),
  });
  if (result.status === "sent") console.log(`[crm-service][activity] ${row.producer}:${row.activityId} pinged (telegram message ${result.messageId})`);
  return result.status;
}

/** Files one stored fact on its actor's thread and pings the owner once. Never throws. */
export async function processActivity(id: string, runId: string): Promise<ActivityOutcome> {
  try {
    const dest = copilotDestination();
    if (!dest) {
      console.error("[crm-service][activity] COPILOT_UNIBOX_ORG_ID / COPILOT_UNIBOX_BRAND_ID not set: nowhere to file account activity");
      return { status: "not_configured" };
    }
    const [row] = await db.select().from(accountActivities).where(eq(accountActivities.id, id)).limit(1);
    if (!row) throw new Error(`account activity ${id} not found`);
    let filed: AccountActivity;
    if (row.status === "pending") {
      const r = await resolve(row, dest, runId);
      if (!("id" in r)) {
        if (r.status === "pending") console.error(`[crm-service][activity] ${row.producer}:${row.activityId} actor unreadable (retried): ${r.error}`);
        return r;
      }
      filed = r;
    } else if (row.status === "filed") {
      filed = row;
    } else {
      return { status: "skipped", reason: row.reason ?? "skipped" };
    }
    return { status: "filed", ping: await ping(filed, dest, runId) };
  } catch (err) {
    console.error(`[crm-service][activity] processing ${id} failed:`, err);
    return { status: "pending", error: (err as Error).message };
  }
}

/** One pass over every fact still waiting (actor unresolved, or filed and never pinged), last 24 h. */
export async function activityWatchNow(runId: string): Promise<{ processed: number }> {
  const since = new Date(Date.now() - ACTIVITY_RETRY_WINDOW_MS);
  const rows = await db
    .select({ id: accountActivities.id })
    .from(accountActivities)
    .where(
      and(
        gt(accountActivities.receivedAt, since),
        // Never a row just received: its own request is processing it.
        lt(accountActivities.receivedAt, new Date(Date.now() - 30_000)),
        or(eq(accountActivities.status, "pending"), and(eq(accountActivities.status, "filed"), isNull(accountActivities.pingStatus))),
      ),
    )
    .orderBy(asc(accountActivities.receivedAt))
    .limit(200);
  for (const r of rows) await processActivity(r.id, runId);
  return { processed: rows.length };
}

export function startActivityWatch(): void {
  if (process.env.ACCOUNT_ACTIVITY_WATCH === "off") return;
  const tick = () => {
    activityWatchNow("account-activity-watch")
      .then((r) => {
        if (r.processed > 0) console.log(`[crm-service][activity] retry pass: ${r.processed} processed`);
      })
      .catch((e) => console.error("[crm-service][activity] retry pass failed:", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, ACTIVITY_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}
