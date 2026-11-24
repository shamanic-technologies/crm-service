/**
 * PURE: the owner's Telegram text for external API / MCP calls (TG-EVERY-CALL-1124, owner 2026-11-24, choice « B »:
 * one line per call, every call). Two shapes:
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
