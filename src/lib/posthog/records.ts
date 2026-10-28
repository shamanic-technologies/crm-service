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
  /** The phone(s) the person's properties carry (`phone`, `phone_number`, `phoneNumber`), verbatim, deduped. */
  phones: string[];
  /**
   * Known to the brand by a phone property ALONE (not identified, no email): a visitor
   * who typed a number on a form, NOT a signup (facts.ts emits no PostHog `signup` for them).
   */
  phoneOnly: boolean;
  /**
   * Not a signup: no account behind the person. A signup is a REAL account signal only:
   * the product called `identify` (`is_identified`), or the person carries, as a distinct
   * id, the user id of one of the brand's connected auth providers (a server-side capture
   * keyed on the Clerk user id never sets `is_identified`). An email PostHog holds is NOT
   * one (POSTHOG-EMAIL-NOT-SIGNUP-1024): a reader whose email a product `$set` on their
   * anonymous person (a newsletter click, a form) stays a visitor WITH that email. Same for
   * a phone, a name, a website typed on a form (ONBOARDING-IN-UNIBOX-1015). facts.ts / the
   * timeline emit no PostHog `signup` for them.
   */
  notSignup: boolean;
  /** The website the person typed (`website` property), verbatim. */
  website: string | null;
  /** PostHog's distinct ids of the person, verbatim (the brand's own user ids among them). */
  distinctIds: string[];
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  sourceCreatedAt: Date | null;
}

/**
 * `authUserIds`: the user ids of the brand's connected auth providers (auth/sync.ts
 * authUserIds); a person named by one of them has an account.
 */
export function derivePosthogContact(
  payload: Record<string, unknown>,
  authUserIds: ReadonlySet<string> = new Set(),
): DerivedPosthogContact | null {
  const externalId = str(payload.id);
  const email = str(payload.email)?.toLowerCase() ?? null;
  if (!externalId) return null;
  const firstName = str(payload.first_name);
  const lastName = str(payload.last_name);
  const phones = [...new Set(["prop_phone", "prop_phone_number", "prop_phoneNumber"].map((k) => str(payload[k])).filter((v): v is string => !!v))];
  const identified = payload.is_identified === true || payload.is_identified === 1 || payload.is_identified === "true";
  const distinctIds = Array.isArray(payload.distinct_ids)
    ? [...new Set(payload.distinct_ids.map((d) => str(d)).filter((d): d is string => !!d))].sort()
    : [];
  const hasAccount = identified || distinctIds.some((id) => authUserIds.has(id));
  return {
    externalId,
    primaryEmail: email,
    phoneOnly: !identified && !email && phones.length > 0,
    notSignup: !hasAccount,
    website: str(payload.prop_website),
    phones,
    distinctIds,
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

const flag = (v: unknown) => v === 1 || v === true || v === "1" || v === "true";

export type MachineFingerprint = "viewport_equals_screen" | "headless_default_screen";

/**
 * POSTHOG-SCANNER-VISIT-1025 + ROBOTS-NEVER-LEAVE-BRONZE-1028: the machine a visit (bronze payload) is POSITIVELY
 * tied to (client.ts `MACHINE_VIEWPORT_SQL`), or null. Null covers "a person" AND "unknown" (a bronze row read
 * before the fingerprint was asked): never a guess, never a time or pageview threshold. A machine's session stays
 * in bronze only: its visit and every event fired in it never reach silver (`deriveActivities`).
 */
export function visitMachine(payload: Record<string, unknown>): { fingerprint: MachineFingerprint; screen: string | null } | null {
  if (flag(payload.viewport_is_screen)) return { fingerprint: "viewport_equals_screen", screen: str(payload.screen) };
  if (flag(payload.headless_default_screen)) return { fingerprint: "headless_default_screen", screen: str(payload.screen) };
  return null;
}

/**
 * The same rule in SQL over a bronze `posthog_raw_records.payload` (jsonb): HogQL serves the flags as numbers,
 * `->>` reads them as text. Twin of `visitMachine`, keep them together.
 */
export const BRONZE_MACHINE_VISIT_SQL = (payload: string) =>
  `(${payload}->>'viewport_is_screen' IN ('1', 'true') OR ${payload}->>'headless_default_screen' IN ('1', 'true'))`;

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
      machine: visitMachine(payload),
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
    detail: {
      path: str(payload.path),
      sessionId: str(payload.session_id),
      // The brand's own properties on the event (client.ts ownEventProperties): what was entered.
      properties: payload.properties && typeof payload.properties === "object" && !Array.isArray(payload.properties) ? payload.properties : {},
    },
  };
}

/**
 * PURE: the bare domain of a website a person typed ("https://www.Acme.com/x" →
 * "acme.com"), null when it names no host.
 */
export function websiteDomain(website: string | null | undefined): string | null {
  const raw = website?.trim();
  if (!raw) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    const bare = host.replace(/^www\./, "");
    return bare.includes(".") ? bare : null;
  } catch {
    return null;
  }
}

/** A person known by the website they typed and no name: "Visitor from acme.com". */
export const visitorLabel = (website: string | null | undefined): string | null => {
  const domain = websiteDomain(website);
  return domain ? `Visitor from ${domain}` : null;
};

/**
 * Properties PostHog's own SDK puts on every event WITHOUT a `$` (the project's write
 * token, the sender's distinct id): PostHog's bookkeeping, never what the person entered.
 */
const POSTHOG_OWN_KEYS: ReadonlySet<string> = new Set(["token", "distinct_id"]);

/**
 * PURE: what a custom event carried that the BRAND set (ONBOARDING-EVENTS-TO-LEADS-1025):
 * its stored properties minus PostHog's own keys and the empty ones. Generic, no event or
 * property name of any brand.
 */
export function brandEventProperties(properties: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties ?? {}).filter(([k, v]) => !POSTHOG_OWN_KEYS.has(k) && v !== null && v !== undefined && v !== ""),
  );
}

/**
 * PURE: a key event as one readable line, generic for any brand's events: its name in
 * words, then what it carried ("Get started step done · step: company · name: Acme").
 */
export function describeKeyEvent(name: string, properties: Record<string, unknown> | null | undefined): string {
  const words = name.replace(/[_.:-]+/g, " ").replace(/\s+/g, " ").trim();
  const title = words ? words[0].toUpperCase() + words.slice(1) : name;
  const parts = Object.entries(brandEventProperties(properties)).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return [title, ...parts].join(" · ");
}
