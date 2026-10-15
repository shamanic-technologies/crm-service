/**
 * campaign-service's generic trigger door (`POST /internal/trigger-events`, lib/trigger-door.ts):
 * one `form_submitted` occurrence per new CRM form submission, naming the
 * person and what they asked. The same door every trigger uses; nothing here is
 * specific to a brand, a form or a campaign.
 *
 * `idempotencyKey` = the submission's own identity, so a retry (a timeout, a
 * crash between the call and our write) returns campaign-service's FIRST event
 * (`replayed: true`) and nothing fires twice.
 */
import type { FormAnswer } from "./submission.js";
import { CampaignRefusal, campaignServiceConfigured, doorPersonKey, recordTriggerEvent, type RecordedOccurrence } from "../trigger-door.js";

export const FORM_SUBMITTED_TRIGGER = "form_submitted";
export { CampaignRefusal, campaignServiceConfigured, type RecordedOccurrence };

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
  // Email when held (byte-identical to before), else the E.164 phone the door names them by.
  const key = doorPersonKey(o.person.email, o.person.phone);
  if (key?.email) person.email = key.email;
  if (o.person.fullName) person.name = o.person.fullName.slice(0, 300);
  if (key?.phone) person.phone = key.phone.slice(0, 50);
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

/**
 * Report one occurrence through the shared trigger door (lib/trigger-door.ts).
 * Throws `CampaignRefusal` on a 4xx, a plain Error on a 5xx / unreachable.
 */
export async function reportOccurrence(o: FormOccurrence): Promise<RecordedOccurrence> {
  return recordTriggerEvent({ orgId: o.orgId, userId: o.userId, runId: o.runId, brandId: o.brandId }, occurrenceBody(o));
}
