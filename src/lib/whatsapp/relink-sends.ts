/**
 * ONE-TIME repair (WHATSAPP-RELINK-1118, owner 2026-11-18): the campaign WhatsApp sends declared BEFORE
 * UNIT-LINK-COVERAGE-1117 state `message_sent` and consume nothing, so the ledger links no written message to them.
 * Each one gets the consumption the live code now declares (`messageSentBatchBody`, imported, never copied), added
 * through runs-service's batch door on the SAME send run at the SAME instant: the produced Unit replays
 * `already_recorded`, only the consumed row is new. Nothing is voided (the run consumed nothing), no produced Unit, cost
 * or Unit count moves, nothing is written to a database by hand.
 *
 * A send is re-declared only when the ledger can link it: a `message_written` Unit stands on its lead, declared before
 * the end of the send's UTC day (runs-service's own resolution rule). A send whose lead has no such Unit is LEFT OUT with
 * the reason: a consumption naming a Unit nobody produced links to nothing (LATE-UNIT-LINK-1117).
 */
import { declareOutcomesBatch, listLedgerOccurrences, type LedgerOccurrence } from "../runs-client.js";
import { LEAD_SUBJECT_SERVICE, MESSAGE_SENT_OUTCOME } from "../reply-trigger/outcome.js";
import { MESSAGE_WRITTEN_OUTCOME, messageSentBatchBody } from "./message-sent.js";

export interface DeclaredSend {
  runId: string;
  leadId: string;
}

export type RelinkVerdict = "link" | "already_consumes" | "unit_not_standing" | "no_written_message" | "written_after_send_day";

export interface SendPlan extends DeclaredSend {
  verdict: RelinkVerdict;
  /** The instant the ledger holds for the send's Unit (null when it holds none standing). */
  sentAt: string | null;
  /** In words: what the ledger shows for this send. */
  detail: string;
}

const endOfUtcDay = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) + 24 * 60 * 60_000;

/** PURE: what to do with one send, from what the ledger holds on its run and the written messages of its lead. */
export function planSend(send: DeclaredSend, onRun: LedgerOccurrence[], writtenOfLead: LedgerOccurrence[]): SendPlan {
  const units = onRun.filter(
    (o) => o.direction === "produced" && o.outcomeKey === MESSAGE_SENT_OUTCOME && o.subjectService === LEAD_SUBJECT_SERVICE && o.subjectId === send.leadId && !o.reversal,
  );
  if (units.length !== 1 || onRun.filter((o) => o.direction === "produced").length !== 1) {
    return { ...send, verdict: "unit_not_standing", sentAt: null, detail: `the run holds ${onRun.filter((o) => o.direction === "produced").length} produced occurrence(s), ${units.length} standing message_sent on the lead` };
  }
  const sentAt = units[0].declaredAt;
  const consumed = onRun.filter((o) => o.direction === "consumed");
  if (consumed.length > 0) return { ...send, verdict: "already_consumes", sentAt, detail: `consumes ${consumed.map((o) => o.outcomeKey).join(", ")}` };
  const written = writtenOfLead
    .filter((o) => o.direction === "produced" && o.outcomeKey === MESSAGE_WRITTEN_OUTCOME && o.subjectService === LEAD_SUBJECT_SERVICE && o.subjectId === send.leadId && !o.reversal)
    .map((o) => o.declaredAt)
    .sort();
  if (written.length === 0) return { ...send, verdict: "no_written_message", sentAt, detail: "no written message stands on the lead" };
  if (Date.parse(written[0]) >= endOfUtcDay(sentAt)) {
    return { ...send, verdict: "written_after_send_day", sentAt, detail: `the lead's first written message is dated ${written[0]}, after the send's day` };
  }
  return { ...send, verdict: "link", sentAt, detail: `${written.filter((w) => Date.parse(w) < endOfUtcDay(sentAt)).length} written message(s) stand before the end of the send's day` };
}

/** What the ledger holds for each send, read live (one read per run, one per lead). Throws when the ledger is unreadable. */
export async function planRelink(sends: DeclaredSend[]): Promise<SendPlan[]> {
  const writtenByLead = new Map<string, LedgerOccurrence[]>();
  const plans: SendPlan[] = [];
  for (const send of sends) {
    const onRun = await listLedgerOccurrences({ runIds: [send.runId] });
    let written = writtenByLead.get(send.leadId);
    if (!written) {
      written = await listLedgerOccurrences({ subjectService: LEAD_SUBJECT_SERVICE, subjectIds: [send.leadId], outcomeKey: MESSAGE_WRITTEN_OUTCOME, direction: "produced" });
      writtenByLead.set(send.leadId, written);
    }
    plans.push(planSend(send, onRun, written));
  }
  return plans;
}

export interface RelinkResult {
  runId: string;
  leadId: string;
  recordedCount: number;
  alreadyRecordedCount: number;
}

/**
 * Re-declares one planned send (verdict `link`): the live declaration body, at the instant the ledger holds for the Unit.
 * Throws unless runs-service recorded exactly the consumed row and replayed the produced Unit (anything else = stop).
 */
export async function relinkSend(plan: SendPlan): Promise<RelinkResult> {
  if (plan.verdict !== "link" || !plan.sentAt) throw new Error(`send run ${plan.runId} is not planned for a re-declaration (${plan.verdict})`);
  const answer = await declareOutcomesBatch(messageSentBatchBody([{ runId: plan.runId, leadId: plan.leadId, sentAt: new Date(plan.sentAt) }]));
  if (answer.recordedCount !== 1 || answer.alreadyRecordedCount !== 1) {
    throw new Error(`send run ${plan.runId}: expected 1 recorded (consumed) + 1 already recorded (produced), got ${answer.recordedCount} + ${answer.alreadyRecordedCount}`);
  }
  return { runId: plan.runId, leadId: plan.leadId, recordedCount: answer.recordedCount, alreadyRecordedCount: answer.alreadyRecordedCount };
}
