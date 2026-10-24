/**
 * CRM-FORM-SUBMITTED-LEDGER-1025 (doctrine: agent-config skill `cost-accounting`): a form a person filled in the brand's
 * CRM is a crm-service fact (we hold it and fire the "Form submitted" trigger), so crm-service is the PRODUCER of its
 * `form_submitted` occurrence on runs-service's ledger. The reactive pipe that answers it (workflow-service) consumes
 * that occurrence on the same subject: the person's lead in lead-service. Undeclared, each such consumption reads
 * "unknown provenance" and the ledger never reconciles.
 *
 * - Every submission crm-service holds (silver `ghl_form_submissions`, dated), past and future, ONE path: each pass
 *   records the ones not recorded yet, names the lead (lead-service `POST /internal/leads/ids/resolve` with the
 *   identity the submission itself carries, else its mirrored contact's; nothing minted, never guessed) and declares
 *   through runs-service's batch door with `occurredAt` = the submission's own time.
 * - A calendar's own booking form is the BOOKING, never a form (same rule as the form trigger and Outcomes):
 *   `skipped / calendar_booking_form`.
 * - The producing run: a spend-free run of its own per submission (`gohighlevel.form-submitted`), opened once its lead is
 *   known and stored on the row BEFORE the first declaration, so a retry or a replay names the same run and runs-service
 *   answers `already_recorded`. It records a past fact: runs-service accepts its occurredAt before the run's start
 *   (spend-free run, stated by its own service).
 * - Not a lead (yet), or no email / phone to ask with = waits and is asked again (backoff to 1 h), never given up:
 *   a person can become a lead later. A 422 run = `refused` (kept, logged).
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { formSubmittedDeclarations, type FormSubmittedDeclaration } from "../../db/schema.js";
import { createRun, declareOutcomesBatch, invalidRunsOf, updateRun, type BatchRunOutcomes } from "../runs-client.js";
import { siblingQuery } from "../people/siblings.js";
import { LEAD_SUBJECT_SERVICE, outcomeBackoffMs } from "../reply-trigger/outcome.js";
import { isCalendarBookingForm, submissionPerson } from "../form-trigger/submission.js";
import { normalizeEmail } from "../people/identity.js";

export const FORM_SUBMITTED_OUTCOME = "form_submitted";
export const FORM_SOURCE = "gohighlevel";
export const STATUS = { PENDING: "pending", DECLARED: "declared", SKIPPED: "skipped", REFUSED: "refused" } as const;
export const RUN_TASK = { serviceName: "crm-service", taskName: "gohighlevel.form-submitted" } as const;
const MAX_RUNS = 500;
const INTERVAL_MS = () => Number(process.env.FORM_SUBMITTED_INTERVAL_MS) || 5 * 60_000;
const LOG = "[crm-service][form-submitted]";

/** What one due submission is asked and declared with, read live (the CRM may have filled the contact since). */
export interface DueSubmission {
  row: FormSubmittedDeclaration;
  email: string | null;
  phone: string | null;
  /** Who connected the CRM: the run is opened in their name (a cron carries no request identity). */
  userId: string | null;
  calendarBookingForm: boolean;
  /** The submission is no longer held (CRM disconnected): asked again until it comes back. */
  gone: boolean;
}

/** PURE: what lead-service is asked for one submission, or null when it holds no key lead-service reads. */
export function submissionResolveItem(orgId: string, brandId: string, email: string | null, phone: string | null) {
  const e = email && email.includes("@") ? email : null;
  const p = phone && /^\+\d{6,15}$/.test(phone) ? phone : null;
  if (!e && !p) return null;
  return { orgId, brandIds: [brandId], ...(e ? { email: e } : {}), ...(p ? { phone: p } : {}) };
}

/** PURE: one batch entry per submission run, the form on its lead, dated when it was submitted. */
export function formSubmittedBatchBody(rows: Array<{ runId: string; leadId: string; submittedAt: Date }>): BatchRunOutcomes[] {
  return rows.map((r) => ({
    runId: r.runId,
    produced: [{ outcomeKey: FORM_SUBMITTED_OUTCOME, subjectService: LEAD_SUBJECT_SERVICE, subjectId: r.leadId }],
    occurredAt: r.submittedAt.toISOString(),
  }));
}

/** Record every dated submission not recorded yet. */
export async function recordNewSubmissions(): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO form_submitted_declarations (org_id, brand_id, source, submission_external_id, submitted_at, status, next_at)
    SELECT DISTINCT ON (s.org_id, s.brand_id, s.external_id) s.org_id, s.brand_id, ${FORM_SOURCE}, s.external_id, s.submitted_at, 'pending', s.submitted_at
    FROM ghl_form_submissions s
    WHERE s.submitted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM form_submitted_declarations d
        WHERE d.org_id = s.org_id AND d.brand_id = s.brand_id AND d.source = ${FORM_SOURCE} AND d.submission_external_id = s.external_id)
    ORDER BY s.org_id, s.brand_id, s.external_id, s.submitted_at
    ON CONFLICT (org_id, brand_id, source, submission_external_id) DO NOTHING
    RETURNING id`);
  return (res as unknown as unknown[]).length;
}

/** The due rows with what the submission (bronze record, else its mirrored contact) says about who filled it. */
async function readDue(now: number): Promise<DueSubmission[]> {
  const rows = await db
    .select()
    .from(formSubmittedDeclarations)
    .where(and(eq(formSubmittedDeclarations.status, STATUS.PENDING), lte(formSubmittedDeclarations.nextAt, new Date(now))))
    .orderBy(asc(formSubmittedDeclarations.submittedAt))
    .limit(2000);
  if (rows.length === 0) return [];
  const facts = (await db.execute<{
    id: string;
    payload: Record<string, unknown> | null;
    contact_email: string | null;
    contact_phone: string | null;
    user_id: string | null;
    calendar_form_ids: string[] | null;
  }>(sql`
    SELECT d.id, raw.payload, c.primary_email AS contact_email, c.phone_e164 AS contact_phone, g.created_by_user_id AS user_id,
           (SELECT array_agg(cal.payload->>'formId') FROM ghl_raw_records cal
             WHERE cal.connection_id = s.connection_id AND cal.kind = 'calendar' AND cal.payload->>'formId' IS NOT NULL) AS calendar_form_ids
    FROM form_submitted_declarations d
    JOIN ghl_form_submissions s
      ON s.org_id = d.org_id AND s.brand_id = d.brand_id AND s.external_id = d.submission_external_id
    JOIN ghl_connections g ON g.id = s.connection_id
    LEFT JOIN ghl_raw_records raw
      ON raw.connection_id = s.connection_id AND raw.kind = 'form_submission' AND raw.external_id = s.external_id
    LEFT JOIN contacts c ON c.id = COALESCE(s.contact_id, (
      SELECT c2.id FROM contacts c2
      WHERE c2.org_id = d.org_id AND c2.brand_id = d.brand_id AND c2.source = 'gohighlevel' AND c2.external_id = s.external_contact_id
      ORDER BY c2.id LIMIT 1))
    WHERE d.id = ANY(${`{${rows.map((r) => r.id).join(",")}}`}::uuid[])`)) as unknown as Array<{
    id: string;
    payload: Record<string, unknown> | null;
    contact_email: string | null;
    contact_phone: string | null;
    user_id: string | null;
    calendar_form_ids: string[] | null;
  }>;
  const byId = new Map(facts.map((f) => [f.id, f]));
  return rows.map((row) => {
    const f = byId.get(row.id);
    if (!f) return { row, email: null, phone: null, userId: null, calendarBookingForm: false, gone: true };
    const said = f.payload ? submissionPerson(f.payload) : null;
    return {
      row,
      email: said?.email ?? normalizeEmail(f.contact_email),
      phone: said?.phone && said.phone.startsWith("+") ? said.phone : f.contact_phone,
      userId: f.user_id,
      calendarBookingForm: f.payload ? isCalendarBookingForm(f.payload, new Set(f.calendar_form_ids ?? [])) : false,
      gone: false,
    };
  });
}

export interface FormSubmittedPass {
  recorded: number;
  due: number;
  declared: number;
  alreadyRecorded: number;
  waiting: number;
  skipped: number;
  refused: number;
  failed: number;
}

async function wait(r: FormSubmittedDeclaration, now: number, reason: string, error: string | null, pass: FormSubmittedPass) {
  const attempts = r.attempts + 1;
  await db
    .update(formSubmittedDeclarations)
    .set({ reason, attempts, lastError: error, nextAt: new Date(now + outcomeBackoffMs(attempts)) })
    .where(eq(formSubmittedDeclarations.id, r.id));
  if (error) pass.failed += 1;
  else pass.waiting += 1;
}

/** Name each due submission's lead, open its run once, then declare. Never throws per row: each row records why it waits. */
export async function declareDueSubmissions(now: number = Date.now(), pass: FormSubmittedPass = emptyPass()): Promise<FormSubmittedPass> {
  const due = await readDue(now);
  pass.due += due.length;

  const byOrg = new Map<string, DueSubmission[]>();
  for (const d of due) {
    if (d.calendarBookingForm) {
      await db
        .update(formSubmittedDeclarations)
        .set({ status: STATUS.SKIPPED, reason: "calendar_booking_form", nextAt: null, attempts: d.row.attempts + 1 })
        .where(eq(formSubmittedDeclarations.id, d.row.id));
      pass.skipped += 1;
      continue;
    }
    if (d.gone) {
      await wait(d.row, now, "submission_not_held", null, pass);
      continue;
    }
    if (!submissionResolveItem(d.row.orgId, d.row.brandId, d.email, d.phone)) {
      await wait(d.row, now, "no_resolvable_key", null, pass);
      continue;
    }
    (byOrg.get(d.row.orgId) ?? byOrg.set(d.row.orgId, []).get(d.row.orgId)!).push(d);
  }

  const named: Array<{ d: DueSubmission; leadId: string }> = [];
  for (const [orgId, group] of byOrg) {
    let answers: Array<{ leadId: string | null }>;
    try {
      const res = await siblingQuery<{ people: Array<{ leadId: string | null }> }>(
        "lead",
        "/internal/leads/ids/resolve",
        { orgId, userId: group[0].userId ?? "", runId: "", brandId: group[0].row.brandId },
        { people: group.map((d) => submissionResolveItem(d.row.orgId, d.row.brandId, d.email, d.phone)!) },
      );
      answers = res.people;
      if (!Array.isArray(answers) || answers.length !== group.length) throw new Error(`answered ${answers?.length} of ${group.length}`);
    } catch (err) {
      const error = (err as Error).message.slice(0, 1000);
      console.error(`${LOG} lead-service resolve failed for org ${orgId} (${group.length} submissions), retried: ${error}`);
      for (const d of group) await wait(d.row, now, "lead_unreadable", error, pass);
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      const leadId = answers[i].leadId;
      if (leadId) named.push({ d: group[i], leadId });
      else await wait(group[i].row, now, "not_a_lead_yet", null, pass);
    }
  }

  // The producing run, opened once per submission and stored before any declaration names it.
  const ready: Array<{ r: FormSubmittedDeclaration; leadId: string; runId: string }> = [];
  for (const { d, leadId } of named) {
    if (d.row.runId) {
      ready.push({ r: d.row, leadId, runId: d.row.runId });
      continue;
    }
    if (!d.userId) {
      await wait(d.row, now, "no_connection_user", null, pass);
      continue;
    }
    try {
      const ids = { orgId: d.row.orgId, userId: d.userId };
      const run = await createRun({ ...ids, brandIds: [d.row.brandId], ...RUN_TASK });
      await db.update(formSubmittedDeclarations).set({ runId: run.id, leadId }).where(eq(formSubmittedDeclarations.id, d.row.id));
      await updateRun(run.id, "completed", ids);
      ready.push({ r: d.row, leadId, runId: run.id });
    } catch (err) {
      const error = (err as Error).message.slice(0, 1000);
      console.error(`${LOG} opening the run of submission ${d.row.submissionExternalId} failed, retried: ${error}`);
      await wait(d.row, now, "run_unavailable", error, pass);
    }
  }

  for (let start = 0; start < ready.length; start += MAX_RUNS) {
    let batch = ready.slice(start, start + MAX_RUNS);
    for (let tries = 0; batch.length > 0 && tries < 3; tries++) {
      try {
        const answer = await declareOutcomesBatch(formSubmittedBatchBody(batch.map(({ r, leadId, runId }) => ({ runId, leadId, submittedAt: r.submittedAt }))));
        for (const { r, leadId } of batch) {
          await db
            .update(formSubmittedDeclarations)
            .set({ status: STATUS.DECLARED, leadId, declaredAt: new Date(now), lastError: null, reason: null, nextAt: null, attempts: r.attempts + 1 })
            .where(eq(formSubmittedDeclarations.id, r.id));
        }
        pass.declared += answer.recordedCount;
        pass.alreadyRecorded += answer.alreadyRecordedCount;
        batch = [];
      } catch (err) {
        const invalid = invalidRunsOf(err);
        if (invalid) {
          const reasons = new Map(invalid.map((i) => [i.runId, `${i.reason}${i.message ? `: ${i.message}` : ""}`]));
          console.error(`${LOG} runs-service refused ${reasons.size} run(s): ${[...reasons].slice(0, 5).map(([r, why]) => `${r} (${why})`).join(", ")}`);
          const refused = batch.filter(({ runId }) => reasons.has(runId));
          for (const { r, leadId, runId } of refused) {
            await db
              .update(formSubmittedDeclarations)
              .set({ status: STATUS.REFUSED, leadId, reason: reasons.get(runId)!.slice(0, 1000), nextAt: null, attempts: r.attempts + 1 })
              .where(eq(formSubmittedDeclarations.id, r.id));
          }
          pass.refused += refused.length;
          batch = batch.filter(({ runId }) => !reasons.has(runId));
          continue;
        }
        const error = (err as Error).message.slice(0, 1000);
        console.error(`${LOG} declaring ${batch.length} submission(s) failed, retried later: ${error}`);
        await db
          .update(formSubmittedDeclarations)
          .set({ lastError: error, nextAt: new Date(now + 15 * 60_000), attempts: sql`${formSubmittedDeclarations.attempts} + 1` })
          .where(inArray(formSubmittedDeclarations.id, batch.map(({ r }) => r.id)));
        pass.failed += batch.length;
        batch = [];
      }
    }
  }
  return pass;
}

function emptyPass(): FormSubmittedPass {
  return { recorded: 0, due: 0, declared: 0, alreadyRecorded: 0, waiting: 0, skipped: 0, refused: 0, failed: 0 };
}

/** One pass: record the submissions not recorded yet, then declare the due ones. */
export async function runFormSubmittedPass(now: number = Date.now()): Promise<FormSubmittedPass> {
  const pass = emptyPass();
  pass.recorded = await recordNewSubmissions();
  await declareDueSubmissions(now, pass);
  if (pass.recorded + pass.due > 0) console.log(`${LOG} pass: ${JSON.stringify(pass)}`);
  return pass;
}

let running = false;

/** Every 5 min (first ~105 s after boot), one pass at a time. `FORM_SUBMITTED_DECLARATIONS=off` stops it. */
export function startFormSubmittedDeclarations(): void {
  if (process.env.FORM_SUBMITTED_DECLARATIONS === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runFormSubmittedPass()
      .catch((e) => console.error(`${LOG} pass failed:`, e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS()).unref();
  }, 105_000).unref();
}
