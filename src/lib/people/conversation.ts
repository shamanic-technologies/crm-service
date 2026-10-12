/**
 * Did the brand ever WRITE to this person, and did the person ever ANSWER?
 * Read off the person's presences, the same evidence on every path that asks
 * (the people-pool serve in SQL, the WhatsApp send's reply guard in code).
 *
 * A conversation is a channel where two humans write to each other:
 *  - `gmail`, `matrix` (WhatsApp, LinkedIn…): the presence counts messages each way;
 *  - `instantly` (our cold email): every row is a send of ours; an answer is
 *    `anyReply` (any reply, a "stop" included) or, on a presence built before
 *    that field existed, `replied` (engaged replies only).
 * `copilot` and `api` are the brand's PRODUCT being used, not a conversation
 * with the brand (owner 2026-10-12), and nothing else holds messages.
 */

import { sql } from "drizzle-orm";
import type { Presence } from "./identity.js";

const MESSAGE_SOURCES = ["gmail", "matrix"] as const;

export function wroteToPerson(presences: Pick<Presence, "source" | "outboundCount">[]): boolean {
  return presences.some(
    (p) => p.source === "instantly" || ((MESSAGE_SOURCES as readonly string[]).includes(p.source) && (p.outboundCount ?? 0) > 0),
  );
}

export function personReplied(presences: Pick<Presence, "source" | "inboundCount" | "detail">[]): boolean {
  return presences.some((p) => {
    if ((MESSAGE_SOURCES as readonly string[]).includes(p.source)) return (p.inboundCount ?? 0) > 0;
    if (p.source === "instantly") return p.detail?.anyReply === true || p.detail?.replied === true;
    return false;
  });
}

/** SQL twin of `personReplied` over one `people` row (alias `p`). Keep the two identical. */
export const PERSON_REPLIED_SQL = sql`EXISTS (
  SELECT 1 FROM jsonb_array_elements(p.presences) pr
  WHERE (pr->>'source' IN ('gmail', 'matrix') AND COALESCE((pr->>'inboundCount')::int, 0) > 0)
     OR (pr->>'source' = 'instantly' AND (pr->'detail'->>'anyReply' = 'true' OR pr->'detail'->>'replied' = 'true'))
)`;

/** SQL twin of `wroteToPerson`. */
export const WROTE_TO_PERSON_SQL = sql`EXISTS (
  SELECT 1 FROM jsonb_array_elements(p.presences) pr
  WHERE pr->>'source' = 'instantly'
     OR (pr->>'source' IN ('gmail', 'matrix') AND COALESCE((pr->>'outboundCount')::int, 0) > 0)
)`;
