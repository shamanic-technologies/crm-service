/**
 * Our API (and our MCP server) as a conversation SOURCE of the staff Unibox.
 *
 * A client who talks to us in person (WhatsApp, email), through the AI Copilot,
 * or through their own assistant calling our API / MCP server is having ONE
 * kind of exchange with us: a conversation (owner 2026-10-12). api-service
 * PUSHES every call made with a client's own key (`POST /internal/api-calls`);
 * this module stores it and serves it to the people layer as messages: the
 * client ASKED (inbound, "Listed emails for brand AscendQE"), we ANSWERED
 * (outbound, "Answered: 12 emails"), the raw request and response one read away
 * (`GET /orgs/people/api-calls/{callId}`).
 *
 * PRIVACY is structural, exactly like the Copilot source: the filing scope is
 * NOT in the request, it is the staff Unibox scope configured on the box
 * (`COPILOT_UNIBOX_ORG_ID` + `COPILOT_UNIBOX_BRAND_ID`), so a call never lands
 * in a customer org. Every other (org, brand) reads `not_connected`.
 *
 * Idempotent: one row per api-service call id.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiCalls, type ApiCall } from "../../db/schema.js";
import { normalizeEmail, type Presence } from "../people/identity.js";
import { copilotDestination, isCopilotDestination } from "../copilot/messages.js";

/** How our side is named on the thread. */
export const API_SENDER_NAME = "distribute.you API";
export const API_CALL_CHANNELS = ["api", "mcp"] as const;
export type ApiCallChannel = (typeof API_CALL_CHANNELS)[number];
/** A pause longer than this between two calls starts a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export class ApiCallDestinationMissingError extends Error {
  constructor() {
    super("COPILOT_UNIBOX_ORG_ID and COPILOT_UNIBOX_BRAND_ID must be set: the staff Unibox scope API calls are filed under");
  }
}

export interface ApiCallInput {
  callId: string;
  channel: ApiCallChannel;
  mcpTool?: string | null;
  orgId: string | null;
  userId: string;
  email: string;
  displayName?: string | null;
  keyFingerprint?: string | null;
  brandIds?: string[];
  method: string;
  path: string;
  query?: Record<string, unknown>;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  requestBodyBytes?: number;
  requestBodyTruncated?: boolean;
  status: number;
  responseContentType?: string | null;
  responseBody?: string | null;
  responseBodyBytes?: number;
  responseBodyTruncated?: boolean;
  durationMs: number;
  at: string;
  requestId?: string | null;
  runId?: string | null;
}

/** Postgres refuses NUL in text and jsonb. */
const stripNul = (s: string) => s.replace(/\u0000/g, "");
const nulFreeJson = <T>(v: T): T => JSON.parse(stripNul(JSON.stringify(v ?? {}))) as T;

/** Store a batch of calls under the staff scope. Calls without a usable email are skipped (counted). */
export async function storeApiCalls(
  calls: ApiCallInput[],
  runId: string | null,
): Promise<{ stored: number; duplicates: number; skippedNoEmail: number }> {
  const destination = copilotDestination();
  if (!destination) throw new ApiCallDestinationMissingError();
  let skippedNoEmail = 0;
  const rows = calls.flatMap((c) => {
    const email = normalizeEmail(c.email);
    if (!email) {
      skippedNoEmail += 1;
      return [];
    }
    return [
      {
        orgId: destination.orgId,
        brandId: destination.brandId,
        callId: c.callId,
        channel: c.channel,
        mcpTool: c.mcpTool ? stripNul(c.mcpTool) : null,
        callerOrgId: c.orgId,
        callerUserId: c.userId,
        email,
        displayName: c.displayName?.trim() ? stripNul(c.displayName.trim()) : null,
        keyFingerprint: c.keyFingerprint ?? null,
        brandIds: c.brandIds ?? [],
        method: c.method.toUpperCase(),
        path: stripNul(c.path),
        query: nulFreeJson(c.query ?? {}),
        requestHeaders: nulFreeJson(c.requestHeaders ?? {}),
        requestBody: c.requestBody == null ? null : stripNul(c.requestBody),
        requestBodyBytes: c.requestBodyBytes ?? 0,
        requestBodyTruncated: c.requestBodyTruncated ?? false,
        status: c.status,
        responseContentType: c.responseContentType ?? null,
        responseBody: c.responseBody == null ? null : stripNul(c.responseBody),
        responseBodyBytes: c.responseBodyBytes ?? 0,
        responseBodyTruncated: c.responseBodyTruncated ?? false,
        durationMs: Math.max(0, Math.round(c.durationMs)),
        calledAt: new Date(c.at),
        requestId: c.requestId ?? null,
        gatewayRunId: c.runId ?? null,
        runId,
      },
    ];
  });
  if (rows.length === 0) return { stored: 0, duplicates: 0, skippedNoEmail };
  const inserted = await db
    .insert(apiCalls)
    .values(rows)
    .onConflictDoNothing({ target: apiCalls.callId })
    .returning({ id: apiCalls.id });
  return { stored: inserted.length, duplicates: rows.length - inserted.length, skippedNoEmail };
}

// ─── reading ────────────────────────────────────────────────────────────────

/** PURE: one presence per calling address, from that address's stored calls. */
export function apiCallPresences(rows: Pick<ApiCall, "id" | "email" | "displayName" | "calledAt" | "channel" | "callerOrgId" | "callerUserId">[]): Presence[] {
  const byEmail = new Map<string, typeof rows>();
  for (const r of rows) byEmail.set(r.email, [...(byEmail.get(r.email) ?? []), r]);
  return [...byEmail.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([email, calls]) => {
      const sorted = [...calls].sort((a, b) => a.calledAt.getTime() - b.calledAt.getTime() || (a.id < b.id ? -1 : 1));
      const named = [...sorted].reverse().find((c) => c.displayName);
      const channels = [...new Set(sorted.map((c) => c.channel))].sort();
      return {
        source: "api" as const,
        sourceRef: email,
        displayName: named?.displayName ?? null,
        company: null,
        emails: [email],
        phones: [],
        firstActivityAt: sorted[0].calledAt.toISOString(),
        lastActivityAt: sorted[sorted.length - 1].calledAt.toISOString(),
        // Each call is two messages: what they asked, what we answered.
        messageCount: sorted.length * 2,
        inboundCount: sorted.length,
        outboundCount: sorted.length,
        detail: {
          channel: channels.length === 1 ? channels[0] : "api",
          channels,
          calls: sorted.length,
          callerOrgIds: [...new Set(sorted.map((c) => c.callerOrgId).filter((x): x is string => !!x))].sort(),
          callerUserIds: [...new Set(sorted.map((c) => c.callerUserId))].sort(),
        },
      };
    });
}

/** Columns the people list needs (never the bodies). */
const PRESENCE_COLUMNS = {
  id: apiCalls.id,
  email: apiCalls.email,
  displayName: apiCalls.displayName,
  calledAt: apiCalls.calledAt,
  channel: apiCalls.channel,
  callerOrgId: apiCalls.callerOrgId,
  callerUserId: apiCalls.callerUserId,
};

export async function readApiCallPresenceRows(orgId: string, brandId: string) {
  if (!isCopilotDestination(orgId, brandId)) return [];
  return db
    .select(PRESENCE_COLUMNS)
    .from(apiCalls)
    .where(and(eq(apiCalls.orgId, orgId), eq(apiCalls.brandId, brandId)));
}

/** Everything a thread item needs: the bodies only to summarise them, never served whole on the thread. */
export async function readApiCallThread(orgId: string, brandId: string, emails: string[]): Promise<ApiCall[]> {
  if (!isCopilotDestination(orgId, brandId) || emails.length === 0) return [];
  return db
    .select()
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.orgId, orgId),
        eq(apiCalls.brandId, brandId),
        inArray(apiCalls.email, emails.map((e) => e.toLowerCase())),
      ),
    )
    .orderBy(asc(apiCalls.calledAt), asc(apiCalls.id));
}

/** One call, whole (request and response as stored), in the staff scope only. */
export async function readApiCall(orgId: string, brandId: string, callId: string): Promise<ApiCall | null> {
  if (!isCopilotDestination(orgId, brandId)) return null;
  const [row] = await db
    .select()
    .from(apiCalls)
    .where(and(eq(apiCalls.orgId, orgId), eq(apiCalls.brandId, brandId), eq(apiCalls.callId, callId)))
    .limit(1);
  return row ?? null;
}

// ─── sessions (pure) ────────────────────────────────────────────────────────

/**
 * PURE: the session of each call, per channel: calls on one channel less than
 * SESSION_GAP_MS apart are one session, named by its first call's id.
 * Input sorted oldest first.
 */
export function sessionsOf(calls: Pick<ApiCall, "callId" | "channel" | "calledAt">[]): Map<string, string> {
  const out = new Map<string, string>();
  const last = new Map<string, { at: number; session: string }>();
  for (const c of calls) {
    const prev = last.get(c.channel);
    const at = c.calledAt.getTime();
    const session = prev && at - prev.at <= SESSION_GAP_MS ? prev.session : c.callId;
    out.set(c.callId, session);
    last.set(c.channel, { at, session });
  }
  return out;
}

// ─── human summaries (pure) ─────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that names one record rather than a kind of thing. */
export function isIdSegment(seg: string): boolean {
  return UUID.test(seg) || /^\d+$/.test(seg) || (seg.length >= 16 && /\d/.test(seg) && !/^[a-z]+(-[a-z]+)*$/.test(seg));
}

const words = (seg: string) => decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();

function singular(w: string): string {
  if (/ies$/.test(w)) return w.replace(/ies$/, "y");
  if (/(ss|us)$/.test(w)) return w;
  if (/(ches|shes|xes|ses)$/.test(w)) return w.replace(/es$/, "");
  return w.replace(/s$/, "");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * PURE: what the client asked, in plain words. "GET /v1/emails?brandId=…" →
 * "Listed emails for brand AscendQE". Built from the method and the path's
 * shape; the brand is named when the call named one and its name is known.
 */
export function describeRequest(
  call: Pick<ApiCall, "method" | "path" | "brandIds" | "mcpTool">,
  brandNames: Map<string, string> = new Map(),
): string {
  const segs = call.path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .filter((s, i) => !(i === 0 && /^v\d+$/.test(s)));
  const lastIdx = segs.length - 1;
  const last = segs[lastIdx] ?? "";
  const lastIsId = last ? isIdSegment(last) : false;
  // The kind of thing the call is about: the nearest non-id segment before an id, or the last one.
  const nouns = segs.filter((s) => !isIdSegment(s)).map(words);
  const resource = nouns[nouns.length - 1] ?? "the API";
  const parent = nouns.length > 1 ? nouns[nouns.length - 2] : null;
  const method = call.method.toUpperCase();

  let phrase: string;
  if (segs.length === 0) phrase = `Called the API root`;
  else if (segs.length === 1 && last === "me") phrase = "Asked who they are and what they can reach";
  else if (method === "GET") {
    phrase = lastIsId ? `Read ${singular(resource)} ${last.slice(0, 8)}` : parent && segs.some(isIdSegment) ? `Read the ${resource} of ${singular(parent)}` : `Listed ${resource}`;
  } else if (method === "DELETE") phrase = `Deleted ${singular(resource)}${lastIsId ? ` ${last.slice(0, 8)}` : ""}`;
  else if (method === "PATCH" || method === "PUT") phrase = `Updated ${singular(resource)}${lastIsId ? ` ${last.slice(0, 8)}` : ""}`;
  else if (method === "POST") {
    // POST /things → created a thing; POST /things/:id/action or /things/action → asked for the action.
    const prevIsId = segs.length >= 2 && isIdSegment(segs[lastIdx - 1]);
    if (lastIsId) phrase = `Sent ${singular(resource)} ${last.slice(0, 8)}`;
    else if (segs.length === 1) phrase = `Created ${singular(resource)}`;
    else if (prevIsId && parent) phrase = `Asked to ${resource} ${singular(parent)}`;
    else phrase = `Asked for ${nouns.join(" ")}`;
  } else phrase = `${method} ${nouns.join(" ")}`;

  const brands = (call.brandIds as string[] | null) ?? [];
  if (brands.length > 0) {
    const named = brands.map((id) => brandNames.get(id) ?? id.slice(0, 8));
    const list = named.length > 3 ? `${named.slice(0, 3).join(", ")} and ${named.length - 3} more` : named.join(", ");
    phrase += ` for brand${brands.length > 1 ? "s" : ""} ${list}`;
  }
  return capitalize(phrase);
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * PURE: what we answered, in plain words. "Answered: 12 emails", "Refused (403):
 * Not a member of this organization", "Failed (502): …". Counts are read off the
 * body: a list, or an object holding one list.
 */
export function describeResponse(
  call: Pick<ApiCall, "status" | "responseBody" | "responseBodyBytes" | "responseBodyTruncated" | "durationMs">,
): string {
  let body: unknown = undefined;
  if (call.responseBody && !call.responseBodyTruncated) {
    try {
      body = JSON.parse(call.responseBody);
    } catch {
      body = undefined;
    }
  }
  const timing = `${call.durationMs} ms`;
  if (call.status >= 400) {
    const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const reason = [o?.message, o?.error].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const said = reason ?? (typeof call.responseBody === "string" ? call.responseBody.slice(0, 200) : "");
    const verb = call.status >= 500 ? "Failed" : "Refused";
    return `${verb} (${call.status}): ${said.length > 240 ? `${said.slice(0, 240)}…` : said}`.trim();
  }
  let what: string | null = null;
  if (Array.isArray(body)) what = `${body.length} item${body.length === 1 ? "" : "s"}`;
  else if (body && typeof body === "object") {
    const lists = Object.entries(body as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
    if (lists.length === 1) {
      const [key, list] = lists[0] as [string, unknown[]];
      what = `${list.length} ${words(key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase())}`;
    }
  }
  const cut = call.responseBodyTruncated ? `, answer kept up to 256 KB of ${kb(call.responseBodyBytes)}` : "";
  return `Answered${what ? `: ${what}` : ""} (${call.status}, ${timing}${cut})`;
}
