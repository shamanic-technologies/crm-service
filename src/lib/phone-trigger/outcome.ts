/**
 * TRIGGER-OUTCOME-1118 (owner 2026-11-18): the fact that fires a reactive campaign is a UNIT of the ledger, declared by
 * whoever reports it, so the message written because of it consumes it like any other step.
 *
 * A number reported to campaign-service as `whatsapp_number_given` (./watch.ts) is ONE occurrence of the outcome of the
 * same key, PRODUCED by the run that reported it (`phone-trigger.report`, `phone_given_reports.run_id`), subject = the
 * person's lead in lead-service, dated when it was reported (the report is made within a minute of the number being
 * given; the ledger takes no date before the run's own start). It consumes nothing: the number is given by the person,
 * a root of the ledger.
 *
 * - The lead is NAMED by lead-service (`POST /internal/leads/ids/resolve`, nothing minted). Not a lead yet (the campaign
 *   the report fires serves the person a moment later) = asked again with backoff, `no_lead` 7 days after the report.
 * - No new spend and no new cost name: the run's own costs (the offer pick) are already billed on it; the Unit only says
 *   what that run produced.
 * - Reports made before this shipped keep `outcome_status` NULL and are never declared (no backfill).
 */
import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { phoneGivenReports, type PhoneGivenReport } from "../../db/schema.js";
import { declareOutcomesBatch, invalidRunsOf, type BatchRunOutcomes } from "../runs-client.js";
import { siblingQuery } from "../people/siblings.js";
import { LEAD_SUBJECT_SERVICE, OUTCOME_GIVE_UP_MS, outcomeBackoffMs } from "../reply-trigger/outcome.js";
import { sendResolveItem } from "../whatsapp/message-sent.js";
import { PHONE_GIVEN_TRIGGER, PHONE_STATUS } from "./rules.js";

/** The outcome a number given is: the trigger's own key (the catalogue lists the outcome under it). */
export const NUMBER_GIVEN_OUTCOME = PHONE_GIVEN_TRIGGER;
export const NUMBER_GIVEN_STATUS = { PENDING: "pending", DECLARED: "declared", NO_LEAD: "no_lead", REFUSED: "refused" } as const;
const LOG = "[crm-service][phone-trigger][outcome]";
const MAX_RUNS = 500;

/** PURE: what a report just made carries so its Unit is declared at the next pass. */
export function numberGivenOutcomePending(reportedAt: Date) {
  return { outcomeStatus: NUMBER_GIVEN_STATUS.PENDING, outcomeNextAt: reportedAt, outcomeAttempts: 0, outcomeReason: null };
}

/** PURE: what lead-service is asked for one report (its number, its email when held), or null when it holds no key lead-service reads. */
export function numberGivenResolveItem(r: Pick<PhoneGivenReport, "orgId" | "brandId" | "email" | "phone">) {
  return sendResolveItem({ orgId: r.orgId, brandId: r.brandId, email: r.email ? r.email.toLowerCase() : null, phone: r.phone });
}

/** PURE: one batch entry per report run: the number given, on the person's lead, dated when it was reported. Consumes nothing. */
export function numberGivenBatchBody(rows: Array<{ runId: string; leadId: string; reportedAt: Date }>): BatchRunOutcomes[] {
  return rows.map((r) => ({
    runId: r.runId,
    produced: [{ outcomeKey: NUMBER_GIVEN_OUTCOME, subjectService: LEAD_SUBJECT_SERVICE, subjectId: r.leadId }],
    occurredAt: r.reportedAt.toISOString(),
  }));
}

export interface NumberGivenPass {
  due: number;
  declared: number;
  waiting: number;
  noLead: number;
  refused: number;
  failed: number;
}

async function wait(r: PhoneGivenReport, now: number, reason: string, giveUp: boolean, pass: NumberGivenPass): Promise<void> {
  const attempts = r.outcomeAttempts + 1;
  if (giveUp && now - (r.reportedAt ?? r.detectedAt).getTime() > OUTCOME_GIVE_UP_MS) {
    console.error(`${LOG} report ${r.id} (brand ${r.brandId}): no lead after 7 days (${reason}), ${NUMBER_GIVEN_OUTCOME} NOT declared`);
    await db.update(phoneGivenReports).set({ outcomeStatus: NUMBER_GIVEN_STATUS.NO_LEAD, outcomeReason: reason, outcomeAttempts: attempts, outcomeNextAt: null }).where(eq(phoneGivenReports.id, r.id));
    pass.noLead += 1;
    return;
  }
  await db.update(phoneGivenReports).set({ outcomeReason: reason, outcomeAttempts: attempts, outcomeNextAt: new Date(now + outcomeBackoffMs(attempts)) }).where(eq(phoneGivenReports.id, r.id));
  if (giveUp) pass.waiting += 1;
  else pass.failed += 1;
}

/** Name each due report's lead, then declare its Unit. Never throws per row: each row records why it waits. */
export async function declareDueNumbersGiven(now: number = Date.now()): Promise<NumberGivenPass> {
  const pass: NumberGivenPass = { due: 0, declared: 0, waiting: 0, noLead: 0, refused: 0, failed: 0 };
  const rows = await db
    .select()
    .from(phoneGivenReports)
    .where(and(eq(phoneGivenReports.status, PHONE_STATUS.REPORTED), eq(phoneGivenReports.outcomeStatus, NUMBER_GIVEN_STATUS.PENDING), lte(phoneGivenReports.outcomeNextAt, new Date(now))))
    .orderBy(asc(phoneGivenReports.outcomeNextAt))
    .limit(MAX_RUNS);
  pass.due = rows.length;

  const named: Array<{ r: PhoneGivenReport; leadId: string }> = [];
  const byOrg = new Map<string, PhoneGivenReport[]>();
  for (const r of rows) {
    if (!r.runId || !r.reportedAt || !numberGivenResolveItem(r)) {
      await wait(r, now, "no_resolvable_key", true, pass);
      continue;
    }
    (byOrg.get(r.orgId) ?? byOrg.set(r.orgId, []).get(r.orgId)!).push(r);
  }
  for (const [orgId, group] of byOrg) {
    try {
      const res = await siblingQuery<{ people: Array<{ leadId: string | null }> }>(
        "lead",
        "/internal/leads/ids/resolve",
        { orgId, userId: "", runId: group[0].runId!, brandId: group[0].brandId },
        { people: group.map((r) => numberGivenResolveItem(r)!) },
      );
      if (!Array.isArray(res.people) || res.people.length !== group.length) throw new Error(`answered ${res.people?.length} of ${group.length}`);
      for (let i = 0; i < group.length; i++) {
        const leadId = res.people[i].leadId;
        if (leadId) named.push({ r: group[i], leadId });
        else await wait(group[i], now, "not_a_lead_yet", true, pass);
      }
    } catch (err) {
      console.error(`${LOG} lead-service resolve failed for org ${orgId} (${group.length} reports), retried: ${(err as Error).message.slice(0, 300)}`);
      for (const r of group) await wait(r, now, "lead_unreadable", false, pass);
    }
  }

  let batch = named;
  for (let tries = 0; batch.length > 0 && tries < 3; tries++) {
    try {
      await declareOutcomesBatch(numberGivenBatchBody(batch.map(({ r, leadId }) => ({ runId: r.runId!, leadId, reportedAt: r.reportedAt! }))));
      for (const { r, leadId } of batch) {
        await db
          .update(phoneGivenReports)
          .set({ outcomeStatus: NUMBER_GIVEN_STATUS.DECLARED, outcomeLeadId: leadId, outcomeDeclaredAt: new Date(now), outcomeReason: null, outcomeNextAt: null, outcomeAttempts: r.outcomeAttempts + 1 })
          .where(eq(phoneGivenReports.id, r.id));
      }
      pass.declared += batch.length;
      batch = [];
    } catch (err) {
      const invalid = invalidRunsOf(err);
      if (!invalid) {
        console.error(`${LOG} declaring ${batch.length} number(s) given failed, retried later: ${(err as Error).message.slice(0, 300)}`);
        for (const { r } of batch) await wait(r, now, "ledger_unreachable", false, pass);
        return pass;
      }
      // runs-service names the runs it refuses (nothing of the batch was written): keep them, declare the rest.
      const reasons = new Map(invalid.map((i) => [i.runId, `${i.reason}${i.message ? `: ${i.message}` : ""}`]));
      console.error(`${LOG} runs-service refused ${reasons.size} report run(s): ${[...reasons].slice(0, 5).map(([id, why]) => `${id} (${why})`).join(", ")}`);
      for (const { r, leadId } of batch.filter(({ r }) => reasons.has(r.runId!))) {
        await db
          .update(phoneGivenReports)
          .set({ outcomeStatus: NUMBER_GIVEN_STATUS.REFUSED, outcomeLeadId: leadId, outcomeReason: reasons.get(r.runId!)!.slice(0, 1000), outcomeNextAt: null, outcomeAttempts: r.outcomeAttempts + 1 })
          .where(eq(phoneGivenReports.id, r.id));
        pass.refused += 1;
      }
      batch = batch.filter(({ r }) => !reasons.has(r.runId!));
    }
  }
  if (pass.due > 0) console.log(`${LOG} ${pass.due} due: ${pass.declared} declared, ${pass.waiting} waiting for a lead, ${pass.noLead} without a lead, ${pass.refused} refused, ${pass.failed} failed`);
  return pass;
}
