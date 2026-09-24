import type { ChatTrackingHeaders } from "./chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "./judgments-client.js";

/**
 * Column typing (the mapping step). CSV headers from arbitrary client CRM exports
 * must be classified against a FIXED enum. Exactly ONE chat-service judgments
 * call per upload — never per row.
 */

export const COLUMN_FIELDS = [
  "email",
  "phone",
  "first_name",
  "last_name",
  "full_name",
  "other",
] as const;
export type ColumnField = (typeof COLUMN_FIELDS)[number];

/** header name -> classified enum field. */
export type ColumnMapping = Record<string, ColumnField>;

export interface ColumnProfile {
  header: string;
  samples: string[];
}

/**
 * Build a per-header profile: the header name + up to 5 non-null sample values
 * drawn from the data. Fed to the classifier so it can disambiguate ("Contact"
 * could be a name or an email — the samples decide).
 */
export function buildColumnProfiles(
  headers: string[],
  rows: Record<string, string>[],
): ColumnProfile[] {
  return headers.map((header) => {
    const samples: string[] = [];
    for (const row of rows) {
      const v = row[header];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        samples.push(String(v).trim());
        if (samples.length >= 5) break;
      }
    }
    return { header, samples };
  });
}

/** Coerce an arbitrary string into a valid enum field, defaulting to "other". */
function coerceField(value: unknown): ColumnField {
  const v = String(value ?? "").trim();
  return (COLUMN_FIELDS as readonly string[]).includes(v) ? (v as ColumnField) : "other";
}

/**
 * Normalize / validate a caller-supplied override so downstream code can trust it.
 * Unknown fields collapse to "other"; headers absent from the override are "other".
 */
export function normalizeMapping(
  headers: string[],
  raw: Record<string, unknown>,
): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const header of headers) {
    mapping[header] = coerceField(raw[header]);
  }
  return mapping;
}

/**
 * Deterministic header-NAME classifier — the fallback when the chat-service
 * classify call fails or times out. It never touches the network, so the upload
 * can always produce a usable mapping instead of hanging on (or hard-failing on)
 * an unresponsive chat-service. First matching rule wins; email/phone are tried
 * before the name rules so an "email"-in-header never loses to a name pattern.
 * Anything unmatched is "other" (lands in silver raw_attributes), exactly as an
 * LLM "other" would — no data is dropped, only its typing is coarser.
 */
const HEURISTIC_RULES: ReadonlyArray<readonly [ColumnField, RegExp]> = [
  ["email", /e[-_ ]?mail/i],
  ["phone", /\b(phone|mobile|cell|tel(?:ephone)?|whats[-_ ]?app|msisdn)\b/i],
  ["first_name", /\b(first[-_ ]?name|given[-_ ]?name|forename|fname|pr[eé]nom)\b/i],
  ["last_name", /\b(last[-_ ]?name|surname|family[-_ ]?name|lname|nom)\b/i],
  ["full_name", /(full[-_ ]?name|contact[-_ ]?name|customer[-_ ]?name|^\s*name\s*$)/i],
];

export function heuristicMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const header of headers) {
    let field: ColumnField = "other";
    for (const [candidate, re] of HEURISTIC_RULES) {
      if (re.test(header)) {
        field = candidate;
        break;
      }
    }
    mapping[header] = field;
  }
  return mapping;
}

/** What each field means, as the options every column is judged against. */
const FIELD_CRITERIA: Record<ColumnField, string> = {
  email: "an email address",
  phone: "a phone number",
  first_name: "a person's first (given) name only",
  last_name: "a person's last (family) name only",
  full_name: "a person's whole name in a single column",
  other: "anything that is not an email, a phone number or a person's name",
};

/**
 * Below this confidence a column is typed `other`: its values still land in
 * `raw_attributes`, nothing is dropped, and a hesitant guess never becomes an
 * email or a name.
 */
export const COLUMN_TYPING_MIN_CONFIDENCE = 0.5;

/**
 * The classify call is on the SYNCHRONOUS upload path, behind the gateway and
 * Cloudflare's ~100s edge timeout, so it is hard-bounded; the caller falls back
 * to the header-name heuristic on any failure or timeout.
 */
const CLASSIFY_TIMEOUT_MS = Number(process.env.CHAT_SERVICE_TIMEOUT_MS) || 25_000;

/**
 * Classify columns via ONE chat-service judgments call (TypeSafe Jev): one
 * `choice` question per column, over the fixed field list, read against every
 * column's header and sample values. Jev answers with its confidence; a column
 * it hesitates on is typed `other`. chat-service declares the cost against the run.
 */
export async function classifyColumns(
  profiles: ColumnProfile[],
  tracking: ChatTrackingHeaders,
): Promise<ColumnMapping> {
  const questions: Record<string, ChoiceQuestion> = {};
  profiles.forEach((profile, index) => {
    questions[`c${index}`] = {
      type: "choice",
      instructions:
        `A CRM contact export has a column with the header "${profile.header}". ` +
        "Judging from the header and its sample values, what does the column hold?",
      criteria: FIELD_CRITERIA,
    };
  });

  const result = await judgeChoices(
    { columns: profiles.map((p) => ({ header: p.header, samples: p.samples })) },
    questions,
    tracking,
    CLASSIFY_TIMEOUT_MS,
  );

  const mapping: ColumnMapping = {};
  profiles.forEach((profile, index) => {
    const answer = result.answers?.[`c${index}`];
    if (!answer) {
      throw new Error(`[crm-service] column typing: no answer for column "${profile.header}"`);
    }
    if (!(COLUMN_FIELDS as readonly string[]).includes(answer.choice)) {
      throw new Error(`[crm-service] column typing: unknown field "${answer.choice}"`);
    }
    mapping[profile.header] =
      answer.confidence >= COLUMN_TYPING_MIN_CONFIDENCE ? (answer.choice as ColumnField) : "other";
  });
  return mapping;
}
