/**
 * What one CRM form submission says: who filled it and what they asked. PURE.
 *
 * Read off GoHighLevel's own submission record (`GET /forms/submissions`), the
 * same record the full sync mirrors to bronze. Nothing is guessed: a field the
 * record does not carry is null.
 */
import { normalizeEmail, normalizePhone } from "../people/identity.js";

export interface FormAnswer {
  /** The form field's key as GoHighLevel names it (a custom field id, or a standard key like `company_name`). */
  key: string;
  /** The customer's own label for a custom field; null for a standard key. */
  label: string | null;
  value: string | number | boolean | string[];
}

export interface SubmissionPerson {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /** GoHighLevel's contact id. */
  sourceContactId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/** The person's identity keys, the ones that go to `person`, never repeated as answers. */
const IDENTITY_KEYS = new Set(["full_name", "first_name", "last_name", "name", "email", "phone"]);

/**
 * GoHighLevel's FIXED form-element vocabulary that carries no answer of the
 * person: a submit button, a heading, a block of html, the consent text the form
 * displays, a captcha. Mapping a vendor's fixed vocabulary is fine (the doctrine
 * forbids mapping the CUSTOMER's free text, not the vendor's element types).
 */
const NOT_AN_ANSWER = new Set(["button", "header", "html", "terms_and_conditions", "captcha"]);

export function submissionPerson(payload: Record<string, unknown>): SubmissionPerson {
  const others = isRecord(payload.others) ? payload.others : {};
  const rawEmail = str(payload.email) ?? str(others.email);
  const rawPhone = str(others.phone) ?? str(payload.phone);
  const first = str(others.first_name);
  const last = str(others.last_name);
  return {
    fullName: str(payload.name) ?? str(others.full_name) ?? ([first, last].filter(Boolean).join(" ") || null),
    email: normalizeEmail(rawEmail) ?? rawEmail,
    phone: normalizePhone(rawPhone) ?? rawPhone,
    sourceContactId: str(payload.contactId),
  };
}

function answerValue(v: unknown): FormAnswer["value"] | null {
  if (typeof v === "string") return v.trim().length > 0 ? v.trim() : null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    const items = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return items.length > 0 ? items : null;
  }
  return null;
}

/**
 * What the person answered, in the form's own field order (`fieldsOriSequance`,
 * GoHighLevel's spelling). Identity keys go to the person, not here; a field
 * left blank is absent. A record with no field order carries no answer we can
 * place, so it answers [] (never a dump of the record's metadata).
 */
export function submissionAnswers(payload: Record<string, unknown>, labels: Map<string, string>): FormAnswer[] {
  const others = isRecord(payload.others) ? payload.others : {};
  const order = Array.isArray(others.fieldsOriSequance) ? others.fieldsOriSequance : [];
  const out: FormAnswer[] = [];
  for (const key of order) {
    if (typeof key !== "string" || IDENTITY_KEYS.has(key) || NOT_AN_ANSWER.has(key)) continue;
    const value = answerValue(others[key]);
    if (value === null) continue;
    out.push({ key, label: labels.get(key) ?? null, value });
  }
  return out;
}

/**
 * A calendar's own booking form: filling it IS booking the meeting, so it is
 * never a `form_submitted` (same rule as the reads, outcomes.ts
 * `NOT_CALENDAR_BOOKING_FORM`). Structural, two vendor statements: the form is a
 * mirrored calendar's `formId`, or the submission says it came from a calendar
 * (`others.internalSource.type = "calendars"`, which also covers a calendar
 * created since the last full sync).
 */
export function isCalendarBookingForm(payload: Record<string, unknown>, calendarFormIds: Set<string>): boolean {
  const formId = str(payload.formId);
  if (formId && calendarFormIds.has(formId)) return true;
  const others = isRecord(payload.others) ? payload.others : {};
  const internal = isRecord(others.internalSource) ? others.internalSource : null;
  return internal?.type === "calendars";
}
