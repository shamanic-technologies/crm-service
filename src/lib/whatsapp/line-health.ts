/**
 * WHATSAPP LINE HEALTH (WA-LINE-HEALTH-1023): every linked WhatsApp line's state, as
 * the bridge states it, stored as spans + a daily series the Monitoring hub charts.
 *
 * Owner rule: a monitoring alert = red on the Monitoring hub, never an email or a staff
 * message. So this module SENDS NOTHING: it records, the dashboard renders.
 *
 *  - Watch (in-process, every `WHATSAPP_LINE_WATCH_INTERVAL_MS`, 2 min; first pass 60 s
 *    after boot; `WHATSAPP_LINE_WATCH=off` stops it): one `/whoami` per linked line, every
 *    org / brand, the same code for each. A drop reads red within ~2 min (a reconnect only
 *    once it lasts 15 min: the bridge reconnects on its own and records the recovery).
 *  - Backfill (each boot, before the first watched span of a line): what crm-service already
 *    held: our successful sends (connected at that minute), the `whatsapp_not_connected`
 *    refusals naming the number and the bridge's logout time, and the link's relink time.
 *  - Days: recomputed from spans for every line on boot, then each pass for the days it touched.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixLinks, whatsappLineDays, whatsappLineSpans, whatsappSends } from "../../db/schema.js";
import { BridgeError, bridgeLogins, channelAvailability } from "../matrix/bridge.js";
import {
  applyObservation,
  foldObservations,
  isDown,
  observeLogins,
  observeUnreachable,
  parseLoggedOutRefusal,
  rollupDays,
  type LineObservation,
  type LineState,
  type Span,
} from "./line-health-core.js";

const INTERVAL_MS = () => Number(process.env.WHATSAPP_LINE_WATCH_INTERVAL_MS ?? 120_000);
/** Live: a same-state span grows across at most this gap (a crm-service outage longer than it = unknown minutes). */
const LIVE_MAX_GAP_MS = 15 * 60_000;
/** Backfill: sends are sparse; two successful sends within 6 h are one connected stretch. */
const BACKFILL_MAX_GAP_MS = 6 * 3_600_000;

interface LineKey {
  orgId: string;
  brandId: string;
  phone: string;
}
const keyOf = (k: LineKey) => `${k.orgId}|${k.brandId}|${k.phone}`;

interface LinkedLine extends LineKey {
  linkId: string;
  matrixUserId: string;
  loginId: string;
  linkedAt: Date | null;
}

/** Every linked WhatsApp line of every org / brand. */
async function linkedLines(): Promise<LinkedLine[]> {
  const rows = await db
    .select({
      linkId: matrixLinks.id,
      orgId: matrixLinks.orgId,
      brandId: matrixLinks.brandId,
      matrixUserId: matrixLinks.matrixUserId,
      loginId: matrixLinks.remoteLoginId,
      linkedAt: matrixLinks.linkedAt,
    })
    .from(matrixLinks)
    .where(and(eq(matrixLinks.channel, "whatsapp"), eq(matrixLinks.status, "linked")))
    .orderBy(asc(matrixLinks.linkedAt), asc(matrixLinks.id));
  return rows
    .filter((r) => !!r.matrixUserId && !!r.loginId)
    .map((r) => ({
      linkId: r.linkId,
      orgId: r.orgId,
      brandId: r.brandId,
      matrixUserId: r.matrixUserId!,
      loginId: r.loginId!,
      phone: `+${r.loginId}`,
      linkedAt: r.linkedAt,
    }));
}

async function latestSpan(k: LineKey) {
  const [row] = await db
    .select()
    .from(whatsappLineSpans)
    .where(and(eq(whatsappLineSpans.orgId, k.orgId), eq(whatsappLineSpans.brandId, k.brandId), eq(whatsappLineSpans.phone, k.phone)))
    .orderBy(desc(whatsappLineSpans.startedAt), desc(whatsappLineSpans.createdAt))
    .limit(1);
  return row ?? null;
}

/** Records one observation on its line; answers the day(s) it touched. */
export async function recordObservation(line: LineKey & { linkId: string | null }, obs: LineObservation): Promise<string[]> {
  const prev = await latestSpan(line);
  const prevSpan: Span | null = prev
    ? { state: prev.state as LineState, bridgeState: prev.bridgeState, reason: prev.reason, startedAt: prev.startedAt, lastSeenAt: prev.lastSeenAt }
    : null;
  const action = applyObservation(prevSpan, obs, LIVE_MAX_GAP_MS);
  // Every day from the latest span's last sighting (or the new span's start) to now is touched.
  const touched = new Set<string>();
  const touch = (from: Date) => {
    for (let d = Date.parse(`${from.toISOString().slice(0, 10)}T00:00:00Z`); d <= obs.at.getTime(); d += 86_400_000) {
      touched.add(new Date(d).toISOString().slice(0, 10));
    }
  };
  touch(obs.at);
  if (action.kind === "extend") {
    await db
      .update(whatsappLineSpans)
      .set({ lastSeenAt: action.lastSeenAt, bridgeState: action.bridgeState, reason: action.reason, source: prev!.source === "backfill" ? "watch" : prev!.source })
      .where(eq(whatsappLineSpans.id, prev!.id));
    touch(prev!.lastSeenAt);
  } else {
    if (prev && action.closePreviousAt) {
      await db.update(whatsappLineSpans).set({ lastSeenAt: action.closePreviousAt }).where(eq(whatsappLineSpans.id, prev.id));
      touch(prev.lastSeenAt);
    }
    await db.insert(whatsappLineSpans).values({
      orgId: line.orgId,
      brandId: line.brandId,
      phone: line.phone,
      linkId: line.linkId,
      state: action.span.state,
      bridgeState: action.span.bridgeState,
      reason: action.span.reason,
      startedAt: action.span.startedAt,
      lastSeenAt: action.span.lastSeenAt,
      source: "watch",
    });
    touch(action.span.startedAt);
  }
  return [...touched];
}

/** Every span of a line, oldest first. */
async function spansOf(k: LineKey): Promise<Span[]> {
  const rows = await db
    .select()
    .from(whatsappLineSpans)
    .where(and(eq(whatsappLineSpans.orgId, k.orgId), eq(whatsappLineSpans.brandId, k.brandId), eq(whatsappLineSpans.phone, k.phone)))
    .orderBy(asc(whatsappLineSpans.startedAt), asc(whatsappLineSpans.createdAt));
  return rows.map((r) => ({ state: r.state as LineState, bridgeState: r.bridgeState, reason: r.reason, startedAt: r.startedAt, lastSeenAt: r.lastSeenAt }));
}

/** Recomputes the stored days of one line (all of them, or only `days`). */
export async function recomputeDays(k: LineKey, now: Date, days?: string[]): Promise<number> {
  const rows = rollupDays(await spansOf(k), now).filter((d) => !days || days.includes(d.day));
  for (const d of rows) {
    const values = {
      status: d.status,
      connectedMinutes: d.connectedMinutes,
      reconnectingMinutes: d.reconnectingMinutes,
      downMinutes: d.downMinutes,
      unknownMinutes: d.unknownMinutes,
      recoveredOnItsOwn: d.recoveredOnItsOwn,
      lastState: d.lastState,
      lastReason: d.lastReason,
      computedAt: now,
    };
    await db
      .insert(whatsappLineDays)
      .values({ orgId: k.orgId, brandId: k.brandId, phone: k.phone, day: d.day, ...values })
      .onConflictDoUpdate({ target: [whatsappLineDays.orgId, whatsappLineDays.brandId, whatsappLineDays.phone, whatsappLineDays.day], set: values });
  }
  return rows.length;
}

export interface BackfillResult {
  lines: number;
  spans: number;
  /** Refusals naming no number (the wording before 2026-10-19): not attributable to a line. */
  refusalsWithoutNumber: number;
}

/**
 * Re-derives every line's history BEFORE its first watched span from what crm-service
 * holds: successful sends (connected), refusals naming the number (logged out since the
 * bridge's stated time), the current link's relink time (connected). Idempotent: the
 * backfill rows are replaced whole on each boot.
 */
export async function backfillLines(): Promise<BackfillResult> {
  const observations = new Map<string, { key: LineKey; linkId: string | null; obs: LineObservation[] }>();
  const push = (key: LineKey, linkId: string | null, obs: LineObservation) => {
    const k = keyOf(key);
    const entry = observations.get(k) ?? { key, linkId, obs: [] };
    if (linkId) entry.linkId = linkId;
    entry.obs.push(obs);
    observations.set(k, entry);
  };

  const sent = await db
    .select({ orgId: whatsappSends.orgId, brandId: whatsappSends.brandId, phone: whatsappSends.fromAccount, at: whatsappSends.sentAt })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.status, "sent"), isNotNull(whatsappSends.fromAccount), isNotNull(whatsappSends.sentAt)));
  for (const s of sent) {
    push({ orgId: s.orgId, brandId: s.brandId, phone: s.phone! }, null, {
      state: "connected",
      bridgeState: null,
      reason: null,
      since: null,
      at: s.at!,
    });
  }

  const refused = await db
    .select({ orgId: whatsappSends.orgId, brandId: whatsappSends.brandId, error: whatsappSends.error, at: whatsappSends.createdAt })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.status, "refused"), eq(whatsappSends.errorCode, "whatsapp_not_connected")));
  let refusalsWithoutNumber = 0;
  for (const r of refused) {
    const lines = parseLoggedOutRefusal(r.error ?? "", r.at);
    if (lines.length === 0) refusalsWithoutNumber += 1;
    for (const l of lines) push({ orgId: r.orgId, brandId: r.brandId, phone: l.phone }, null, l.observation);
  }

  const links = await db
    .select({ id: matrixLinks.id, orgId: matrixLinks.orgId, brandId: matrixLinks.brandId, loginId: matrixLinks.remoteLoginId, linkedAt: matrixLinks.linkedAt })
    .from(matrixLinks)
    .where(and(eq(matrixLinks.channel, "whatsapp"), isNotNull(matrixLinks.remoteLoginId), isNotNull(matrixLinks.linkedAt)));
  for (const l of links) {
    push({ orgId: l.orgId, brandId: l.brandId, phone: `+${l.loginId}` }, l.id, {
      state: "connected",
      bridgeState: null,
      reason: null,
      since: l.linkedAt,
      at: l.linkedAt!,
    });
  }

  let spanCount = 0;
  await db.transaction(async (tx) => {
    await tx.delete(whatsappLineSpans).where(eq(whatsappLineSpans.source, "backfill"));
    for (const { key, linkId, obs } of observations.values()) {
      const [firstWatched] = await tx
        .select({ startedAt: whatsappLineSpans.startedAt })
        .from(whatsappLineSpans)
        .where(and(eq(whatsappLineSpans.orgId, key.orgId), eq(whatsappLineSpans.brandId, key.brandId), eq(whatsappLineSpans.phone, key.phone)))
        .orderBy(asc(whatsappLineSpans.startedAt))
        .limit(1);
      const cutoff = firstWatched?.startedAt ?? null;
      const spans = foldObservations(cutoff ? obs.filter((o) => o.at < cutoff) : obs, BACKFILL_MAX_GAP_MS)
        .map((s) => (cutoff && s.lastSeenAt > cutoff ? { ...s, lastSeenAt: cutoff } : s))
        .filter((s) => !cutoff || s.startedAt < cutoff);
      if (spans.length === 0) continue;
      await tx.insert(whatsappLineSpans).values(
        spans.map((s) => ({ ...key, linkId, state: s.state, bridgeState: s.bridgeState, reason: s.reason, startedAt: s.startedAt, lastSeenAt: s.lastSeenAt, source: "backfill" })),
      );
      spanCount += spans.length;
    }
  });
  return { lines: observations.size, spans: spanCount, refusalsWithoutNumber };
}

export interface LineWatchResult {
  checked: number;
  states: Record<string, number>;
  daysRecomputed: number;
  skipped?: "whatsapp_unavailable";
}

/** One pass: every linked line's state from the bridge, recorded, its touched days recomputed. */
export async function runLineWatchPass(now = () => new Date()): Promise<LineWatchResult> {
  if (!channelAvailability("whatsapp").available) return { checked: 0, states: {}, daysRecomputed: 0, skipped: "whatsapp_unavailable" };
  const lines = await linkedLines();
  const states: Record<string, number> = {};
  let daysRecomputed = 0;
  // One /whoami per Matrix account (a login lists every line of its account).
  const loginsByAccount = new Map<string, Awaited<ReturnType<typeof bridgeLogins>> | BridgeError>();
  for (const line of lines) {
    let answer = loginsByAccount.get(line.matrixUserId);
    if (!answer) {
      try {
        answer = await bridgeLogins("whatsapp", line.matrixUserId);
      } catch (err) {
        if (!(err instanceof BridgeError)) throw err;
        answer = err;
      }
      loginsByAccount.set(line.matrixUserId, answer);
    }
    const at = now();
    const obs =
      answer instanceof BridgeError
        ? observeUnreachable(`${answer.code}: ${answer.message}`, at)
        : observeLogins(answer, line.loginId, at, line.linkedAt);
    states[obs.state] = (states[obs.state] ?? 0) + 1;
    const touched = await recordObservation(line, obs);
    daysRecomputed += await recomputeDays(line, at, touched);
  }
  return { checked: lines.length, states, daysRecomputed };
}

/** Boot: backfill, then every line's days recomputed from scratch (a formula change applies at once). */
export async function rebuildLineHealth(now = new Date()): Promise<BackfillResult & { daysRecomputed: number }> {
  const backfill = await backfillLines();
  const keys = await db
    .selectDistinct({ orgId: whatsappLineSpans.orgId, brandId: whatsappLineSpans.brandId, phone: whatsappLineSpans.phone })
    .from(whatsappLineSpans);
  let daysRecomputed = 0;
  for (const k of keys) daysRecomputed += await recomputeDays(k, now);
  return { ...backfill, daysRecomputed };
}

let running = false;

export function startLineWatch(): void {
  if (process.env.WHATSAPP_LINE_WATCH === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runLineWatchPass()
      .catch((e) => console.error("[crm-service][wa-line-health] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    if (running) return;
    running = true;
    rebuildLineHealth()
      .then((r) => console.log("[crm-service][wa-line-health] rebuilt on boot:", JSON.stringify(r)))
      .catch((e) => console.error("[crm-service][wa-line-health] boot rebuild failed:", e))
      .finally(() => {
        running = false;
        tick();
        setInterval(tick, INTERVAL_MS()).unref();
      });
  }, 60_000).unref();
}

/** A pass now, unless one runs. */
export async function runLineWatchNow(): Promise<LineWatchResult | { skipped: "pass_running" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    return await runLineWatchPass();
  } finally {
    running = false;
  }
}

export interface LineHealthView {
  generatedAt: string;
  from: string;
  to: string;
  lines: {
    orgId: string;
    brandId: string;
    phone: string;
    linkId: string | null;
    linked: boolean;
    current: {
      state: LineState | "unknown";
      down: boolean;
      since: string | null;
      checkedAt: string | null;
      bridgeState: string | null;
      reason: string | null;
    };
    days: {
      day: string;
      status: "ok" | "down" | "unknown";
      connectedMinutes: number;
      reconnectingMinutes: number;
      downMinutes: number;
      unknownMinutes: number;
      recoveredOnItsOwn: number;
      lastState: string | null;
      lastReason: string | null;
    }[];
  }[];
}

/** A watched state older than this is no longer "current": the watch is not running. */
const STALE_MS = 15 * 60_000;

/** The Monitoring read: every currently linked line + any line with days in the window, fleet-wide. */
export async function readLineHealth(days: number, now = new Date()): Promise<LineHealthView> {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const linked = await linkedLines();
  const dayRows = await db
    .select()
    .from(whatsappLineDays)
    .where(and(gte(whatsappLineDays.day, from), lte(whatsappLineDays.day, to)))
    .orderBy(asc(whatsappLineDays.day));
  const keys = new Map<string, LineKey & { linkId: string | null; linked: boolean }>();
  for (const l of linked) keys.set(keyOf(l), { orgId: l.orgId, brandId: l.brandId, phone: l.phone, linkId: l.linkId, linked: true });
  for (const d of dayRows) {
    if (!keys.has(keyOf(d))) keys.set(keyOf(d), { orgId: d.orgId, brandId: d.brandId, phone: d.phone, linkId: null, linked: false });
  }
  const phones = [...new Set([...keys.values()].map((k) => k.phone))];
  const latest = phones.length
    ? await db
        .selectDistinctOn([whatsappLineSpans.orgId, whatsappLineSpans.brandId, whatsappLineSpans.phone])
        .from(whatsappLineSpans)
        .where(inArray(whatsappLineSpans.phone, phones))
        .orderBy(whatsappLineSpans.orgId, whatsappLineSpans.brandId, whatsappLineSpans.phone, desc(whatsappLineSpans.startedAt), desc(whatsappLineSpans.createdAt))
    : [];
  const latestBy = new Map(latest.map((s) => [keyOf(s), s]));
  const daysBy = new Map<string, typeof dayRows>();
  for (const d of dayRows) daysBy.set(keyOf(d), [...(daysBy.get(keyOf(d)) ?? []), d]);

  const lines = [...keys.values()].map((k) => {
    const s = latestBy.get(keyOf(k));
    const fresh = !!s && s.source === "watch" && now.getTime() - s.lastSeenAt.getTime() <= STALE_MS;
    const state: LineState | "unknown" = k.linked && fresh ? (s!.state as LineState) : k.linked ? "unknown" : (s?.state as LineState) ?? "unknown";
    return {
      orgId: k.orgId,
      brandId: k.brandId,
      phone: k.phone,
      linkId: k.linkId,
      linked: k.linked,
      current: {
        state,
        // A linked line we cannot vouch for is red: unknown is never healthy.
        down: !k.linked ? false : state === "unknown" ? true : isDown(state, s!.startedAt, now),
        since: s ? s.startedAt.toISOString() : null,
        checkedAt: s && s.source === "watch" ? s.lastSeenAt.toISOString() : null,
        bridgeState: s?.bridgeState ?? null,
        reason: s?.reason ?? null,
      },
      days: (daysBy.get(keyOf(k)) ?? []).map((d) => ({
        day: d.day,
        status: d.status as "ok" | "down" | "unknown",
        connectedMinutes: d.connectedMinutes,
        reconnectingMinutes: d.reconnectingMinutes,
        downMinutes: d.downMinutes,
        unknownMinutes: d.unknownMinutes,
        recoveredOnItsOwn: d.recoveredOnItsOwn,
        lastState: d.lastState,
        lastReason: d.lastReason,
      })),
    };
  });
  lines.sort((a, b) => Number(b.linked) - Number(a.linked) || Number(b.current.down) - Number(a.current.down) || a.phone.localeCompare(b.phone));
  return { generatedAt: now.toISOString(), from, to, lines };
}
