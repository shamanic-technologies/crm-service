/**
 * The identity keys a mirrored contact record states, exactly as the people build derives them
 * (people/sources.ts readers). Shared by the timeline's read-through of records not joined yet
 * (TIMELINE-STALE-SOURCE-1023) and the fact feed, which files a new record's facts on the person
 * holding one of its keys before the next build joins it (UNIBOX-FACT-LAG-1028).
 */
import { keysOf } from "./identity.js";

/** The mirror sources whose contacts state identity keys of their own (email, phone, the brand's user id). */
export const LATE_JOIN_SOURCES = ["gohighlevel", "posthog", "stripe", "clerk"] as const;
export type LateJoinSource = (typeof LATE_JOIN_SOURCES)[number];

export interface MirrorContactRow {
  id: string;
  source: string;
  primaryEmail: string | null;
  phoneE164: string | null;
  externalId: string | null;
  rawAttributes: unknown;
}

/** PURE: the identity keys a mirrored contact states, as the build derives them (people/sources.ts readers). */
export function mirrorContactKeys(r: MirrorContactRow): string[] {
  const raw = (r.rawAttributes ?? {}) as { emails?: unknown; phones?: unknown; distinctIds?: unknown };
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  const one = (x: string | null) => (x ? [x] : []);
  if (r.source === "clerk") {
    return keysOf({ emails: strings(raw.emails), phones: strings(raw.phones), userIds: one(r.externalId) }, null);
  }
  return keysOf(
    { emails: one(r.primaryEmail), phones: one(r.phoneE164), userIds: r.source === "posthog" ? strings(raw.distinctIds) : [] },
    null,
  );
}

