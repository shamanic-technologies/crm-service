/**
 * GoHighLevel v2 API client — READ ONLY.
 *
 * There is no write path in this module, by design, exactly as for the Matrix
 * source: the customer's CRM is mirrored, never edited. Do not add one.
 *
 * Authentication is a Private Integration Token — a static bearer the customer
 * generates in their own GoHighLevel settings. It does not expire and does not
 * refresh, and GoHighLevel publishes no way to read the target sub-account
 * ("location") out of it, so the customer supplies the location id alongside the
 * token (verified against the v2 docs, 2026-09-19:
 * marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken).
 *
 * Every request carries `Version: 2021-07-28` — GoHighLevel selects its API
 * version per request via that header, and omitting it is an error.
 */

export const GHL_API_BASE_URL = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";

/** Per-request ceiling. The sync runs from a cron, so it never long-polls. */
const REQUEST_TIMEOUT_MS = Number(process.env.GOHIGHLEVEL_TIMEOUT_MS) || 20_000;

/** GoHighLevel caps a page at 100 records on both endpoints we read. */
export const PAGE_SIZE = 100;

/** Hard ceiling on pages drained per resource in one pass — a cron re-runs. */
const MAX_PAGES = Number(process.env.GOHIGHLEVEL_MAX_PAGES) || 200;

/**
 * A non-2xx answer from GoHighLevel, carrying the VENDOR's own status and
 * message. Connect-time refusal quotes these verbatim rather than flattening
 * them into a generic error — the customer needs GoHighLevel's reason, not ours.
 */
export class GoHighLevelError extends Error {
  readonly status: number;
  readonly vendorMessage: string;
  readonly path: string;

  constructor(args: { status: number; vendorMessage: string; path: string }) {
    super(`GoHighLevel ${args.path} returned ${args.status}: ${args.vendorMessage}`);
    this.name = "GoHighLevelError";
    this.status = args.status;
    this.vendorMessage = args.vendorMessage;
    this.path = args.path;
  }
}

/** GoHighLevel reports errors as `{ message }`, sometimes an array of strings. */
function readVendorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const raw = parsed.message ?? parsed.error;
    if (Array.isArray(raw)) return raw.map(String).join("; ");
    if (typeof raw === "string" && raw.trim()) return raw;
  } catch {
    // Not JSON — fall through to the raw body, which is still the vendor's words.
  }
  return body.trim() || "(no message)";
}

async function ghlGet<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const url = `${GHL_API_BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_API_VERSION,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new GoHighLevelError({
        status: res.status,
        vendorMessage: readVendorMessage(body),
        path,
      });
    }
    return JSON.parse(body) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][ghl] GET ${path} aborted after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface GhlContact {
  id: string;
  [key: string]: unknown;
}

export interface GhlOpportunityRecord {
  id: string;
  [key: string]: unknown;
}

export interface GhlPipelineRecord {
  id: string;
  name?: string;
  stages?: unknown;
  [key: string]: unknown;
}

/**
 * Prove the credential works AND targets the stated sub-account, in one call.
 *
 * `GET /contacts/` is deliberately the probe rather than `GET /locations/{id}`:
 * it exercises the exact scope the sync needs (`contacts.readonly`), so a token
 * that passes here can actually do the job, and a token bound to a DIFFERENT
 * location is refused by GoHighLevel with its own message.
 *
 * Throws GoHighLevelError on refusal — the caller surfaces the vendor's reason.
 */
export async function verifyAccess(token: string, locationId: string): Promise<void> {
  await ghlGet<{ contacts?: unknown[] }>(token, "/contacts/", {
    locationId,
    limit: "1",
  });
}

/**
 * Every contact of a sub-account.
 *
 * GoHighLevel paginates with a (startAfter, startAfterId) cursor pair echoed
 * back in `meta`. The loop stops when a page is empty or the cursor stops
 * moving — never on a page count alone, which would silently truncate the mirror.
 */
export async function* listContacts(
  token: string,
  locationId: string,
): AsyncGenerator<GhlContact[]> {
  let startAfter: string | undefined;
  let startAfterId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { locationId, limit: String(PAGE_SIZE) };
    if (startAfter !== undefined) params.startAfter = startAfter;
    if (startAfterId !== undefined) params.startAfterId = startAfterId;

    const body = await ghlGet<{
      contacts?: GhlContact[];
      meta?: { startAfter?: number | string; startAfterId?: string };
    }>(token, "/contacts/", params);

    const contacts = (body.contacts ?? []).filter((c) => c && typeof c.id === "string");
    if (contacts.length === 0) return;
    yield contacts;

    const nextAfter = body.meta?.startAfter;
    const nextAfterId = body.meta?.startAfterId;
    if (nextAfterId === undefined || nextAfterId === startAfterId) return;
    startAfter = nextAfter === undefined ? undefined : String(nextAfter);
    startAfterId = nextAfterId;
  }
}

/**
 * Every opportunity of a sub-account, across every pipeline and status.
 *
 * `status=all` is explicit: the default is open-only, and a pipeline read that
 * silently dropped won and lost deals would not match what the customer sees.
 */
export async function* listOpportunities(
  token: string,
  locationId: string,
): AsyncGenerator<GhlOpportunityRecord[]> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await ghlGet<{
      opportunities?: GhlOpportunityRecord[];
      meta?: { nextPageUrl?: string | null };
    }>(token, "/opportunities/search", {
      location_id: locationId,
      limit: String(PAGE_SIZE),
      page: String(page),
      status: "all",
    });

    const opportunities = (body.opportunities ?? []).filter(
      (o) => o && typeof o.id === "string",
    );
    if (opportunities.length === 0) return;
    yield opportunities;

    if (!body.meta?.nextPageUrl) return;
  }
}

/** The sub-account's pipelines, each with its ordered stages. One page, no cursor. */
export async function listPipelines(
  token: string,
  locationId: string,
): Promise<GhlPipelineRecord[]> {
  const body = await ghlGet<{ pipelines?: GhlPipelineRecord[] }>(
    token,
    "/opportunities/pipelines",
    { locationId },
  );
  return (body.pipelines ?? []).filter((p) => p && typeof p.id === "string");
}
