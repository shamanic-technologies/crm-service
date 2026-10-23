/**
 * WHATSAPP LINE HEALTH, PURE PART (WA-LINE-HEALTH-1023).
 *
 * A "line" is one WhatsApp number a brand linked (org, brand, phone). Its health is
 * read from what the bridge SAYS about the login (`/whoami`), never inferred from
 * traffic: a line nobody writes from must not read healthy for lack of failures.
 *
 * Observations become SPANS (one state, from when to when). A span grows while the
 * same state is observed again; a new state opens a new span. Days are rolled up
 * from spans: minutes connected / reconnecting / down / unknown per UTC day.
 *
 * Prod 2026-10-19 → 10-22: distribute.you's +77776879632 was logged out by WhatsApp
 * for 3 days ("You were logged out from another device"), every greeting refused
 * `whatsapp_not_connected`, nobody saw it.
 */

import type { BridgeLogin } from "../matrix/bridge.js";
import { loginStatus } from "./accounts.js";

/**
 * - `connected`: the bridge says CONNECTED / BACKFILLING;
 * - `reconnecting`: any other bridge state (CONNECTING, TRANSIENT_DISCONNECT, UNKNOWN_ERROR...):
 *   the bridge reconnects on its own; red only once it lasts longer than `STUCK_RECONNECT_MS`;
 * - `logged_out`: BAD_CREDENTIALS / LOGGED_OUT or the login is gone: only a relink (QR) helps;
 * - `bridge_unreachable`: the bridge did not answer: nothing can be sent either.
 */
export const LINE_STATES = ["connected", "reconnecting", "logged_out", "bridge_unreachable"] as const;
export type LineState = (typeof LINE_STATES)[number];

/** A reconnect the bridge has not finished within 15 min is not a blip: it reads down. */
export const STUCK_RECONNECT_MS = 15 * 60_000;

export interface LineObservation {
  state: LineState;
  /** The bridge's own `state_event` (CONNECTED, BAD_CREDENTIALS...), null when it gave none. */
  bridgeState: string | null;
  /** The bridge's own words ("You were logged out from another device..."). */
  reason: string | null;
  /** When the state began, as stated by its source (the bridge's timestamp, the relink time). */
  since: Date | null;
  /** When it was observed. */
  at: Date;
}

export interface Span {
  state: LineState;
  bridgeState: string | null;
  reason: string | null;
  startedAt: Date;
  lastSeenAt: Date;
}

/** PURE: one line's observation from the bridge's `/whoami` answer. `linkedAt` = when the login was made. */
export function observeLogins(logins: BridgeLogin[], loginId: string, at: Date, linkedAt: Date | null): LineObservation {
  const st = loginStatus(logins, loginId);
  const login = logins.find((l) => l.id === loginId);
  const ts = login?.state?.timestamp;
  const stated = typeof ts === "number" ? new Date(ts * 1000) : null;
  if (st.kind === "connected") {
    return { state: "connected", bridgeState: login?.state?.state_event ?? null, reason: null, since: stated ?? linkedAt, at };
  }
  if (st.kind === "logged_out") {
    return { state: "logged_out", bridgeState: st.stateEvent, reason: st.message ?? (login ? null : "The login is gone from the bridge."), since: st.since, at };
  }
  return {
    state: "reconnecting",
    bridgeState: st.stateEvent,
    reason: login?.state?.message ?? login?.state?.error ?? null,
    since: stated,
    at,
  };
}

/** PURE: the bridge did not answer. */
export function observeUnreachable(message: string, at: Date): LineObservation {
  return { state: "bridge_unreachable", bridgeState: null, reason: message, since: null, at };
}

export type SpanAction =
  | { kind: "extend"; lastSeenAt: Date; bridgeState: string | null; reason: string | null }
  | { kind: "open"; span: Span; closePreviousAt: Date | null };

/**
 * PURE: what one observation does to the line's latest span.
 * - same state (a logged-out line: same logout, i.e. not stated as starting after the
 *   span was last seen) within `maxGapMs` → the span grows;
 * - else a new span opens at its stated start (never before the previous span was last
 *   seen), and the previous span is stretched to that start when the gap is short, or
 *   always when it was a logout (a logged-out line comes back only by a relink, whose
 *   time IS the new span's start).
 */
export function applyObservation(prev: Span | null, obs: LineObservation, maxGapMs: number): SpanAction {
  if (prev && prev.state === obs.state) {
    const gap = obs.at.getTime() - prev.lastSeenAt.getTime();
    const sameLogout = obs.state === "logged_out" && !(obs.since && obs.since > prev.lastSeenAt);
    if (sameLogout || (obs.state !== "logged_out" && gap <= maxGapMs)) {
      return {
        kind: "extend",
        lastSeenAt: obs.at > prev.lastSeenAt ? obs.at : prev.lastSeenAt,
        bridgeState: obs.bridgeState ?? prev.bridgeState,
        reason: obs.reason ?? prev.reason,
      };
    }
  }
  let start = obs.since && obs.since <= obs.at ? obs.since : obs.at;
  if (prev && start < prev.lastSeenAt) start = prev.lastSeenAt;
  const closePreviousAt =
    prev && start > prev.lastSeenAt && (prev.state === "logged_out" || start.getTime() - prev.lastSeenAt.getTime() <= maxGapMs)
      ? start
      : null;
  return {
    kind: "open",
    span: { state: obs.state, bridgeState: obs.bridgeState, reason: obs.reason, startedAt: start, lastSeenAt: obs.at },
    closePreviousAt,
  };
}

/** PURE: folds time-ordered observations into spans (the backfill uses it; the live watch applies one at a time). */
export function foldObservations(observations: LineObservation[], maxGapMs: number): Span[] {
  const spans: Span[] = [];
  for (const obs of [...observations].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const prev = spans.at(-1) ?? null;
    const action = applyObservation(prev, obs, maxGapMs);
    if (action.kind === "extend") {
      Object.assign(prev!, { lastSeenAt: action.lastSeenAt, bridgeState: action.bridgeState, reason: action.reason });
    } else {
      if (prev && action.closePreviousAt) prev.lastSeenAt = action.closePreviousAt;
      spans.push(action.span);
    }
  }
  return spans;
}

/**
 * PURE: what a past `whatsapp_not_connected` refusal states about each line
 * (lib/whatsapp/accounts.ts `describeLoggedOut`): "WhatsApp logged out +<digits> at
 * <YYYY-MM-DD HH:MM> UTC (the bridge says: "<words>")". The older wording ("linked but
 * not connected right now") names no number and states nothing per line.
 */
export function parseLoggedOutRefusal(text: string, at: Date): { phone: string; observation: LineObservation }[] {
  const out: { phone: string; observation: LineObservation }[] = [];
  const re = /WhatsApp logged out \+(\d+)(?: at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC)?(?: \(the bridge says: "([^"]*)"\))?/g;
  for (const m of text.matchAll(re)) {
    const since = m[2] ? new Date(`${m[2].replace(" ", "T")}:00Z`) : null;
    out.push({
      phone: `+${m[1]}`,
      observation: {
        state: "logged_out",
        bridgeState: null,
        reason: m[3] ?? (m[0].includes("(its login is gone") ? "The login is gone from the bridge." : null),
        since: since && !Number.isNaN(since.getTime()) ? since : null,
        at,
      },
    });
  }
  return out;
}

export interface LineDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** `down` = any minute logged out, bridge unreachable or stuck reconnecting; `ok` = connected, never down; `unknown` = nothing observed. */
  status: "ok" | "down" | "unknown";
  connectedMinutes: number;
  /** Short reconnects the bridge finished on its own (not red). */
  reconnectingMinutes: number;
  downMinutes: number;
  unknownMinutes: number;
  /** Reconnects that ended connected on this day, with no human: the bridge healed itself. */
  recoveredOnItsOwn: number;
  /** The state at the day's last observed minute, and the bridge's words then. */
  lastState: LineState | null;
  lastReason: string | null;
}

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * PURE: one row per UTC day from the first span's day to `now`'s day. Minutes are
 * clipped to `now` (today counts only the minutes elapsed). Spans are clipped to never
 * overlap (an earlier span ends where a later one starts).
 */
export function rollupDays(input: Span[], now: Date): LineDay[] {
  const spans = [...input].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  if (spans.length === 0) return [];
  const clipped = spans.map((s, i) => {
    const next = spans[i + 1];
    const end = next && next.startedAt < s.lastSeenAt ? next.startedAt : s.lastSeenAt;
    return { ...s, end: end > now ? now : end };
  });
  const first = Date.parse(`${dayOf(clipped[0].startedAt)}T00:00:00Z`);
  const out: LineDay[] = [];
  for (let d0 = first; d0 <= now.getTime(); d0 += DAY_MS) {
    const d1 = Math.min(d0 + DAY_MS, now.getTime());
    let connected = 0;
    let reconnecting = 0;
    let down = 0;
    let recovered = 0;
    let last: (typeof clipped)[number] | null = null;
    clipped.forEach((s, i) => {
      const a = Math.max(s.startedAt.getTime(), d0);
      const b = Math.min(s.end.getTime(), d1);
      if (b > a) {
        const ms = b - a;
        if (s.state === "connected") connected += ms;
        else if (s.state === "reconnecting") {
          if (s.end.getTime() - s.startedAt.getTime() > STUCK_RECONNECT_MS) down += ms;
          else reconnecting += ms;
        } else down += ms;
        if (!last || s.startedAt >= last.startedAt) last = s;
      }
      const next = clipped[i + 1];
      if (
        s.state === "reconnecting" &&
        s.end.getTime() - s.startedAt.getTime() <= STUCK_RECONNECT_MS &&
        next?.state === "connected" &&
        next.startedAt.getTime() >= d0 &&
        next.startedAt.getTime() < d0 + DAY_MS
      ) {
        recovered += 1;
      }
    });
    const minutes = (ms: number) => Math.round(ms / 60_000);
    const total = minutes(d1 - d0);
    const c = minutes(connected);
    const r = minutes(reconnecting);
    const dn = minutes(down);
    const lastSpan = last as (typeof clipped)[number] | null;
    out.push({
      day: dayOf(new Date(d0)),
      status: down > 0 ? "down" : connected + reconnecting > 0 ? "ok" : "unknown",
      connectedMinutes: c,
      reconnectingMinutes: r,
      downMinutes: dn,
      unknownMinutes: Math.max(0, total - c - r - dn),
      recoveredOnItsOwn: recovered,
      lastState: lastSpan?.state ?? null,
      lastReason: lastSpan?.reason ?? null,
    });
  }
  return out;
}

/** PURE: is this state red on the Monitoring hub right now? */
export function isDown(state: LineState, startedAt: Date, now: Date): boolean {
  if (state === "connected") return false;
  if (state === "reconnecting") return now.getTime() - startedAt.getTime() > STUCK_RECONNECT_MS;
  return true;
}
