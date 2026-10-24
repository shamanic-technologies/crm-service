/**
 * LEDGER-HISTORY-1024 (owner 2026-10-24: « un message WhatsApp/LinkedIn envoyé est un `message_sent` comme un email »;
 * doctrine: agent-config skill `cost-accounting`): a message a CAMPAIGN sent from the brand's linked WhatsApp is an
 * outcome occurrence, `message_sent`, PRODUCED by the run that sent it (the `whatsapp.send` request run,
 * `whatsapp_sends.run_id`), subject = the person's lead in lead-service, exactly as instantly-service states an email.
 * A Positive reply on the thread then consumes it (./../reply-trigger/outcome.ts).
 *
 * - A pipe's message = a send carrying the campaign that sent it (`x-campaign-id`, `campaign_id`): one structural rule,
 *   every key prefix alike. A send with no campaign (the Copilot answering on its line, a staff probe) is no pipe's
 *   production and states nothing; its own run spends nothing anyway.
 * - One occurrence per send RUN: several bubbles of one send are one message (one run, one subject).
 * - ONE path for past and future: every pass records each campaign send not recorded yet, names its lead (lead-service
 *   `POST /internal/leads/ids/resolve`, nothing minted) and declares through runs-service's batch door with
 *   `occurredAt` = the send's `sent_at`, so a message sent on Oct 12 counts on Oct 12. Not a lead yet = asked again
 *   (backoff to 1 h), `no_lead` 7 days after it was first recorded; a 422 run = `refused` (kept, logged).
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messageSentDeclarations, type MessageSentDeclaration } from "../../db/schema.js";
import { declareOutcomesBatch, invalidRunsOf, type BatchRunOutcomes } from "../runs-client.js";
import { siblingQuery } from "../people/siblings.js";
import { LEAD_SUBJECT_SERVICE, MESSAGE_SENT_OUTCOME, OUTCOME_GIVE_UP_MS, outcomeBackoffMs } from "../reply-trigger/outcome.js";

export const STATUS = { PENDING: "pending", DECLARED: "declared", NO_LEAD: "no_lead", REFUSED: "refused" } as const;
const MAX_RUNS = 500;
const INTERVAL_MS = () => Number(process.env.MESSAGE_SENT_INTERVAL_MS) || 60_000;
const LOG = "[crm-service][message-sent]";

/** PURE: what lead-service is asked for one send, or null when it holds no key lead-service reads. */
export function sendResolveItem(r: Pick<MessageSentDeclaration, "orgId" | "brandId" | "email" | "phone">) {
  const phone = r.phone && /^\+\d{6,15}$/.test(r.phone) ? r.phone : null;
  if (!r.email && !phone) return null;
  return { orgId: r.orgId, brandIds: [r.brandId], ...(r.email ? { email: r.email } : {}), ...(phone ? { phone } : {}) };
}

/** PURE: one batch entry per send run, its message on its lead, dated when it was sent. */
export function messageSentBatchBody(rows: Array<{ runId: string; leadId: string; sentAt: Date }>): BatchRunOutcomes[] {
  return rows.map((r) => ({
    runId: r.runId,
    produced: [{ outcomeKey: MESSAGE_SENT_OUTCOME, subjectService: LEAD_SUBJECT_SERVICE, subjectId: r.leadId }],
    occurredAt: r.sentAt.toISOString(),
  }));
}

/** Record every campaign send not recorded yet (one row per send run, its first bubble). */
export async function recordNewSends(): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO message_sent_declarations (org_id, brand_id, run_id, send_id, campaign_id, email, phone, sent_at, status, next_at)
    SELECT DISTINCT ON (s.run_id) s.org_id, s.brand_id, s.run_id, s.id, s.campaign_id, lower(s.email), s.phone, s.sent_at, 'pending', s.sent_at
    FROM whatsapp_sends s
    WHERE s.status = 'sent' AND s.campaign_id IS NOT NULL AND s.run_id IS NOT NULL AND s.sent_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM message_sent_declarations d WHERE d.run_id = s.run_id)
    ORDER BY s.run_id, s.sent_at
    ON CONFLICT (run_id) DO NOTHING
    RETURNING id`);
  return (res as unknown as unknown[]).length;
}

export interface MessageSentPass {
  recorded: number;
  due: number;
  declared: number;
  alreadyRecorded: number;
  waiting: number;
  noLead: number;
  refused: number;
  failed: number;
}

async function waitOrGiveUp(r: MessageSentDeclaration, now: number, reason: string, error: string | null, giveUp: boolean, pass: MessageSentPass) {
  const attempts = r.attempts + 1;
  if (giveUp && now - r.createdAt.getTime() > OUTCOME_GIVE_UP_MS) {
    console.error(`${LOG} send run ${r.runId} (brand ${r.brandId}): no lead after 7 days (${reason}), message_sent NOT declared`);
    await db
      .update(messageSentDeclarations)
      .set({ status: STATUS.NO_LEAD, reason, attempts, lastError: error, nextAt: null })
      .where(eq(messageSentDeclarations.id, r.id));
    pass.noLead += 1;
    return;
  }
  await db
    .update(messageSentDeclarations)
    .set({ reason, attempts, lastError: error, nextAt: new Date(now + outcomeBackoffMs(attempts)) })
    .where(eq(messageSentDeclarations.id, r.id));
  if (error) pass.failed += 1;
  else pass.waiting += 1;
}

/** Name each due send's lead, then declare. Never throws per row: each row records why it waits. */
export async function declareDueSends(now: number = Date.now(), pass: MessageSentPass = emptyPass()): Promise<MessageSentPass> {
  const rows = await db
    .select()
    .from(messageSentDeclarations)
    .where(and(eq(messageSentDeclarations.status, STATUS.PENDING), lte(messageSentDeclarations.nextAt, new Date(now))))
    .orderBy(asc(messageSentDeclarations.sentAt))
    .limit(2000);
  pass.due += rows.length;

  const named: Array<{ r: MessageSentDeclaration; leadId: string }> = [];
  const byOrg = new Map<string, MessageSentDeclaration[]>();
  for (const r of rows) {
    if (!sendResolveItem(r)) {
      await waitOrGiveUp(r, now, "no_resolvable_key", null, true, pass);
      continue;
    }
    (byOrg.get(r.orgId) ?? byOrg.set(r.orgId, []).get(r.orgId)!).push(r);
  }
  for (const [orgId, group] of byOrg) {
    let answers: Array<{ leadId: string | null }>;
    try {
      const res = await siblingQuery<{ people: Array<{ leadId: string | null }> }>(
        "lead",
        "/internal/leads/ids/resolve",
        { orgId, userId: "", runId: group[0].runId, brandId: group[0].brandId },
        { people: group.map((r) => sendResolveItem(r)!) },
      );
      answers = res.people;
      if (!Array.isArray(answers) || answers.length !== group.length) throw new Error(`answered ${answers?.length} of ${group.length}`);
    } catch (err) {
      const error = (err as Error).message.slice(0, 1000);
      console.error(`${LOG} lead-service resolve failed for org ${orgId} (${group.length} sends), retried: ${error}`);
      for (const r of group) await waitOrGiveUp(r, now, "lead_unreadable", error, false, pass);
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      const leadId = answers[i].leadId;
      if (leadId) named.push({ r: group[i], leadId });
      else await waitOrGiveUp(group[i], now, "not_a_lead_yet", null, true, pass);
    }
  }

  for (let start = 0; start < named.length; start += MAX_RUNS) {
    let batch = named.slice(start, start + MAX_RUNS);
    for (let tries = 0; batch.length > 0 && tries < 3; tries++) {
      try {
        const answer = await declareOutcomesBatch(messageSentBatchBody(batch.map(({ r, leadId }) => ({ runId: r.runId, leadId, sentAt: r.sentAt }))));
        for (const { r, leadId } of batch) {
          await db
            .update(messageSentDeclarations)
            .set({ status: STATUS.DECLARED, leadId, declaredAt: new Date(now), lastError: null, reason: null, nextAt: null, attempts: r.attempts + 1 })
            .where(eq(messageSentDeclarations.id, r.id));
        }
        pass.declared += answer.recordedCount;
        pass.alreadyRecorded += answer.alreadyRecordedCount;
        batch = [];
      } catch (err) {
        const invalid = invalidRunsOf(err);
        if (invalid) {
          const reasons = new Map(invalid.map((i) => [i.runId, `${i.reason}${i.message ? `: ${i.message}` : ""}`]));
          console.error(`${LOG} runs-service refused ${reasons.size} send run(s): ${[...reasons].slice(0, 5).map(([r, why]) => `${r} (${why})`).join(", ")}`);
          const refused = batch.filter(({ r }) => reasons.has(r.runId));
          for (const { r, leadId } of refused) {
            await db
              .update(messageSentDeclarations)
              .set({ status: STATUS.REFUSED, leadId, reason: reasons.get(r.runId)!.slice(0, 1000), nextAt: null, attempts: r.attempts + 1 })
              .where(eq(messageSentDeclarations.id, r.id));
          }
          pass.refused += refused.length;
          batch = batch.filter(({ r }) => !reasons.has(r.runId));
          continue;
        }
        const error = (err as Error).message.slice(0, 1000);
        console.error(`${LOG} declaring ${batch.length} send(s) failed, retried later: ${error}`);
        await db
          .update(messageSentDeclarations)
          .set({ lastError: error, nextAt: new Date(now + 15 * 60_000), attempts: sql`${messageSentDeclarations.attempts} + 1` })
          .where(inArray(messageSentDeclarations.id, batch.map(({ r }) => r.id)));
        pass.failed += batch.length;
        batch = [];
      }
    }
  }
  return pass;
}

function emptyPass(): MessageSentPass {
  return { recorded: 0, due: 0, declared: 0, alreadyRecorded: 0, waiting: 0, noLead: 0, refused: 0, failed: 0 };
}

/** One pass: record the campaign sends not recorded yet, then declare the due ones. */
export async function runMessageSentPass(now: number = Date.now()): Promise<MessageSentPass> {
  const pass = emptyPass();
  pass.recorded = await recordNewSends();
  await declareDueSends(now, pass);
  if (pass.recorded + pass.due > 0) console.log(`${LOG} pass: ${JSON.stringify(pass)}`);
  return pass;
}

let running = false;

/** Every minute (first ~75 s after boot), one pass at a time. `MESSAGE_SENT_DECLARATIONS=off` stops it. */
export function startMessageSentDeclarations(): void {
  if (process.env.MESSAGE_SENT_DECLARATIONS === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runMessageSentPass()
      .catch((e) => console.error(`${LOG} pass failed:`, e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS()).unref();
  }, 75_000).unref();
}
