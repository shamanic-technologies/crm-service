/**
 * OWNER DOOR (EMAIL-REPLY-ORPHAN-1027): re-check the LEGACY `skipped / cold_email_path` Gmail bursts, decided on
 * the recipient alone ("addressed to one of our sending mailboxes") before the email path stated what it acts on.
 * Some of them nobody acted on (pabitrahalder1979@gmail.com, 2026-10-27, a thread the owner opened by hand).
 *
 * Each row is decided again by the SAME rules as detection (`decideGmailBurst`): the email path acts on it =
 * `handed_off` with its answer; else own team / owning brand / automated / Jev, and a positive burst is `pending`
 * and delivered at once to campaign-service's trigger door (the Lead event campaign writes the answer). A burst the
 * brand has answered since = `answered_since` (nobody waits). The email path unreadable = the row is left as it was.
 *
 * `dryRun` (the default) asks the email path and reads the thread, writes nothing and calls no Jev. A real run needs
 * the explicit `reportIds` the owner picked (leads only: never a client, a staff test or an automated sender).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleScopes, replyTriggerReports, type PeopleScope, type ReplyTriggerReport } from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { askEmailPath, type EmailPathAnswer } from "./email-path.js";
import { readEmailThreadForReply, type EmailBurstMessage } from "./email-thread.js";
import {
  decideGmailBurst,
  deliverScopeGmailReports,
  GMAIL_REPLY_REASONS,
  GMAIL_SOURCE,
  ownAddressesOnce,
  storedConversation,
} from "./gmail.js";
import { lazyJudgeRun, outcomeAtDetection } from "./outcome.js";
import { REPLY_STATUS } from "./watch.js";

export interface RecheckRow {
  reportId: string;
  address: string | null;
  firstMessageAt: string;
  /** What the re-check decided (dry run: what it would decide before Jev). */
  outcome: "handed_off" | "answered_since" | "decided" | "not_owner" | "unreadable" | "would_decide" | "not_legacy";
  status: string | null;
  reason: string | null;
  emailPath: EmailPathAnswer | null;
  error: string | null;
  delivery: { status: string; reason: string | null } | null;
}

/** The legacy rows: skipped as the email path's with no answer from it. */
async function legacyRows(reportIds?: string[]): Promise<ReplyTriggerReport[]> {
  return db
    .select()
    .from(replyTriggerReports)
    .where(
      and(
        eq(replyTriggerReports.source, GMAIL_SOURCE),
        eq(replyTriggerReports.status, REPLY_STATUS.SKIPPED),
        eq(replyTriggerReports.reason, GMAIL_REPLY_REASONS.COLD_EMAIL_PATH),
        isNull(replyTriggerReports.emailPathAnswer),
        ...(reportIds ? [inArray(replyTriggerReports.id, reportIds)] : []),
      ),
    )
    .orderBy(replyTriggerReports.firstMessageAt, replyTriggerReports.id);
}

/** PURE: the burst as the store holds it now, from the row's first mail; null = the brand answered since. */
export function burstFromAnchor(reading: ReturnType<typeof readEmailThreadForReply>, anchorId: string): EmailBurstMessage[] | null {
  if (reading.kind !== "unanswered") return null;
  const from = reading.burst.findIndex((m) => m.messageId === anchorId);
  return from >= 0 ? reading.burst.slice(from) : null;
}

export async function recheckLegacyColdEmailSkips(
  input: { reportIds?: string[]; dryRun: boolean },
  now: number = Date.now(),
): Promise<{ dryRun: boolean; rows: RecheckRow[] }> {
  if (!input.dryRun && !input.reportIds?.length) throw new Error("a real re-check needs the reportIds the owner picked");
  const rows = await legacyRows(input.reportIds);
  const out: RecheckRow[] = [];
  for (const id of input.reportIds ?? []) {
    if (!rows.some((r) => r.id === id)) {
      out.push({ reportId: id, address: null, firstMessageAt: "", outcome: "not_legacy", status: null, reason: null, emailPath: null, error: null, delivery: null });
    }
  }
  const byScope = new Map<string, ReplyTriggerReport[]>();
  for (const r of rows) if (r.scopeId && r.address) byScope.set(r.scopeId, [...(byScope.get(r.scopeId) ?? []), r]);

  for (const [scopeId, reports] of byScope) {
    const [scope] = await db.select().from(peopleScopes).where(eq(peopleScopes.id, scopeId));
    if (!scope) continue;
    const decided = await recheckScope(scope, reports, input.dryRun, now);
    out.push(...decided);
    if (input.dryRun) continue;
    const pending = decided.filter((d) => d.status === REPLY_STATUS.PENDING).map((d) => d.reportId);
    if (pending.length === 0) continue;
    const fresh = await db.select().from(replyTriggerReports).where(inArray(replyTriggerReports.id, pending));
    for (const d of await deliverScopeGmailReports(scope, fresh, Date.now(), {})) {
      const row = out.find((o) => o.reportId === d.reportId);
      if (row) row.delivery = { status: d.status, reason: d.reason };
    }
  }
  return { dryRun: input.dryRun, rows: out };
}

async function recheckScope(scope: PeopleScope, reports: ReplyTriggerReport[], dryRun: boolean, now: number): Promise<RecheckRow[]> {
  let runIdPromise: Promise<string> | null = null;
  const runId = () =>
    (runIdPromise ??= createRun({
      orgId: scope.orgId,
      userId: scope.createdByUserId,
      brandIds: [scope.brandId],
      serviceName: "crm-service",
      taskName: "reply-trigger.recheck-gmail",
    }).then((r) => r.id));
  const judge = lazyJudgeRun(runId, { orgId: scope.orgId, userId: scope.createdByUserId, brandId: scope.brandId });
  const ownAddresses = ownAddressesOnce(scope, runId);
  const out: RecheckRow[] = [];
  let failed = false;
  try {
    for (const r of reports) {
      const row: RecheckRow = {
        reportId: r.id,
        address: r.address,
        firstMessageAt: r.firstMessageAt.toISOString(),
        outcome: "would_decide",
        status: r.status,
        reason: r.reason,
        emailPath: null,
        error: null,
        delivery: null,
      };
      out.push(row);
      const reading = readEmailThreadForReply(await storedConversation(scope.id, r.address!));
      const burst = burstFromAnchor(reading, r.anchorEventId);
      if (!burst) {
        row.outcome = "answered_since";
        row.reason = GMAIL_REPLY_REASONS.ANSWERED_SINCE;
        if (!dryRun) await db.update(replyTriggerReports).set({ reason: GMAIL_REPLY_REASONS.ANSWERED_SINCE }).where(eq(replyTriggerReports.id, r.id));
        continue;
      }
      if (dryRun) {
        try {
          const identity = { orgId: scope.orgId, userId: scope.createdByUserId, runId: await runId(), brandId: scope.brandId };
          row.emailPath = await askEmailPath(identity, burst.map((m) => ({ messageId: m.messageId, from: r.address!, to: m.to, at: m.at })), now);
          if (row.emailPath.owner === "email_path") row.outcome = "handed_off";
        } catch (err) {
          row.outcome = "unreadable";
          row.error = (err as Error).message;
        }
        continue;
      }
      const decision = await decideGmailBurst(scope, r.address!, burst, burst, { runId, judge, ownAddresses, now });
      if (decision.kind === "unreadable") {
        row.outcome = "unreadable";
        row.error = decision.error;
        continue;
      }
      if (decision.kind === "not_owner") {
        row.outcome = "not_owner";
        row.reason = GMAIL_REPLY_REASONS.OTHER_BRAND;
        await db.update(replyTriggerReports).set({ reason: GMAIL_REPLY_REASONS.OTHER_BRAND }).where(eq(replyTriggerReports.id, r.id));
        continue;
      }
      const outcome = outcomeAtDetection({
        judged: decision.judged,
        reported: decision.reported,
        judgeRunId: decision.judged ? await judge.opened() : null,
        wroteBefore: reading.kind === "unanswered" && reading.wroteBefore,
        now,
      });
      await db
        .update(replyTriggerReports)
        .set({
          ...outcome,
          messages: burst,
          lastMessageAt: new Date(burst[burst.length - 1].at),
          judgment: decision.judgment,
          emailPathAnswer: decision.emailPathAnswer,
          status: decision.status,
          reason: decision.reason,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
        })
        .where(eq(replyTriggerReports.id, r.id));
      row.outcome = decision.status === "handed_off" ? "handed_off" : "decided";
      row.status = decision.status;
      row.reason = decision.reason;
      row.emailPath = decision.emailPathAnswer;
      console.log(`[crm-service][reply-trigger] re-checked legacy Gmail skip ${r.id} (${r.address}): ${decision.status}${decision.reason ? `/${decision.reason}` : ""}`);
    }
    return out;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await judge.close(failed);
    if (runIdPromise) {
      const id = await (runIdPromise as Promise<string>).catch(() => null);
      if (id) await updateRun(id, failed ? "failed" : "completed", { orgId: scope.orgId, userId: scope.createdByUserId }).catch((e) => console.error(`[crm-service][reply-trigger] failed to close re-check run ${id}:`, e));
    }
  }
}
