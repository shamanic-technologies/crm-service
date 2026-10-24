/**
 * COST-ACCOUNTING-1023-P1 (owner 2026-10-23, doctrine: agent-config skill `cost-accounting`): a reply burst our
 * watch judged POSITIVE is an outcome occurrence, `conversation` (Positive reply), PRODUCED by the run whose Jev
 * call judged it, at runs-service (the production-cost ledger). Subject = the person's lead in lead-service
 * (`subjectService: "lead-service"`, the lead id), so the chain from find to sale names ONE subject. When the
 * account wrote before the burst, the reply CONSUMES the person's last `message_sent` (runs-service resolves the
 * consumption to the latest `message_sent` produced for that lead).
 *
 * - The judge run: every Jev call of one detection pass runs on ONE child run `reply-trigger.judge` of the pass
 *   (`lazyJudgeRun`), so only the judging spend lands on the positive replies (a rejected burst's judgment is a
 *   normal loss riding the kept ones), never the pass's lead reading or transcriptions.
 * - Never on the action's path: detection only marks the row `pending`; `declareDuePositiveReplies` (in-process,
 *   every minute) names the lead (lead-service `POST /internal/leads/ids/resolve`, nothing minted: a person who is
 *   not a lead yet is asked again) and declares. A failure is logged loud and retried (backoff up to 1 h); a
 *   400/404/409 from runs-service is `refused` (kept, logged); still no lead after 7 days = `no_lead`.
 * - One reply is declared once fleet-wide (settled with instantly-service, 2026-10-23): instantly-service owns
 *   every reply it files onto a cold sequence, whatever mailbox it came in. So a Gmail burst whose person our cold
 *   email wrote to (an `instantly` presence) is `not_ours`; a mail to a sending mailbox is never judged here
 *   (`cold_email_path`). A Jev outage (reported, never judged) and the Copilot's line (no Jev) declare nothing.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { people, replyTriggerReports, type ReplyTriggerReport } from "../../db/schema.js";
import { declareRunOutcomes, lazyChildRun, RunsServiceError, type DeclareOutcomesBody } from "../runs-client.js";
import { siblingQuery } from "../people/siblings.js";
import type { Presence } from "../people/identity.js";

export const POSITIVE_REPLY_OUTCOME = "conversation";
export const MESSAGE_SENT_OUTCOME = "message_sent";
export const LEAD_SUBJECT_SERVICE = "lead-service";
export const JUDGE_TASK = "reply-trigger.judge";

export const OUTCOME_STATUS = {
  PENDING: "pending",
  DECLARED: "declared",
  REFUSED: "refused",
  NO_LEAD: "no_lead",
  NOT_OURS: "not_ours",
} as const;

export const OUTCOME_REASONS = {
  PERSON_NOT_BUILT: "person_not_built",
  NO_RESOLVABLE_KEY: "no_resolvable_key",
  NOT_A_LEAD_YET: "not_a_lead_yet",
  LEAD_UNREADABLE: "lead_unreadable",
  RUNS_UNREACHABLE: "runs_unreachable",
  COLD_EMAIL_SEQUENCE: "cold_email_sequence",
} as const;

/** A person still not a lead (or not built) after this is given up: `no_lead`, logged. */
export const OUTCOME_GIVE_UP_MS = 7 * 24 * 3_600_000;
const BATCH = 200;
const INTERVAL_MS = () => Number(process.env.OUTCOME_DECLARATIONS_INTERVAL_MS) || 60_000;
const SERVICE_NAME = "crm-service";
const LOG = "[crm-service][reply-outcome]";

/**
 * PURE: what one positive reply states at runs-service. `occurredAt` (a backfilled past reply,
 * ./outcome-backfill.ts) makes it count as declared at that time; absent = on time.
 */
export function positiveReplyOutcomeBody(leadId: string, wroteBefore: boolean, occurredAt: string | null = null): DeclareOutcomesBody {
  const subject = { subjectService: LEAD_SUBJECT_SERVICE, subjectId: leadId };
  return {
    produced: [{ outcomeKey: POSITIVE_REPLY_OUTCOME, ...subject }],
    consumed: wroteBefore ? [{ outcomeKey: MESSAGE_SENT_OUTCOME, ...subject }] : [],
    ...(occurredAt ? { occurredAt } : {}),
  };
}

/**
 * PURE: the outcome columns of a burst at detection. Declared only when Jev JUDGED it (status ok) and the
 * verdict reported it: a positive reply our run produced. Anything else (skipped, Jev down, the Copilot's
 * line) states nothing.
 */
export function outcomeAtDetection(input: {
  judged: boolean;
  reported: boolean;
  judgeRunId: string | null;
  wroteBefore: boolean;
  now: number;
}): { judgeRunId: string | null; wroteBefore: boolean; outcomeStatus: string | null; outcomeNextAt: Date | null } {
  const declare = input.judged && input.reported && !!input.judgeRunId;
  return {
    judgeRunId: input.judged ? input.judgeRunId : null,
    wroteBefore: input.wroteBefore,
    outcomeStatus: declare ? OUTCOME_STATUS.PENDING : null,
    outcomeNextAt: declare ? new Date(input.now) : null,
  };
}

/** PURE: wait before the next try, 1, 2, 4... minutes, capped at 1 h. */
export function outcomeBackoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * One `reply-trigger.judge` child run per detection pass, opened on the first Jev call, closed by the caller.
 * Its spend is the judging only, and it is what the positive replies are declared on.
 */
export function lazyJudgeRun(parent: () => Promise<string>, ids: { orgId: string; userId: string; brandId: string }) {
  return lazyChildRun(parent, ids, { serviceName: SERVICE_NAME, taskName: JUDGE_TASK });
}

interface PersonKeys {
  emails: string[];
  phones: string[];
  humanId: string | null;
  presences: Presence[];
}

/** The brand's person this burst came from (the same lookups delivery uses), or null when not built yet. */
async function personOfReport(r: ReplyTriggerReport): Promise<PersonKeys | null> {
  const where =
    r.source === "gmail" && r.address
      ? sql`${people.identityKeys} @> ${JSON.stringify([`email:${r.address}`])}::jsonb`
      : r.conversationId
        ? sql`${people.presences} @> ${JSON.stringify([{ source: "matrix", detail: { conversationId: r.conversationId } }])}::jsonb`
        : null;
  if (!where) return null;
  const [row] = await db
    .select({ emails: people.emails, phones: people.phones, humanId: people.humanId, presences: people.presences })
    .from(people)
    .where(and(eq(people.orgId, r.orgId), eq(people.brandId, r.brandId), where))
    .limit(1);
  if (!row) return null;
  return { emails: row.emails as string[], phones: row.phones as string[], humanId: row.humanId, presences: row.presences as Presence[] };
}

/** One person, as lead-service's resolve reads it (email > humanId > phone there). Every key the person holds. */
export interface LeadResolveItem {
  orgId: string;
  brandIds: string[];
  email?: string;
  humanId?: string;
  phone?: string;
}

/**
 * PURE: what lead-service is asked for one burst's person, or null when no key it reads is held. Email = the
 * address the person wrote from (Gmail), else their first (lead-service's own first); humanId = human-service's;
 * phone = their first E.164 number (most WhatsApp writers hold no email).
 */
export function leadResolveItem(r: { orgId: string; brandId: string; address: string | null }, person: PersonKeys): LeadResolveItem | null {
  const email = r.address ?? person.emails[0];
  const phone = person.phones.find((p) => /^\+\d{6,15}$/.test(p));
  if (!email && !person.humanId && !phone) return null;
  return {
    orgId: r.orgId,
    brandIds: [r.brandId],
    ...(email ? { email } : {}),
    ...(person.humanId ? { humanId: person.humanId } : {}),
    ...(phone ? { phone } : {}),
  };
}

/** PURE: a Gmail person our cold email wrote to: instantly-service owns their replies (settled 2026-10-23). */
export function coldEmailSequenceOwns(r: { source: string }, person: PersonKeys): boolean {
  return r.source === "gmail" && person.presences.some((p) => p.source === "instantly");
}

async function setOutcome(id: string, set: Partial<ReplyTriggerReport>): Promise<void> {
  await db.update(replyTriggerReports).set(set).where(eq(replyTriggerReports.id, id));
}

/** Not done yet: try again later, or give up (`no_lead`) once the person had 7 days to become a lead. */
async function retryLater(r: ReplyTriggerReport, now: number, reason: string, error: string | null, giveUp: boolean): Promise<string> {
  const attempts = r.outcomeAttempts + 1;
  if (giveUp && now - r.detectedAt.getTime() > OUTCOME_GIVE_UP_MS) {
    console.error(`${LOG} reply ${r.id} (brand ${r.brandId}): no lead after 7 days (${reason}), Positive reply NOT declared`);
    await setOutcome(r.id, { outcomeStatus: OUTCOME_STATUS.NO_LEAD, outcomeReason: reason, outcomeAttempts: attempts, outcomeLastError: error, outcomeNextAt: null });
    return OUTCOME_STATUS.NO_LEAD;
  }
  await setOutcome(r.id, {
    outcomeReason: reason,
    outcomeAttempts: attempts,
    outcomeLastError: error,
    outcomeNextAt: new Date(now + outcomeBackoffMs(attempts)),
  });
  return reason;
}

export interface DeclarationPass {
  due: number;
  declared: number;
  outcomes: Record<string, number>;
}

/** Declare every due positive reply. Never throws per row: each row records why it waits. */
export async function declareDuePositiveReplies(now: number = Date.now()): Promise<DeclarationPass> {
  const rows = await db
    .select()
    .from(replyTriggerReports)
    .where(and(eq(replyTriggerReports.outcomeStatus, OUTCOME_STATUS.PENDING), lte(replyTriggerReports.outcomeNextAt, new Date(now))))
    .orderBy(asc(replyTriggerReports.outcomeNextAt))
    .limit(BATCH);
  const pass: DeclarationPass = { due: rows.length, declared: 0, outcomes: {} };
  const count = (k: string) => (pass.outcomes[k] = (pass.outcomes[k] ?? 0) + 1);

  const asks: Array<{ r: ReplyTriggerReport; item: LeadResolveItem }> = [];
  for (const r of rows) {
    const person = await personOfReport(r);
    if (!person) {
      count(await retryLater(r, now, OUTCOME_REASONS.PERSON_NOT_BUILT, null, true));
      continue;
    }
    if (coldEmailSequenceOwns(r, person)) {
      await setOutcome(r.id, { outcomeStatus: OUTCOME_STATUS.NOT_OURS, outcomeReason: OUTCOME_REASONS.COLD_EMAIL_SEQUENCE, outcomeNextAt: null });
      count(OUTCOME_STATUS.NOT_OURS);
      continue;
    }
    const item = leadResolveItem(r, person);
    if (!item) {
      count(await retryLater(r, now, OUTCOME_REASONS.NO_RESOLVABLE_KEY, null, true));
      continue;
    }
    asks.push({ r, item });
  }

  // One lead-service read per org (the resolve is service-auth; the identity headers name the org asked about).
  const byOrg = new Map<string, typeof asks>();
  for (const a of asks) (byOrg.get(a.r.orgId) ?? byOrg.set(a.r.orgId, []).get(a.r.orgId)!).push(a);
  for (const [orgId, group] of byOrg) {
    let answers: Array<{ leadId: string | null }>;
    try {
      const res = await siblingQuery<{ people: Array<{ leadId: string | null }> }>(
        "lead",
        "/internal/leads/ids/resolve",
        { orgId, userId: "", runId: group[0].r.judgeRunId!, brandId: group[0].r.brandId },
        { people: group.map((a) => a.item) },
      );
      answers = res.people;
      if (!Array.isArray(answers) || answers.length !== group.length) throw new Error(`answered ${answers?.length} of ${group.length}`);
    } catch (err) {
      const error = (err as Error).message.slice(0, 1000);
      console.error(`${LOG} lead-service resolve failed for org ${orgId} (${group.length} replies), retried: ${error}`);
      for (const { r } of group) count(await retryLater(r, now, OUTCOME_REASONS.LEAD_UNREADABLE, error, false));
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      const { r } = group[i];
      const leadId = answers[i].leadId;
      if (!leadId) {
        count(await retryLater(r, now, OUTCOME_REASONS.NOT_A_LEAD_YET, null, true));
        continue;
      }
      try {
        const answer = await declareRunOutcomes(r.judgeRunId!, r.orgId, positiveReplyOutcomeBody(leadId, r.wroteBefore === true, r.outcomeOccurredAt));
        await setOutcome(r.id, {
          outcomeStatus: OUTCOME_STATUS.DECLARED,
          outcomeReason: answer.recordedCount > 0 ? "recorded" : "already_recorded",
          outcomeLeadId: leadId,
          outcomeAttempts: r.outcomeAttempts + 1,
          outcomeLastError: null,
          outcomeNextAt: null,
          outcomeDeclaredAt: new Date(now),
        });
        pass.declared += 1;
        count(OUTCOME_STATUS.DECLARED);
      } catch (err) {
        const error = (err as Error).message.slice(0, 1000);
        if (err instanceof RunsServiceError && err.kind === "http" && [400, 404, 409].includes(err.status ?? 0)) {
          console.error(`${LOG} runs-service REFUSED the Positive reply of reply ${r.id} (run ${r.judgeRunId}, lead ${leadId}): ${error}`);
          await setOutcome(r.id, {
            outcomeStatus: OUTCOME_STATUS.REFUSED,
            outcomeLeadId: leadId,
            outcomeAttempts: r.outcomeAttempts + 1,
            outcomeLastError: error,
            outcomeNextAt: null,
          });
          count(OUTCOME_STATUS.REFUSED);
          continue;
        }
        console.error(`${LOG} declaring reply ${r.id} on run ${r.judgeRunId} failed, retried: ${error}`);
        count(await retryLater({ ...r, outcomeLeadId: leadId }, now, OUTCOME_REASONS.RUNS_UNREACHABLE, error, false));
      }
    }
  }
  if (pass.due > 0) console.log(`${LOG} pass: ${JSON.stringify(pass)}`);
  return pass;
}

let running = false;

/** Every minute (first ~60 s after boot), one pass at a time. `OUTCOME_DECLARATIONS=off` stops it. */
export function startOutcomeDeclarations(): void {
  if (process.env.OUTCOME_DECLARATIONS === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    declareDuePositiveReplies()
      .catch((e) => console.error(`${LOG} pass failed:`, e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS()).unref();
  }, 60_000).unref();
}
