/**
 * Paged timeline reads build the WHOLE thread to order it, but only a page leaves
 * (DASH-LATENCY-1014). The heavy part of an item is its text: a stored Gmail message
 * carries its body and its original (5.5 MB over one person's 943 messages), an API
 * call's answer is summarised from its stored response body (17 MB of JSON parsed for
 * one person's 1,082 calls). A paged read builds those items WITHOUT the heavy part and
 * registers here how to complete them; `completeItems` completes only the page.
 *
 * An item never registered is already whole. A whole-thread read registers nothing.
 */
import { inArray, and, eq, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCalls, peopleMessageTexts } from "../../db/schema.js";
import { describeResponse } from "../api-calls/calls.js";
import type { TimelineItem } from "./timeline.js";

/**
 * Where a stored message lives: its row id, and the message's own key in its unit. A re-read of
 * the thread deletes and re-writes every row of the unit (new ids, same keys), often while the
 * paged read that listed the old ids is still answering, so the key finds the re-written row.
 */
export type StoredMessageRef = { rowId: string; scopeId: string; source: string; unit: string; messageKey: string };

type Pending =
  | ({ kind: "store" } & StoredMessageRef)
  | { kind: "api_answer"; orgId: string; brandId: string; callId: string };

const pending = new WeakMap<TimelineItem, Pending>();

/** The stored message's `text` and `textClean` are read when the item is completed. */
export function deferStoredText(item: TimelineItem, ref: StoredMessageRef): void {
  pending.set(item, { kind: "store", ...ref });
}

const refKey = (r: { scopeId: string; source: string; unit: string; messageKey: string }) =>
  `${r.scopeId}|${r.source}|${r.unit}|${r.messageKey}`;

/**
 * PURE: the whole item for each pending message, by its row id, else (the row was re-written
 * by a re-read of its thread) by its key in its unit. Null only when the message is gone.
 */
export function matchStoredRows(
  refs: StoredMessageRef[],
  rows: { id: string; scopeId: string; source: string; unit: string; messageKey: string; item: unknown }[],
): Map<string, TimelineItem | null> {
  const byId = new Map(rows.map((r) => [r.id, r.item as TimelineItem | null]));
  const byKey = new Map(rows.map((r) => [refKey(r), r.item as TimelineItem | null]));
  return new Map(refs.map((ref) => [ref.rowId, byId.get(ref.rowId) ?? byKey.get(refKey(ref)) ?? null]));
}

/** The API call's answer summary (`describeResponse`) is computed when the item is completed. */
export function deferApiAnswer(item: TimelineItem, orgId: string, brandId: string, callId: string): void {
  pending.set(item, { kind: "api_answer", orgId, brandId, callId });
}

/** Fill in every deferred part of these items, in place. */
export async function completeItems(items: TimelineItem[]): Promise<void> {
  const store = new Map<string, { ref: StoredMessageRef; items: TimelineItem[] }>();
  const api = new Map<string, { orgId: string; brandId: string; items: TimelineItem[] }>();
  for (const item of items) {
    const p = pending.get(item);
    if (!p) continue;
    if (p.kind === "store") {
      const { kind: _kind, ...ref } = p;
      const e = store.get(p.rowId) ?? { ref, items: [] };
      e.items.push(item);
      store.set(p.rowId, e);
    } else {
      const e = api.get(p.callId) ?? { orgId: p.orgId, brandId: p.brandId, items: [] };
      e.items.push(item);
      api.set(p.callId, e);
    }
  }
  await Promise.all([
    (async () => {
      if (store.size === 0) return;
      const refs = [...store.values()].map((e) => e.ref);
      const rows = await db
        .select({
          id: peopleMessageTexts.id,
          scopeId: peopleMessageTexts.scopeId,
          source: peopleMessageTexts.source,
          unit: peopleMessageTexts.unit,
          messageKey: peopleMessageTexts.messageKey,
          item: peopleMessageTexts.item,
        })
        .from(peopleMessageTexts)
        .where(
          or(
            inArray(peopleMessageTexts.id, refs.map((r) => r.rowId)),
            ...refs.map((r) =>
              and(
                eq(peopleMessageTexts.scopeId, r.scopeId),
                eq(peopleMessageTexts.source, r.source),
                eq(peopleMessageTexts.unit, r.unit),
                eq(peopleMessageTexts.messageKey, r.messageKey),
              ),
            ),
          ),
        );
      const whole = matchStoredRows(refs, rows);
      for (const [id, { items: its }] of store) {
        const w = whole.get(id) ?? null;
        // The message left the store between the two reads (its thread no longer holds it): served without text, never a guess.
        for (const it of its) {
          it.text = w?.text ?? null;
          it.textClean = w?.textClean ?? null;
          pending.delete(it);
        }
      }
    })(),
    (async () => {
      if (api.size === 0) return;
      const [{ orgId, brandId }] = [...api.values()];
      const rows = await db
        .select({
          callId: apiCalls.callId,
          status: apiCalls.status,
          responseBody: apiCalls.responseBody,
          responseBodyBytes: apiCalls.responseBodyBytes,
          responseBodyTruncated: apiCalls.responseBodyTruncated,
          durationMs: apiCalls.durationMs,
        })
        .from(apiCalls)
        .where(and(eq(apiCalls.orgId, orgId), eq(apiCalls.brandId, brandId), inArray(apiCalls.callId, [...api.keys()])));
      const byCall = new Map(rows.map((r) => [r.callId, r]));
      for (const [callId, e] of api) {
        const call = byCall.get(callId);
        for (const it of e.items) {
          if (call) it.text = describeResponse(call);
          pending.delete(it);
        }
      }
    })(),
  ]);
}
