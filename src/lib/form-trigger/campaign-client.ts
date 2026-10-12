/**
 * campaign-service's generic trigger door (`POST /internal/trigger-events`):
 * one `form_submitted` occurrence per new CRM form submission, naming the
 * person and what they asked. The same door every trigger uses; nothing here is
 * specific to a brand, a form or a campaign.
 *
 * `idempotencyKey` = the submission's own identity, so a retry (a timeout, a
 * crash between the call and our write) returns campaign-service's FIRST event
 * (`replayed: true`) and nothing fires twice.
 */
import type { FormAnswer } from "./submission.js";

export const FORM_SUBMITTED_TRIGGER = "form_submitted";
const TIMEOUT_MS = Number(process.env.CAMPAIGN_SERVICE_TIMEOUT_MS) || 30_000;

export interface FormOccurrence {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
  offerId: string;
  source: string;
  submissionId: string;
  submittedAt: Date;
  person: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    sourceContactId: string | null;
    crmContactId: string | null;
  };
  form: { formId: string | null; formName: string | null; answers: FormAnswer[] };
}

export interface RecordedOccurrence {
  eventId: string;
  recordedAt: Date | null;
  replayed: boolean;
  /** campaign-service's event as it answered it (status, outcome, skip reason...). */
  event: Record<string, unknown>;
}

/** campaign-service answered and refused: nothing was recorded there. */
export class CampaignRefusal extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, reason: string | null, message: string) {
    super(message);
    this.name = "CampaignRefusal";
    this.status = status;
    this.reason = reason;
  }
}

export function occurrenceIdempotencyKey(o: Pick<FormOccurrence, "source" | "submissionId">): string {
  return `crm:${o.source}:form_submission:${o.submissionId}`;
}

/**
 * PURE: the request body, campaign-service's contract (its `RecordTriggerEventBody`):
 * `person` = who, by identity (they may not be a lead yet), `crmContact` carried
 * verbatim; `item` = what they asked, handed to the workflow verbatim.
 * An absent value is OMITTED, never sent as null (the contract is strict).
 */
export function occurrenceBody(o: FormOccurrence): Record<string, unknown> {
  const person: Record<string, unknown> = {};
  if (o.person.email) person.email = o.person.email;
  if (o.person.fullName) person.name = o.person.fullName.slice(0, 300);
  if (o.person.phone) person.phone = o.person.phone.slice(0, 50);
  if (o.person.sourceContactId) person.crmContact = { provider: o.source, contactId: o.person.sourceContactId };
  return {
    triggerId: FORM_SUBMITTED_TRIGGER,
    brandId: o.brandId,
    offerId: o.offerId,
    idempotencyKey: occurrenceIdempotencyKey(o),
    occurredAt: o.submittedAt.toISOString(),
    person,
    item: {
      source: o.source,
      submissionId: o.submissionId,
      formId: o.form.formId,
      formName: o.form.formName,
      submittedAt: o.submittedAt.toISOString(),
      answers: o.form.answers,
      crmContactId: o.person.crmContactId,
    },
  };
}

function env(): { url: string; key: string } {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const key = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url) throw new Error("CAMPAIGN_SERVICE_URL is required to report form submissions");
  if (!key) throw new Error("CAMPAIGN_SERVICE_API_KEY is required to report form submissions");
  return { url: url.replace(/\/+$/, ""), key };
}

export function campaignServiceConfigured(): boolean {
  return !!process.env.CAMPAIGN_SERVICE_URL && !!process.env.CAMPAIGN_SERVICE_API_KEY;
}

/**
 * Report one occurrence. Resolves with campaign-service's event; throws
 * `CampaignRefusal` on a 4xx (nothing recorded there), a plain Error on a 5xx /
 * unreachable (retried by the watch: the idempotency key makes that safe).
 */
export async function reportOccurrence(o: FormOccurrence): Promise<RecordedOccurrence> {
  const { url, key } = env();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${url}/internal/trigger-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "x-org-id": o.orgId,
        "x-user-id": o.userId,
        "x-run-id": o.runId,
        "x-brand-id": o.brandId,
      },
      body: JSON.stringify(occurrenceBody(o)),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = (err as Error).name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : (err as Error).message;
    throw new Error(`campaign-service POST /internal/trigger-events unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON: quoted below.
  }
  if (res.status >= 400 && res.status < 500) {
    throw new CampaignRefusal(
      res.status,
      typeof body.reason === "string" ? body.reason : null,
      `campaign-service refused the occurrence (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok) throw new Error(`campaign-service POST /internal/trigger-events returned ${res.status}: ${text.slice(0, 300)}`);
  const event = (body.event ?? {}) as Record<string, unknown>;
  const eventId = typeof event.id === "string" ? event.id : null;
  if (!eventId) throw new Error(`campaign-service answered ${res.status} with no event id: ${text.slice(0, 300)}`);
  // The event serves no creation stamp today: `processedAt` (when it fired) is
  // the closest campaign-service-side time; `createdAt` wins if it ever serves one.
  const stamp = typeof event.createdAt === "string" ? event.createdAt : event.processedAt;
  const created = typeof stamp === "string" ? new Date(stamp) : null;
  return {
    eventId,
    recordedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    replayed: body.replayed === true,
    event,
  };
}
