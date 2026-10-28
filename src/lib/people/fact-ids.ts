/**
 * UNIBOX-FACT-ID-1019: a timeline item that IS one of our facts states that fact's id
 * (`ref.factId`), so a reader keyed on the fact (lead-service's copy of the feed,
 * features-service's "written by" rows) pairs the message with it by identity, never
 * by channel + instant.
 *
 * Every item whose record states its fact (`ref.factKey`: Stripe payments / refunds / subscriptions,
 * PostHog visits / events, CRM and auth entries), and every message of a Unibox channel: a Matrix message (WhatsApp,
 * LinkedIn, Telegram... in a one-to-one thread or a group) is the fact `matrix|<event id>`,
 * a Gmail message the fact `gmail|<address>|<gmail message id>`. The id served is the
 * LIVE fact of that natural key (a fact re-stated, e.g. `human_identified`, is the new
 * one). No live fact (a held person, an unattributed group post, a feed not emitted yet)
 * = no `factId`, never a guess. One indexed query per read (`people_facts_live_natural_key_uq`).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleFacts } from "../../db/schema.js";
import { normalizeEmail } from "./identity.js";
import type { TimelineItem } from "./timeline.js";

/** PURE: the natural keys an item may be the fact of, most likely first. Empty = it is no message fact. */
export function factKeysOf(item: TimelineItem, personEmails: string[]): string[] {
  // A reader that knows its record's fact states it (Stripe, PostHog, CRM / auth entries: UNIBOX-FACT-LAG-1028).
  if (typeof item.ref?.factKey === "string" && item.ref.factKey) return [item.ref.factKey];
  if (item.kind !== "message") return [];
  if (item.source === "matrix") {
    const eventId = item.ref?.eventId;
    return typeof eventId === "string" && eventId ? [`matrix|${eventId}`] : [];
  }
  if (item.source === "gmail") {
    const messageId = item.ref?.gmailMessageId;
    if (typeof messageId !== "string" || !messageId) return [];
    if (item.direction !== "inbound" && item.direction !== "outbound") return []; // a third party's mail: no fact
    // A message is stored (and emitted) once per address of the person it involves: the
    // address on the person's side of THIS message (sender inbound, recipient outbound) first.
    const own = new Set(personEmails.map((e) => normalizeEmail(e) ?? e));
    const side = (item.direction === "inbound" ? [item.from] : item.to ?? [])
      .map((e) => (e ? normalizeEmail(e) ?? e : null))
      .filter((e): e is string => !!e && own.has(e));
    const ordered = [...new Set([...side, ...[...own].sort()])];
    return ordered.map((a) => `gmail|${a}|${messageId}`);
  }
  return [];
}

/** Set `ref.factId` on every item that is a live fact of the brand, in place. */
export async function attachFactIds(
  orgId: string,
  brandId: string,
  personEmails: string[],
  items: TimelineItem[],
): Promise<void> {
  const keysByItem = items.map((i) => factKeysOf(i, personEmails));
  const all = [...new Set(keysByItem.flat())];
  if (all.length === 0) return;
  const found = new Map<string, string>();
  for (let i = 0; i < all.length; i += 1000) {
    const rows = await db
      .select({ naturalKey: peopleFacts.naturalKey, factId: peopleFacts.factId })
      .from(peopleFacts)
      .where(
        and(
          eq(peopleFacts.orgId, orgId),
          eq(peopleFacts.brandId, brandId),
          sql`${peopleFacts.live} AND ${peopleFacts.naturalKey} IS NOT NULL`,
          inArray(peopleFacts.naturalKey, all.slice(i, i + 1000)),
        ),
      );
    for (const r of rows) if (r.naturalKey) found.set(r.naturalKey, r.factId);
  }
  items.forEach((item, idx) => {
    const key = keysByItem[idx].find((k) => found.has(k));
    if (key) item.ref = { ...item.ref, factId: found.get(key)! };
  });
}

// ─── is the person's thread on the feed yet? (UNIBOX-FACT-LAG-1028) ─────────

/**
 * A silver write's time is its transaction's START, and a long sync commits later: a record recorded up
 * to this long before an emission began may still have been invisible to it.
 */
export const FACT_SETTLE_MARGIN_MS = 60_000;

export interface FactFeedSettlement {
  /** true = every record of this thread that states a fact is on the people fact feed now. */
  settled: boolean;
  /** When the scope's last fact emission began reading (null = never emitted). */
  statedThrough: string | null;
  /** The thread's items whose fact is still in flight (recorded, not stated on the feed yet). */
  pending: { source: string; at: string | null; step: string | null; factKey: string; recordedAt: string }[];
}

/**
 * PURE: the items of a thread that ARE facts (a fact key) with no live fact yet, recorded by crm-service
 * after the last emission could have read them. Such an item will be stated by the next emission (the
 * fact emitter runs within seconds of a record moving); a writer reading `settled: false` reads again
 * shortly instead of writing on a thread the feed does not hold yet. An item that is no fact by rule
 * (a machine's visit, a held subject) stops counting once an emission began after it was recorded.
 * Call AFTER attachFactIds.
 */
export function factFeedSettlement(items: TimelineItem[], personEmails: string[], statedThrough: Date | null): FactFeedSettlement {
  const bound = statedThrough ? statedThrough.getTime() - FACT_SETTLE_MARGIN_MS : null;
  const pending: FactFeedSettlement["pending"] = [];
  for (const i of items) {
    if (i.ref?.factId) continue;
    const recordedAt = i.ref?.recordedAt;
    if (typeof recordedAt !== "string") continue;
    const [factKey] = factKeysOf(i, personEmails);
    if (!factKey) continue;
    if (bound !== null && Date.parse(recordedAt) <= bound) continue;
    pending.push({ source: i.source, at: i.at, step: i.event?.step ?? null, factKey, recordedAt });
  }
  return { settled: pending.length === 0, statedThrough: statedThrough?.toISOString() ?? null, pending };
}
