/**
 * THE FORM-TRIGGER WATCH (owner 2026-10-12, Doc Dinners' Meta Ads form): a
 * person who fills a form in the brand's CRM gets our AI answer within minutes.
 * This module learns of each NEW submission and reports it to campaign-service
 * as a `form_submitted` trigger occurrence naming the person and what they asked.
 *
 * WHY A POLL, NOT A WEBHOOK. A GoHighLevel connection is a Private Integration
 * Token: GoHighLevel delivers webhooks to MARKETPLACE apps only, a PIT cannot
 * subscribe one, and asking the customer to wire a workflow webhook would be a
 * per-customer setup step. So every `FORM_WATCH_INTERVAL_MS` (60s) each connected
 * CRM is asked for its submissions of the last day or two only (one page, ~0.9s
 * measured on Doc Dinners). The full-history sync (15 min) is untouched and
 * independent: the watch writes nothing to bronze, so the sync still sees every
 * submission as new and derives it.
 *
 * NEW, ONCE, NEVER HISTORY:
 *  - `ghl_connections.form_watch_since` is set the first time the watch sees a
 *    connection; a submission made before it is history (the first-sync backlog
 *    included) and is never reported.
 *  - every submission seen after it is ONE `form_trigger_reports` row, keyed on
 *    GoHighLevel's submission id (unique), inserted ON CONFLICT DO NOTHING: two
 *    passes, or a reconnect, never report it twice.
 *  - campaign-service gets `idempotencyKey = crm:<source>:form_submission:<id>`,
 *    so a retry after a timeout returns its first event.
 *  - a calendar's own booking form is the booking, never a form step: recorded
 *    `skipped / calendar_booking_form`, never reported.
 *
 * A fill with no email is recorded `skipped / no_email` and logged (campaign-service
 * files a person by email only). Each detection kicks the brand's GoHighLevel sync
 * + people build (the fact lead-service needs to know the person), then reports.
 *
 * A report that fails (offer unknown, campaign-service unreachable / 5xx) stays
 * `failed` with its reason and is retried with backoff (1, 2, 4... up to
 * 60 min) for `REPORT_RETRY_WINDOW_MS` (24h) after the submission, then left
 * as is: an answer a day late is not "within minutes" and is not sent. A 400 /
 * 422 (a bad body) is final, `campaign_refused`, never retried.
 */
import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  formTriggerReports,
  ghlConnections,
  ghlRawRecords,
  peopleScopes,
  type FormTriggerReport,
  type GhlConnection,
} from "../../db/schema.js";
import { listCustomFields, listForms, listRecentFormSubmissions } from "../gohighlevel/client.js";
import { resolveGhlToken } from "../gohighlevel/credentials.js";
import { deriveFormSubmission } from "../gohighlevel/records.js";
import { runSyncPass } from "../gohighlevel/sync.js";
import { runScopeBuild } from "../people/build.js";
import { createRun, updateRun } from "../runs-client.js";
import {
  CampaignRefusal,
  campaignServiceConfigured,
  reportOccurrence,
} from "./campaign-client.js";
import { resolveOffer } from "./offer.js";
import { isCalendarBookingForm, submissionAnswers, submissionPerson } from "./submission.js";

const SERVICE_NAME = "crm-service";
const GHL = "gohighlevel";

export const FORM_WATCH_INTERVAL_MS = Number(process.env.FORM_WATCH_INTERVAL_MS) || 60_000;
/** How far back the vendor is asked (its window is whole days). */
export const FORM_WATCH_LOOKBACK_MS = 2 * 86_400_000;
export const REPORT_RETRY_WINDOW_MS = 24 * 3_600_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export const REPORT_STATUS = { PENDING: "pending", REPORTED: "reported", SKIPPED: "skipped", FAILED: "failed" } as const;
export const REPORT_REASONS = {
  CALENDAR_BOOKING_FORM: "calendar_booking_form",
  OFFER_UNKNOWN: "offer_unknown",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
  CONNECTION_GONE: "connection_gone",
  /** campaign-service files a person by email only (lead-service has no phone door): a phone-only fill is not sent. */
  NO_EMAIL: "no_email",
} as const;

/** A refusal campaign-service states as final (a bad body): never retried. */
const FINAL_REFUSAL_STATUSES = new Set([400, 422]);

export interface ConnectionWatch {
  connectionId: string;
  brandId: string;
  /** First look at this connection: the watch starts now, nothing is reported. */
  baseline: boolean;
  seen: number;
  detected: number;
  skippedCalendar: number;
  skippedNoEmail: number;
  error?: string;
}

export interface FormWatchResult {
  connections: ConnectionWatch[];
  delivered: { reportId: string; status: string; reason: string | null }[];
}

/** PURE: when a failed report is next due. */
export function nextAttemptDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  const backoff = Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  return lastAttemptAt.getTime() + backoff;
}

/** Ask one connection for its recent submissions and record each new one. */
export async function watchConnection(conn: GhlConnection, now: number = Date.now()): Promise<ConnectionWatch> {
  const out: ConnectionWatch = {
    connectionId: conn.id,
    brandId: conn.brandId,
    baseline: false,
    seen: 0,
    detected: 0,
    skippedCalendar: 0,
    skippedNoEmail: 0,
  };
  if (!conn.formWatchSince) {
    await db
      .update(ghlConnections)
      .set({ formWatchSince: new Date(now) })
      .where(and(eq(ghlConnections.id, conn.id), isNull(ghlConnections.formWatchSince)));
    out.baseline = true;
    return out;
  }
  const since = conn.formWatchSince.getTime();

  const token = await resolveGhlToken(conn.brandId, { orgId: conn.orgId, userId: conn.createdByUserId });
  const recent = await listRecentFormSubmissions(token, conn.locationId, Math.max(since, now - FORM_WATCH_LOOKBACK_MS), now);
  out.seen = recent.length;

  const fresh = recent
    .map((payload) => ({ payload: payload as Record<string, unknown>, derived: deriveFormSubmission(payload as Record<string, unknown>) }))
    .filter((s) => s.derived?.submittedAt && s.derived.submittedAt.getTime() >= since);
  if (fresh.length === 0) return out;

  const ids = fresh.map((s) => s.derived!.externalId);
  const known = new Set(
    (
      await db
        .select({ id: formTriggerReports.submissionId })
        .from(formTriggerReports)
        .where(
          and(
            eq(formTriggerReports.orgId, conn.orgId),
            eq(formTriggerReports.brandId, conn.brandId),
            eq(formTriggerReports.source, GHL),
            inArray(formTriggerReports.submissionId, ids),
          ),
        )
    ).map((r) => r.id),
  );
  const unseen = fresh.filter((s) => !known.has(s.derived!.externalId));
  if (unseen.length === 0) return out;

  // Only now, with something new: the calendars, form names, field labels, contacts.
  const bronze = await db
    .select({ kind: ghlRawRecords.kind, externalId: ghlRawRecords.externalId, payload: ghlRawRecords.payload })
    .from(ghlRawRecords)
    .where(and(eq(ghlRawRecords.connectionId, conn.id), inArray(ghlRawRecords.kind, ["calendar", "form"])));
  const calendarFormIds = new Set<string>();
  const formNames = new Map<string, string | null>();
  for (const r of bronze) {
    const p = r.payload as Record<string, unknown>;
    if (r.kind === "calendar" && typeof p.formId === "string" && p.formId) calendarFormIds.add(p.formId);
    if (r.kind === "form") formNames.set(r.externalId, typeof p.name === "string" ? p.name : null);
  }
  const missingForm = unseen.some((s) => s.derived!.formExternalId && !formNames.has(s.derived!.formExternalId));
  if (missingForm) {
    for (const f of await listForms(token, conn.locationId)) {
      formNames.set(f.id, typeof f.name === "string" ? f.name : null);
    }
  }
  const labels = await listCustomFields(token, conn.locationId);
  const contactIds = unseen.map((s) => s.derived!.externalContactId).filter((v): v is string => !!v);
  const crmContacts = new Map<string, string>();
  if (contactIds.length > 0) {
    const rows = await db
      .select({ id: contacts.id, externalId: contacts.externalId })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, conn.orgId),
          eq(contacts.brandId, conn.brandId),
          eq(contacts.source, GHL),
          inArray(contacts.externalId, contactIds),
        ),
      );
    for (const r of rows) if (r.externalId) crmContacts.set(r.externalId, r.id);
  }

  const detectedAt = new Date(now);
  for (const { payload, derived } of unseen) {
    const d = derived!;
    const person = submissionPerson(payload);
    const calendar = isCalendarBookingForm(payload, calendarFormIds);
    const skipReason = calendar ? REPORT_REASONS.CALENDAR_BOOKING_FORM : !person.email ? REPORT_REASONS.NO_EMAIL : null;
    const inserted = await db
      .insert(formTriggerReports)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        source: GHL,
        submissionId: d.externalId,
        formId: d.formExternalId,
        formName: d.formExternalId ? (formNames.get(d.formExternalId) ?? null) : null,
        sourceContactId: person.sourceContactId,
        crmContactId: person.sourceContactId ? (crmContacts.get(person.sourceContactId) ?? null) : null,
        fullName: person.fullName,
        email: person.email,
        phone: person.phone,
        answers: submissionAnswers(payload, labels),
        submittedAt: d.submittedAt!,
        detectedAt,
        status: skipReason ? REPORT_STATUS.SKIPPED : REPORT_STATUS.PENDING,
        reason: skipReason,
      })
      .onConflictDoNothing()
      .returning({ id: formTriggerReports.id });
    if (inserted.length === 0) continue;
    if (calendar) out.skippedCalendar += 1;
    else if (skipReason) out.skippedNoEmail += 1;
    else out.detected += 1;
    if (skipReason === REPORT_REASONS.NO_EMAIL) {
      console.warn(
        `[crm-service][form-trigger] submission ${d.externalId} (brand ${conn.brandId}) carries no email: not reported ` +
          `(campaign-service files a person by email only). Count: GET /orgs/gohighlevel/form-triggers reason no_email`,
      );
    }
    console.log(
      `[crm-service][form-trigger] detected ${GHL} submission ${d.externalId} (brand ${conn.brandId}, form ${d.formExternalId ?? "-"}) ` +
        `submitted ${d.submittedAt!.toISOString()}, detected ${detectedAt.toISOString()}` +
        (calendar ? ": a calendar's booking form, not reported" : ""),
    );
  }
  return out;
}

/** The reports due a delivery now: pending, or failed and past their backoff, inside the window. */
async function dueReports(now: number): Promise<FormTriggerReport[]> {
  const rows = await db
    .select()
    .from(formTriggerReports)
    .where(
      and(
        inArray(formTriggerReports.status, [REPORT_STATUS.PENDING, REPORT_STATUS.FAILED]),
        or(isNull(formTriggerReports.reason), ne(formTriggerReports.reason, REPORT_REASONS.CAMPAIGN_REFUSED)),
        gt(formTriggerReports.submittedAt, new Date(now - REPORT_RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(formTriggerReports.submittedAt, formTriggerReports.id);
  return rows.filter((r) => nextAttemptDue(r.attempts, r.lastAttemptAt) <= now);
}

/** Report every due submission to campaign-service: one ORG run per (org, brand). */
export async function deliverDue(now: number = Date.now()): Promise<FormWatchResult["delivered"]> {
  if (!campaignServiceConfigured()) return [];
  const due = await dueReports(now);
  const delivered: FormWatchResult["delivered"] = [];
  const groups = new Map<string, FormTriggerReport[]>();
  for (const r of due) {
    const k = `${r.orgId}|${r.brandId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const reports of groups.values()) {
    const { orgId, brandId } = reports[0];
    const [conn] = await db
      .select()
      .from(ghlConnections)
      .where(and(eq(ghlConnections.orgId, orgId), eq(ghlConnections.brandId, brandId)));
    if (!conn) {
      for (const r of reports) {
        await settle(r, now, { status: REPORT_STATUS.FAILED, reason: REPORT_REASONS.CONNECTION_GONE, lastError: "the brand's CRM was disconnected" });
        delivered.push({ reportId: r.id, status: REPORT_STATUS.FAILED, reason: REPORT_REASONS.CONNECTION_GONE });
      }
      continue;
    }
    const identity = { orgId, userId: conn.createdByUserId, brandIds: [brandId] };
    const run = await createRun({ ...identity, serviceName: SERVICE_NAME, taskName: "form-trigger.report" });
    let failed = false;
    for (const r of reports) {
      const outcome = await deliverOne(r, { orgId, brandId, userId: conn.createdByUserId, runId: run.id }, now);
      if (outcome.status !== REPORT_STATUS.REPORTED) failed = true;
      delivered.push({ reportId: r.id, ...outcome });
    }
    await updateRun(run.id, failed ? "failed" : "completed", { ...identity, runId: run.id });
  }
  return delivered;
}

async function settle(
  r: FormTriggerReport,
  now: number,
  set: Partial<Pick<FormTriggerReport, "status" | "reason" | "lastError" | "offerId" | "runId" | "reportedAt" | "campaignEventId" | "campaignRecordedAt" | "campaignOutcome">>,
): Promise<void> {
  await db
    .update(formTriggerReports)
    .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now) })
    .where(eq(formTriggerReports.id, r.id));
}

async function deliverOne(
  r: FormTriggerReport,
  identity: { orgId: string; brandId: string; userId: string; runId: string },
  now: number,
): Promise<{ status: string; reason: string | null }> {
  const offer = await resolveOffer(identity, r.formId);
  if (offer.offerId === null) {
    console.warn(`[crm-service][form-trigger] submission ${r.submissionId} (brand ${r.brandId}) not reported: ${offer.detail}`);
    await settle(r, now, { status: REPORT_STATUS.FAILED, reason: REPORT_REASONS.OFFER_UNKNOWN, lastError: offer.detail, runId: identity.runId });
    return { status: REPORT_STATUS.FAILED, reason: REPORT_REASONS.OFFER_UNKNOWN };
  }
  try {
    const recorded = await reportOccurrence({
      ...identity,
      offerId: offer.offerId,
      source: r.source,
      submissionId: r.submissionId,
      submittedAt: r.submittedAt,
      person: {
        fullName: r.fullName,
        email: r.email,
        phone: r.phone,
        sourceContactId: r.sourceContactId,
        crmContactId: r.crmContactId,
      },
      form: { formId: r.formId, formName: r.formName, answers: r.answers as never },
    });
    const reportedAt = new Date();
    await settle(r, now, {
      status: REPORT_STATUS.REPORTED,
      reason: null,
      lastError: null,
      offerId: offer.offerId,
      runId: identity.runId,
      reportedAt,
      campaignEventId: recorded.eventId,
      campaignRecordedAt: recorded.recordedAt,
      campaignOutcome: recorded.event,
    });
    console.log(
      `[crm-service][form-trigger] reported submission ${r.submissionId} (brand ${r.brandId}) as event ${recorded.eventId}` +
        `${recorded.replayed ? " (replayed)" : ""}: submitted ${r.submittedAt.toISOString()}, detected ${r.detectedAt.toISOString()}, ` +
        `reported ${reportedAt.toISOString()}, outcome ${String(recorded.event.outcome ?? recorded.event.status ?? "-")}` +
        `${recorded.event.skipReason ? `/${String(recorded.event.skipReason)}` : ""}`,
    );
    return { status: REPORT_STATUS.REPORTED, reason: null };
  } catch (err) {
    // A bad body is final (campaign-service's word): retrying it would only repeat the refusal.
    const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
    const reason = final ? REPORT_REASONS.CAMPAIGN_REFUSED : REPORT_REASONS.CAMPAIGN_UNREACHABLE;
    console.warn(`[crm-service][form-trigger] submission ${r.submissionId} (brand ${r.brandId}) not reported: ${(err as Error).message}`);
    await settle(r, now, { status: REPORT_STATUS.FAILED, reason, lastError: (err as Error).message, offerId: offer.offerId, runId: identity.runId });
    return { status: REPORT_STATUS.FAILED, reason };
  }
}

/** One pass: every connection not paused, then every due report. */
export async function runFormWatchPass(now: number = Date.now()): Promise<FormWatchResult> {
  const conns = await db
    .select()
    .from(ghlConnections)
    .where(or(ne(ghlConnections.status, "paused"), isNull(ghlConnections.status)));
  const connections: ConnectionWatch[] = [];
  for (const conn of conns) {
    try {
      const watched = await watchConnection(conn, now);
      connections.push(watched);
      if (watched.detected > 0 && process.env.FORM_TRIGGER_REFRESH !== "off") void refreshBrandCrm(conn);
    } catch (err) {
      // One CRM failing (token revoked, vendor down) never stops the others; the
      // full sync records the connection's health, this is logged per pass.
      const message = (err as Error).message;
      console.warn(`[crm-service][form-trigger] watch of connection ${conn.id} (brand ${conn.brandId}) failed: ${message}`);
      connections.push({ connectionId: conn.id, brandId: conn.brandId, baseline: false, seen: 0, detected: 0, skippedCalendar: 0, skippedNoEmail: 0, error: message });
    }
  }
  const delivered = await deliverDue(now);
  return { connections, delivered };
}

/**
 * The person must be KNOWN to lead-service before campaign-service can serve
 * them, and lead-service learns of a CRM contact only through our people fact
 * feed, which normally trails the 15-min sync + people build. So a detection
 * kicks both for that brand at once (unawaited, ~1-2 min), and the occurrence
 * is reported immediately: campaign-service holds a `person_not_known` event and
 * retries it for an hour.
 */
async function refreshBrandCrm(conn: GhlConnection): Promise<void> {
  try {
    await runSyncPass(conn.id);
    const [scope] = await db
      .select()
      .from(peopleScopes)
      .where(and(eq(peopleScopes.orgId, conn.orgId), eq(peopleScopes.brandId, conn.brandId)));
    if (scope) await runScopeBuild(scope);
  } catch (err) {
    console.error(`[crm-service][form-trigger] refresh of brand ${conn.brandId} after a new submission failed:`, err);
  }
}

let running = false;

/** In-process, every FORM_WATCH_INTERVAL_MS, first pass 60s after boot, never two at once. */
export function startFormWatch(): void {
  if (!campaignServiceConfigured()) {
    console.warn("[crm-service][form-trigger] CAMPAIGN_SERVICE_URL / _API_KEY unset: submissions are detected, not reported");
  }
  const tick = () => {
    if (running) return;
    running = true;
    runFormWatchPass()
      .catch((e) => console.error("[crm-service][form-trigger] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, FORM_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}
