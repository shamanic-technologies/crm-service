/**
 * Deterministic derivation of GoHighLevel records — bronze payload in, silver
 * row out. Pure functions, zero LLM and zero network: the data arrives already
 * structured, so reading it needs no model and crm-service declares no cost of
 * its own for this source.
 */

import { createHash } from "crypto";

export const GHL_SOURCE = "gohighlevel";

/** The three record kinds mirrored into `ghl_raw_records`. */
export const GHL_RECORD_KINDS = ["contact", "opportunity", "pipeline"] as const;
export type GhlRecordKind = (typeof GHL_RECORD_KINDS)[number];

/**
 * sha256 over the payload with object keys sorted, so the hash depends on the
 * CONTENT and not on the order GoHighLevel happened to serialise it in. That is
 * what makes "re-syncing an unchanged record writes nothing" true rather than
 * accidental.
 */
export function canonicalHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** GoHighLevel timestamps are ISO strings; anything unparseable stays null. */
function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface DerivedContact {
  externalId: string;
  primaryEmail: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  /** GoHighLevel's do-not-disturb flag — the customer's own opt-out. */
  unsubscribed: boolean;

  companyName: string | null;
  website: string | null;

  city: string | null;
  stateRegion: string | null;
  country: string | null;
  postalCode: string | null;
  streetAddress: string | null;

  leadSource: string | null;
  contactType: string | null;
  /** Verbatim labels. `null` when GoHighLevel reports no tags field at all. */
  tags: string[] | null;

  originMedium: string | null;
  originUrl: string | null;
  originReferrer: string | null;

  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
}

/**
 * The FIRST-touch attribution entry, if GoHighLevel recorded one.
 *
 * The array carries one entry flagged `isFirst` and one flagged `isLast`; when
 * neither flag is present the first element is the earliest, which is the order
 * GoHighLevel returns them in. Only the three fields naming WHERE the person came
 * from are read — the same entries also carry IP addresses and user agents, which
 * stay in bronze and are not lifted into silver.
 */
function firstAttribution(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
  );
  if (entries.length === 0) return null;
  return entries.find((e) => e.isFirst === true) ?? entries[0];
}

/** Verbatim string labels. Non-string members are dropped, nothing is coerced. */
function tagList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(str).filter((t): t is string => t !== null);
}

/**
 * A GoHighLevel contact as a silver contact.
 *
 * The full record stays verbatim in bronze; what is lifted here is identity plus
 * what GoHighLevel holds about the person's COMPANY and about where the record
 * came from. Nothing is invented and nothing is re-interpreted: a field the
 * vendor does not hold reads null, free-text values (`source`, `type`, tags) are
 * carried through in the customer's own words, and no value is mapped onto any
 * vocabulary of ours.
 *
 * `dnd` is carried through as `unsubscribed` because it IS the customer's own
 * do-not-contact mark on that person.
 */
export function deriveContact(payload: Record<string, unknown>): DerivedContact | null {
  const externalId = str(payload.id);
  if (!externalId) return null;

  const email = str(payload.email);
  const first = str(payload.firstName);
  const last = str(payload.lastName);
  const named = str(payload.contactName) ?? str(payload.name);
  const fullName = named ?? (str([first, last].filter(Boolean).join(" ")) as string | null);

  const phone = str(payload.phone);

  const attribution = firstAttribution(payload.attributions);

  return {
    externalId,
    primaryEmail: email ? email.toLowerCase() : null,
    // Kept only when GoHighLevel already reports it in E.164 — a national-format
    // number is not guessed into one. The raw value stays in bronze either way.
    phoneE164: phone && /^\+[0-9]{6,15}$/.test(phone) ? phone : null,
    firstName: first,
    lastName: last,
    fullName,
    unsubscribed: payload.dnd === true,

    companyName: str(payload.companyName),
    website: str(payload.website),

    city: str(payload.city),
    stateRegion: str(payload.state),
    country: str(payload.country),
    postalCode: str(payload.postalCode),
    streetAddress: str(payload.address1),

    leadSource: str(payload.source),
    contactType: str(payload.type),
    tags: tagList(payload.tags),

    originMedium: attribution ? str(attribution.medium) : null,
    originUrl: attribution ? (str(attribution.url) ?? str(attribution.pageUrl)) : null,
    originReferrer: attribution ? str(attribution.referrer) : null,

    sourceCreatedAt: date(payload.dateAdded),
    sourceUpdatedAt: date(payload.dateUpdated),
  };
}

export interface DerivedStage {
  id: string;
  name: string | null;
  position: number | null;
}

export interface DerivedPipeline {
  externalId: string;
  name: string;
  stages: DerivedStage[];
}

/** A pipeline with its stages in the order GoHighLevel lists them. */
export function derivePipeline(payload: Record<string, unknown>): DerivedPipeline | null {
  const externalId = str(payload.id);
  if (!externalId) return null;

  const rawStages = Array.isArray(payload.stages) ? payload.stages : [];
  const stages: DerivedStage[] = [];
  rawStages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const stage = raw as Record<string, unknown>;
    const id = str(stage.id);
    if (!id) return;
    stages.push({
      id,
      name: str(stage.name),
      position: typeof stage.position === "number" ? stage.position : index,
    });
  });

  return { externalId, name: str(payload.name) ?? externalId, stages };
}

export interface DerivedOpportunity {
  externalId: string;
  name: string;
  pipelineExternalId: string | null;
  stageExternalId: string | null;
  status: string | null;
  monetaryValue: string | null;
  assignedTo: string | null;
  externalContactId: string | null;
  ghlCreatedAt: Date | null;
  ghlUpdatedAt: Date | null;
}

/**
 * An opportunity exactly as GoHighLevel reports it: its pipeline, its stage, its
 * status and its value. None of those are re-bucketed — "won" means what
 * GoHighLevel means by it, and the monetary value is kept as a numeric string so
 * a fractional amount survives the round trip unrounded.
 */
export function deriveOpportunity(
  payload: Record<string, unknown>,
): DerivedOpportunity | null {
  const externalId = str(payload.id);
  if (!externalId) return null;

  const contactId =
    str(payload.contactId) ??
    (payload.contact && typeof payload.contact === "object"
      ? str((payload.contact as Record<string, unknown>).id)
      : null);

  const value = payload.monetaryValue;

  return {
    externalId,
    name: str(payload.name) ?? externalId,
    pipelineExternalId: str(payload.pipelineId),
    stageExternalId: str(payload.pipelineStageId),
    status: str(payload.status),
    monetaryValue: typeof value === "number" && Number.isFinite(value) ? String(value) : str(value),
    assignedTo: str(payload.assignedTo),
    externalContactId: contactId,
    ghlCreatedAt: date(payload.createdAt),
    ghlUpdatedAt: date(payload.updatedAt),
  };
}
