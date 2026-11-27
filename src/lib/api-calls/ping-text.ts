/**
 * PURE: the owner's Telegram text for external API / MCP calls.
 *
 * TG-DAILY-DIGEST-1127 (owner 2026-11-27 « Je suis trop de ce type de message », then « un message par day all users »):
 * every external call is told in ONE daily digest (`composeDigestText`); only a call that is part of an agent SIGNUP or
 * an ERROR from a PAYING client still pings live (`liveReason`), with the shapes of TG-EVERY-CALL-1124 below:
 *
 *  - ONE call, one message, readable in 2 seconds (who, what, result, thread):
 *
 *      MCP call · Jane Doe (jane@acme.com) · Acme
 *      Did: tool distribute_list_emails · Listed emails for brand Acme
 *      Result: ✅ Answered: 12 emails (200, 120 ms)
 *      Thread: https://dashboard.distribute.you/v2/orgs/…/unibox?person=…
 *
 *  - a BURST beyond the chat's per-minute budget, ONE message listing every call, grouped per person
 *    (`composeGroupedText`); when the list would not fit one Telegram message, a per-person summary
 *    with counts (`summary` mode); every call is always counted in the header, none dropped.
 *
 * No em / en dash anywhere (fleet rule).
 */

import type { ApiCallChannel } from "./calls.js";

/** Telegram refuses more than 4096 characters; a grouped message stays under this so it is ONE message. */
export const GROUPED_TEXT_MAX = 4000;
const DID_MAX = 300;
const RESULT_MAX = 300;
const GROUP_LINE_DID_MAX = 90;

const CHANNEL_LABEL: Record<ApiCallChannel, string> = { api: "API", mcp: "MCP" };

export interface CallLine {
  callId: string;
  channel: ApiCallChannel;
  email: string;
  /** The caller's name, when known. */
  name: string | null;
  /** The org the call acted in, by name, when known. */
  orgName: string | null;
  /** true = the call carried no account yet (an AI agent signing up through the keyless routes). */
  noAccount: boolean;
  mcpTool: string | null;
  /** describeRequest's plain words. */
  did: string;
  status: number;
  /** describeResponse's plain words. */
  result: string;
  at: Date;
}

const flat = (s: string) => s.replace(/[—–]/g, "-").replace(/\s+/g, " ").trim();

export function clip(s: string, max: number): string {
  const chars = [...flat(s)];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const who = (c: Pick<CallLine, "name" | "email">) => (c.name ? `${c.name} (${c.email})` : c.email);
const ok = (status: number) => status < 400;
const mark = (status: number) => (ok(status) ? "✅" : "❌");
const did = (c: Pick<CallLine, "mcpTool" | "did">) => (c.mcpTool ? `tool ${c.mcpTool} · ${c.did}` : c.did);
const hms = (d: Date) => d.toISOString().slice(11, 19);
const hm = (d: Date) => d.toISOString().slice(11, 16);

/** PURE: one call, one message. */
export function composeCallText(c: CallLine, threadUrl: string | null): string {
  const head = [`${CHANNEL_LABEL[c.channel]} call`, who(c)];
  if (c.orgName) head.push(c.orgName);
  if (c.noAccount) head.push("no account yet");
  const lines = [head.join(" · "), `Did: ${clip(did(c), DID_MAX)}`, `Result: ${mark(c.status)} ${clip(c.result, RESULT_MAX)}`];
  if (threadUrl) lines.push(`Thread: ${threadUrl}`);
  return lines.join("\n");
}

interface PersonGroup {
  email: string;
  name: string | null;
  orgNames: string[];
  calls: CallLine[];
}

function groupByPerson(calls: CallLine[]): PersonGroup[] {
  const byEmail = new Map<string, PersonGroup>();
  for (const c of [...calls].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.callId < b.callId ? -1 : 1))) {
    const g = byEmail.get(c.email) ?? { email: c.email, name: null, orgNames: [], calls: [] };
    g.name ??= c.name;
    if (c.orgName && !g.orgNames.includes(c.orgName)) g.orgNames.push(c.orgName);
    g.calls.push(c);
    byEmail.set(c.email, g);
  }
  // Most calls first, so a cut (huge bursts) keeps the biggest callers named.
  return [...byEmail.values()].sort((a, b) => b.calls.length - a.calls.length || (a.email < b.email ? -1 : 1));
}

const personHead = (g: PersonGroup) =>
  [who(g), ...g.orgNames].join(" · ") + `: ${g.calls.length} call${g.calls.length === 1 ? "" : "s"}`;

function header(calls: CallLine[], people: number, budgetPerMinute: number): string {
  const first = calls.reduce((m, c) => (c.at < m ? c.at : m), calls[0].at);
  const last = calls.reduce((m, c) => (c.at > m ? c.at : m), calls[0].at);
  const span = hm(first) === hm(last) ? `at ${hm(first)} UTC` : `from ${hm(first)} to ${hm(last)} UTC`;
  return `${calls.length} API / MCP calls by ${people} ${people === 1 ? "person" : "people"} ${span}, grouped (this chat gets at most ${budgetPerMinute} of these messages a minute)`;
}

function summaryLine(g: PersonGroup): string {
  const errors = g.calls.filter((c) => !ok(c.status));
  const byStatus = new Map<number, number>();
  for (const e of errors) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  const errText = errors.length === 0 ? "all ok" : `${g.calls.length - errors.length} ok, ${errors.length} errors (${[...byStatus].map(([s, n]) => `${s} x${n}`).join(", ")})`;
  const byAction = new Map<string, number>();
  for (const c of g.calls) {
    const k = clip(did(c), 60);
    byAction.set(k, (byAction.get(k) ?? 0) + 1);
  }
  const top = [...byAction].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} x${n}`).join("; ");
  return `${errText}. Top: ${top}`;
}

export interface GroupedText {
  text: string;
  mode: "grouped" | "summary";
}

/**
 * PURE: many calls in ONE Telegram message. Lists every call (time, channel, action, result) per person when that
 * fits; else one summary per person (counts, errors, top actions); people past the limit are counted, never dropped.
 */
export function composeGroupedText(calls: CallLine[], threadUrls: Map<string, string | null>, budgetPerMinute: number): GroupedText {
  if (calls.length === 0) throw new Error("composeGroupedText needs at least one call");
  const people = groupByPerson(calls);
  const head = header(calls, people.length, budgetPerMinute);

  const listed = [head];
  for (const g of people) {
    listed.push("", personHead(g));
    for (const c of g.calls) {
      listed.push(`${hms(c.at)} ${CHANNEL_LABEL[c.channel]} ${clip(did(c), GROUP_LINE_DID_MAX)} · ${mark(c.status)} ${c.status}`);
    }
    const url = threadUrls.get(g.email);
    if (url) listed.push(`Thread: ${url}`);
  }
  const full = listed.join("\n");
  if (full.length <= GROUPED_TEXT_MAX) return { text: full, mode: "grouped" };

  const out = [head];
  let used = head.length;
  for (const [i, g] of people.entries()) {
    const url = threadUrls.get(g.email);
    const block = ["", personHead(g), summaryLine(g), ...(url ? [`Thread: ${url}`] : [])].join("\n");
    const rest = people.slice(i);
    const restCalls = rest.reduce((n, p) => n + p.calls.length, 0);
    const tail = `\n\n+${rest.length} more ${rest.length === 1 ? "person" : "people"}, ${restCalls} calls`;
    // Keep room for the closing count of whoever does not fit.
    if (used + block.length + (i < people.length - 1 ? 80 : 0) > GROUPED_TEXT_MAX) {
      out.push(tail);
      return { text: out.join(""), mode: "summary" };
    }
    out.push(block);
    used += block.length;
  }
  return { text: out.join(""), mode: "summary" };
}

/** PURE: one message per call while that leaves a slot for a catch-up message, else ONE grouped message. */
export function planSend(pending: number, available: number): "none" | "lines" | "grouped" {
  if (pending === 0 || available <= 0) return "none";
  if (pending === 1 || pending <= available - 1) return "lines";
  return "grouped";
}

/** PURE: Telegram's « retry after N » in seconds, from the refusal text. */
export function telegramRetryAfterSeconds(error: string): number | null {
  const m = /retry after (\d+)/i.exec(error);
  return m ? Number(m[1]) : null;
}

// ─── TG-DAILY-DIGEST-1127: what stays live, the daily digest ─────────────────

/**
 * PURE: why a call still pings at once, or null (it waits for the daily digest). Live = an AI agent signing up (no
 * account yet), or an error (status >= 400) from an org that PAID us (billing-service's cash, read by the caller).
 */
export function liveReason(c: { noAccount: boolean; status: number }, orgPaying: boolean): "signup" | "paying_error" | null {
  if (c.noAccount) return "signup";
  if (c.status >= 400 && orgPaying) return "paying_error";
  return null;
}

/** The digest is sent at this UTC hour, for the previous UTC day. */
export const DIGEST_HOUR_UTC = 8;
/** A day missed (box down at 08:00) is still told this many days later; older ones are left. */
export const DIGEST_CATCH_UP_DAYS = 3;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/**
 * PURE: the UTC days whose digest is due now, oldest first: every day from `since` (the deploy day) on, whose next
 * day's DIGEST_HOUR_UTC has passed, within the catch-up window, not already told (`done`).
 */
export function digestDaysDue(now: Date, since: string | null, done: Set<string>): string[] {
  if (!since) return [];
  const today = dayOf(now);
  const latest = now.getUTCHours() >= DIGEST_HOUR_UTC ? addDays(today, -1) : addDays(today, -2);
  const out: string[] = [];
  for (let d = addDays(latest, -(DIGEST_CATCH_UP_DAYS - 1)); d <= latest; d = addDays(d, 1)) {
    if (d >= since && !done.has(d)) out.push(d);
  }
  return out;
}

export interface DigestCall {
  email: string;
  orgName: string | null;
  noAccount: boolean;
  /** describeRequest's plain words, WITHOUT the brand (so the same action adds up across brands). */
  did: string;
  status: number;
}

/** describeRequest's words for the identity read every MCP client makes when it connects. */
export const CONNECT_READ = "Asked who they are and what they can reach";

function personDigestLine(email: string, calls: DigestCall[]): string {
  const orgs = [...new Set(calls.map((c) => c.orgName).filter((o): o is string => !!o))];
  const head = [email, ...orgs, ...(calls.every((c) => c.noAccount) ? ["no account yet"] : [])].join(" · ");
  const parts = [`${calls.length} call${calls.length === 1 ? "" : "s"}`];
  const actions = new Map<string, number>();
  for (const c of calls) if (c.did !== CONNECT_READ) actions.set(clip(c.did, 60), (actions.get(clip(c.did, 60)) ?? 0) + 1);
  const errors = calls.filter((c) => c.status >= 400);
  if (actions.size === 0 && errors.length === 0) parts.push("connected only");
  const ranked = [...actions].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [k, n] of ranked.slice(0, 5)) parts.push(`${k} x${n}`);
  if (ranked.length > 5) parts.push(`${ranked.length - 5} other actions`);
  if (errors.length > 0) {
    const byStatus = new Map<number, number>();
    for (const e of errors) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
    const list = [...byStatus].sort((a, b) => a[0] - b[0]).map(([s, n]) => (n === 1 ? `${s}` : `${s} x${n}`)).join(", ");
    parts.push(`${errors.length} error${errors.length === 1 ? "" : "s"} (${list})`);
  }
  return `${head}: ${parts.join(", ")}`;
}

/**
 * PURE: the daily digest, or null when the day had no external call (nothing is sent). Grouped per person, most calls
 * first; each person keeps their Unibox thread link. Every call is counted. A long digest is split into several
 * Telegram messages by the sender, never cut.
 *
 *   API / MCP yesterday: 3 people, 11 calls
 *   jane@acme.com · Acme: 7 calls, Listed emails x4, Started a plan x1, 1 error (402)
 *   Thread: https://dashboard.distribute.you/...
 */
export function composeDigestText(calls: DigestCall[], threadUrls: Map<string, string | null>, dayLabel: string): string | null {
  if (calls.length === 0) return null;
  const byEmail = new Map<string, DigestCall[]>();
  for (const c of calls) byEmail.set(c.email, [...(byEmail.get(c.email) ?? []), c]);
  const people = [...byEmail].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const lines = [`API / MCP ${dayLabel}: ${people.length} ${people.length === 1 ? "person" : "people"}, ${calls.length} call${calls.length === 1 ? "" : "s"}`];
  for (const [email, own] of people) {
    lines.push(personDigestLine(email, own));
    const url = threadUrls.get(email);
    if (url) lines.push(`Thread: ${url}`);
  }
  return flatLines(lines.join("\n"));
}

/** "yesterday" for the day before `now`, else "on Nov 25". */
export function digestDayLabel(day: string, now: Date): string {
  if (day === addDays(dayOf(now), -1)) return "yesterday";
  const d = new Date(`${day}T00:00:00Z`);
  return `on ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

const flatLines = (s: string) => s.replace(/[—–]/g, "-");
