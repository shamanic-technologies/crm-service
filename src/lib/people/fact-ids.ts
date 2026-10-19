/**
 * UNIBOX-FACT-ID-1019: a timeline item that IS one of our facts states that fact's id
 * (`ref.factId`), so a reader keyed on the fact (lead-service's copy of the feed,
 * features-service's "written by" rows) pairs the message with it by identity, never
 * by channel + instant.
 *
 * Messages only, every Unibox channel the feed carries: a Matrix message (WhatsApp,
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
