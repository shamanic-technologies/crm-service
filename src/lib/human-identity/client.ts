/**
 * human-service's fleet-wide human identity (`/internal/human-identities/*`):
 * the ONLY service deciding "same human?". crm-service states what its tools
 * say (keys given together = one contact; a person's judgment = an org-scoped
 * link; a do-not-contact mark = a fact on the human) and reads the answer.
 *
 * Service-auth (HUMAN_SERVICE_URL + HUMAN_SERVICE_API_KEY). Every call fails
 * loud with the status and human-service's own message; a connect-phase
 * failure (a container swap mid-deploy) is retried like a sibling read.
 */

import { isConnectError, SIBLING_CONNECT_RETRY_DELAYS_MS } from "../people/siblings.js";

export const HUMAN_SOURCE = "crm-service";
const TIMEOUT_MS = Number(process.env.HUMAN_SERVICE_TIMEOUT_MS) || 30_000;

export class HumanServiceError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "HumanServiceError";
    this.status = status;
  }
}

export function humanServiceConfigured(): boolean {
  return !!process.env.HUMAN_SERVICE_URL && !!process.env.HUMAN_SERVICE_API_KEY;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const url = process.env.HUMAN_SERVICE_URL?.replace(/\/+$/, "");
  const key = process.env.HUMAN_SERVICE_API_KEY;
  if (!url || !key) throw new HumanServiceError(null, "HUMAN_SERVICE_URL and HUMAN_SERVICE_API_KEY are required");
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, {
        method,
        headers: { "x-api-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (isConnectError(err) && attempt < SIBLING_CONNECT_RETRY_DELAYS_MS.length) {
        await sleep(SIBLING_CONNECT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new HumanServiceError(null, `human-service ${method} ${path} unreachable: ${(err as Error).message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new HumanServiceError(res.status, `human-service ${method} ${path} answered ${res.status} non-JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = (parsed as { error?: string } | null)?.error ?? text.slice(0, 200);
      throw new HumanServiceError(res.status, `human-service ${method} ${path} answered ${res.status}: ${msg}`);
    }
    return parsed as T;
  }
}

export interface ResolveAnswer {
  humanId: string | null;
  atomicHumanId: string | null;
  created: boolean;
  mergedHumanIds: string[];
  separatedHumanIds: string[];
}

/** Keys given together = ONE contact (proof: a shared email / phone merges fleet-wide). */
export function resolveHuman(args: {
  orgId: string;
  emails: string[];
  phones: string[];
  /** Weak keys (RELATIONSHIP-TAGS-1014): resolve / create, never auto-merge; an org judgment link merges them. */
  messagingHandles?: { network: string; id: string }[];
  create: boolean;
}): Promise<ResolveAnswer> {
  return call<ResolveAnswer>("POST", "/internal/human-identities/resolve", {
    orgId: args.orgId,
    ...(args.emails.length ? { emails: args.emails } : {}),
    ...(args.phones.length ? { phones: args.phones } : {}),
    ...(args.messagingHandles?.length ? { messagingHandles: args.messagingHandles } : {}),
    source: HUMAN_SOURCE,
    create: args.create,
  });
}

export interface HumanLink {
  linkId: string;
  relation: "same" | "distinct";
  scope: "fleet" | "org";
  orgId: string | null;
  humanIds: string[];
}

/** A JUDGMENT merge, held for `orgId` only (a fleet `same` is refused by design). */
export function stateSameHuman(args: {
  orgId: string;
  humanIds: [string, string];
  judgedBy: string;
  evidence: string;
}): Promise<{ changed: boolean; link: HumanLink | null; humanIds: string[] }> {
  return call("POST", "/internal/human-identities/links", {
    orgId: args.orgId,
    relation: "same",
    humanIds: args.humanIds,
    judgedBy: args.judgedBy,
    statedBy: HUMAN_SOURCE,
    evidence: args.evidence,
  });
}

export function withdrawHumanLink(args: { linkId: string; orgId: string; reason: string }): Promise<{ changed: boolean }> {
  return call("POST", `/internal/human-identities/links/${encodeURIComponent(args.linkId)}/withdraw`, {
    orgId: args.orgId,
    withdrawnBy: HUMAN_SOURCE,
    reason: args.reason,
  });
}

export function stateHumanFact(args: {
  humanId: string;
  kind: "opt_out" | "do_not_contact";
  orgId: string;
  evidence: string;
}): Promise<{ changed: boolean; fact: { factId: string; humanId: string } }> {
  return call("POST", `/internal/human-identities/${encodeURIComponent(args.humanId)}/facts`, {
    kind: args.kind,
    statedByOrgId: args.orgId,
    source: HUMAN_SOURCE,
    evidence: args.evidence,
  });
}

export function withdrawHumanFact(args: { factId: string; reason: string }): Promise<{ changed: boolean }> {
  return call("POST", `/internal/human-identities/facts/${encodeURIComponent(args.factId)}/withdraw`, {
    withdrawnBy: HUMAN_SOURCE,
    reason: args.reason,
  });
}

export interface HumanEvent {
  id: string;
  type: string;
  orgId: string | null;
  humanIds: string[];
  data: Record<string, unknown>;
}

export function readHumanEvents(after: number, limit = 1000): Promise<{ events: HumanEvent[]; nextCursor: string; hasMore: boolean }> {
  return call("GET", `/internal/human-identities/events?after=${after}&limit=${limit}`);
}
