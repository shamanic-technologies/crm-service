/**
 * Deriving PostHog silver from bronze — pure, deterministic, zero LLM.
 *
 * Identity is PostHog's own: an identified person, with the email PostHog
 * holds (trimmed and lower-cased, nothing else) when it holds one, and the
 * distinct ids the brand named them by (its auth provider's user id among
 * them) — no name matching, no model.
 */

export const POSTHOG_SOURCE = "posthog";
export const POSTHOG_RECORD_KINDS = ["person", "visit", "event"] as const;
export type PosthogRecordKind = (typeof POSTHOG_RECORD_KINDS)[number];

/** HogQL serves a missing property as `null` or `''`; both are "absent". */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "null" ? trimmed : null;
}

function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The bronze id of a visit: one session of one person. */
export const visitId = (row: Record<string, unknown>) => `${row.session_id}:${row.person_id}`;

export interface DerivedPosthogContact {
  externalId: string;
  primaryEmail: string | null;
  /** PostHog's distinct ids of the person, verbatim (the brand's own user ids among them). */
  distinctIds: string[];
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  sourceCreatedAt: Date | null;
}

export function derivePosthogContact(payload: Record<string, unknown>): DerivedPosthogContact | null {
  const externalId = str(payload.id);
  const email = str(payload.email)?.toLowerCase() ?? null;
  if (!externalId) return null;
  const firstName = str(payload.first_name);
  const lastName = str(payload.last_name);
  return {
    externalId,
    primaryEmail: email,
    distinctIds: Array.isArray(payload.distinct_ids)
      ? [...new Set(payload.distinct_ids.map((d) => str(d)).filter((d): d is string => !!d))].sort()
      : [],
    fullName: str(payload.name) ?? ([firstName, lastName].filter(Boolean).join(" ") || null),
    firstName,
    lastName,
    sourceCreatedAt: date(payload.created_at),
  };
}

export interface DerivedActivity {
  kind: "visit" | "event";
  externalId: string;
  externalPersonId: string;
  occurredAt: Date;
  endedAt: Date | null;
  name: string;
  url: string | null;
  pageviews: number | null;
  detail: Record<string, unknown>;
}

export function deriveVisit(payload: Record<string, unknown>): DerivedActivity | null {
  const personId = str(payload.person_id);
  const sessionId = str(payload.session_id);
  const startedAt = date(payload.started_at);
  if (!personId || !sessionId || !startedAt) return null;
  const url = str(payload.entry_url);
  return {
    kind: "visit",
    externalId: visitId(payload),
    externalPersonId: personId,
    occurredAt: startedAt,
    endedAt: date(payload.ended_at),
    name: str(payload.entry_path) ?? url ?? "(unknown page)",
    url,
    pageviews: typeof payload.pageviews === "number" ? payload.pageviews : Number(payload.pageviews ?? 0),
    detail: {
      sessionId,
      paths: Array.isArray(payload.paths) ? payload.paths.filter((p) => str(p)) : [],
      referrer: str(payload.referrer),
    },
  };
}

export function deriveKeyEvent(payload: Record<string, unknown>): DerivedActivity | null {
  const id = str(payload.id);
  const personId = str(payload.person_id);
  const name = str(payload.event);
  const at = date(payload.timestamp);
  if (!id || !personId || !name || !at) return null;
  return {
    kind: "event",
    externalId: id,
    externalPersonId: personId,
    occurredAt: at,
    endedAt: null,
    name,
    url: str(payload.url),
    pageviews: null,
    detail: { path: str(payload.path), sessionId: str(payload.session_id) },
  };
}
