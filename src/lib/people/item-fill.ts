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
import { inArray, and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCalls, peopleMessageTexts } from "../../db/schema.js";
import { describeResponse } from "../api-calls/calls.js";
import type { TimelineItem } from "./timeline.js";

type Pending =
  | { kind: "store"; rowId: string }
  | { kind: "api_answer"; orgId: string; brandId: string; callId: string };

const pending = new WeakMap<TimelineItem, Pending>();

/** The stored message's `text` and `textClean` are read when the item is completed. */
export function deferStoredText(item: TimelineItem, rowId: string): void {
  pending.set(item, { kind: "store", rowId });
}

/** The API call's answer summary (`describeResponse`) is computed when the item is completed. */
export function deferApiAnswer(item: TimelineItem, orgId: string, brandId: string, callId: string): void {
  pending.set(item, { kind: "api_answer", orgId, brandId, callId });
}

/** Fill in every deferred part of these items, in place. */
export async function completeItems(items: TimelineItem[]): Promise<void> {
  const store = new Map<string, TimelineItem[]>();
  const api = new Map<string, { orgId: string; brandId: string; items: TimelineItem[] }>();
  for (const item of items) {
    const p = pending.get(item);
    if (!p) continue;
    if (p.kind === "store") store.set(p.rowId, [...(store.get(p.rowId) ?? []), item]);
    else {
      const e = api.get(p.callId) ?? { orgId: p.orgId, brandId: p.brandId, items: [] };
      e.items.push(item);
      api.set(p.callId, e);
    }
  }
  await Promise.all([
    (async () => {
      if (store.size === 0) return;
      const rows = await db
        .select({ id: peopleMessageTexts.id, item: peopleMessageTexts.item })
        .from(peopleMessageTexts)
        .where(inArray(peopleMessageTexts.id, [...store.keys()]));
      const byId = new Map(rows.map((r) => [r.id, r.item as TimelineItem | null]));
      for (const [id, its] of store) {
        const whole = byId.get(id);
        // The row was replaced between the two reads (a re-read of its thread): served without text, never a guess.
        for (const it of its) {
          it.text = whole?.text ?? null;
          it.textClean = whole?.textClean ?? null;
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
