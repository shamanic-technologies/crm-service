import { chatComplete, ChatTrackingHeaders } from "./chat-client.js";

/**
 * Column typing (the mapping step). CSV headers from arbitrary client CRM exports
 * must be classified against a FIXED enum. Exactly ONE chat-service call per upload
 * — never per row.
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

const SYSTEM_PROMPT =
  "You are a data-mapping assistant. You classify spreadsheet columns for a CRM " +
  "contact importer. For each column you are given its header name and a few " +
  "sample values. Classify each column into exactly one of: email, phone, " +
  "first_name, last_name, full_name, other. Use 'full_name' only when a single " +
  "column holds the whole name; use 'first_name'/'last_name' for split name " +
  "columns. Anything that is not an email, phone, or name is 'other'.";

/**
 * Classify columns via ONE chat-service /complete call. Returns a mapping keyed by
 * every header. Uses a strict structured responseSchema so the provider enforces
 * the enum server-side. chat-service self-declares the LLM cost against the run.
 */
export async function classifyColumns(
  profiles: ColumnProfile[],
  tracking: ChatTrackingHeaders,
): Promise<ColumnMapping> {
  const headers = profiles.map((p) => p.header);

  const responseSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      columns: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            header: { type: "string" },
            field: { type: "string", enum: [...COLUMN_FIELDS] },
          },
          required: ["header", "field"],
        },
      },
    },
    required: ["columns"],
  };

  const message = [
    "Classify each of these CSV columns. Respond with one entry per column.",
    "",
    JSON.stringify(
      profiles.map((p) => ({ header: p.header, samples: p.samples })),
      null,
      2,
    ),
  ].join("\n");

  const result = await chatComplete(
    {
      message,
      systemPrompt: SYSTEM_PROMPT,
      provider: "anthropic",
      model: "haiku",
      responseFormat: "json",
      responseSchema,
      temperature: 0,
      maxTokens: 4096,
      disableThinking: true,
    },
    tracking,
  );

  const json = result.json as { columns?: Array<{ header?: string; field?: string }> } | undefined;
  if (!json || !Array.isArray(json.columns)) {
    throw new Error("[crm-service] column typing: chat-service returned no columns array");
  }

  const byHeader = new Map<string, ColumnField>();
  for (const entry of json.columns) {
    if (entry && typeof entry.header === "string") {
      byHeader.set(entry.header, coerceField(entry.field));
    }
  }

  // Every header gets a field; anything the classifier omitted defaults to "other".
  const mapping: ColumnMapping = {};
  for (const header of headers) {
    mapping[header] = byHeader.get(header) ?? "other";
  }
  return mapping;
}
