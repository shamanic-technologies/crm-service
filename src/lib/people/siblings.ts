/**
 * Reads of the sibling services the person layer stands on: google-service
 * (Gmail), instantly-service (cold email + our own sending mailboxes),
 * lead-service (our leads' standing), brand-service (the brand's own domain) and
 * features-service (each of our leads' family: won / hot / lost / cold).
 *
 * READ-ONLY by construction: this module only issues GETs. The person layer
 * never writes to a sibling, and through it to no outside tool.
 *
 * Each call carries the org's identity and this service's run id, so the
 * sibling attributes the read. A sibling answer is returned with its status so
 * the caller can keep "not connected" (a documented 404), "nothing" and
 * "failed" apart; nothing here turns a failure into an empty list.
 */

export type Sibling = "google" | "instantly" | "lead" | "brand" | "features";

const ENV: Record<Sibling, { url: string; key: string }> = {
  google: { url: "GOOGLE_SERVICE_URL", key: "GOOGLE_SERVICE_API_KEY" },
  instantly: { url: "INSTANTLY_SERVICE_URL", key: "INSTANTLY_SERVICE_API_KEY" },
  lead: { url: "LEAD_SERVICE_URL", key: "LEAD_SERVICE_API_KEY" },
  brand: { url: "BRAND_SERVICE_URL", key: "BRAND_SERVICE_API_KEY" },
  features: { url: "FEATURES_SERVICE_URL", key: "FEATURES_SERVICE_API_KEY" },
};

export const SIBLING_TIMEOUT_MS = Number(process.env.PEOPLE_SIBLING_TIMEOUT_MS) || 30_000;

/**
 * Waits before each retry of a CONNECT-phase failure. A sibling's container swap
 * on deploy refuses connections for ~2s (features-service, 2026-10-08: 8 owner
 * family filters failed in 2s), so the budget (~3.75s) outlasts that window.
 */
export const SIBLING_CONNECT_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/**
 * PURE: the error is a connection that never got an answer (refused / reset /
 * connect timeout), found by walking `cause` and `AggregateError.errors`. Our
 * own abort (the sibling answered nothing within SIBLING_TIMEOUT_MS) is NOT one:
 * a genuine timeout stays loud.
 */
export function isConnectError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (e: unknown): boolean => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const o = e as { name?: string; code?: string; cause?: unknown; errors?: unknown[] };
    if (o.name === "AbortError") return false;
    if (o.code && CONNECT_CODES.has(o.code)) return true;
    if (Array.isArray(o.errors) && o.errors.some(walk)) return true;
    return walk(o.cause);
  };
  return walk(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SiblingIdentity {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
}

export interface SiblingResponse {
  status: number;
  body: unknown;
}

export class SiblingError extends Error {
  readonly sibling: Sibling;
  readonly path: string;
  readonly status: number | null;
  constructor(sibling: Sibling, path: string, status: number | null, message: string) {
    super(message);
    this.name = "SiblingError";
    this.sibling = sibling;
    this.path = path;
    this.status = status;
  }
}

function envOf(sibling: Sibling): { url: string; key: string } {
  const url = process.env[ENV[sibling].url];
  const key = process.env[ENV[sibling].key];
  if (!url) throw new SiblingError(sibling, "", null, `${ENV[sibling].url} is required`);
  if (!key) throw new SiblingError(sibling, "", null, `${ENV[sibling].key} is required`);
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * GET a sibling route. Resolves with ANY HTTP status (the caller decides which
 * statuses are documented answers); rejects only when the sibling could not be
 * reached or did not answer JSON. A connect-phase failure (refused / reset) is
 * retried on SIBLING_CONNECT_RETRY_DELAYS_MS; an answered 4xx/5xx never is.
 */
export async function siblingGet(
  sibling: Sibling,
  path: string,
  identity: SiblingIdentity,
): Promise<SiblingResponse> {
  const { url, key } = envOf(sibling);
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIBLING_TIMEOUT_MS);
    try {
      res = await fetch(`${url}${path}`, {
        method: "GET",
        headers: {
          "x-api-key": key,
          "x-org-id": identity.orgId,
          "x-user-id": identity.userId,
          "x-run-id": identity.runId,
          "x-brand-id": identity.brandId,
        },
        signal: controller.signal,
      });
      break;
    } catch (err) {
      // A GET is idempotent, and a refused / reset connection is a sibling
      // mid-deploy: ask again a moment later. Anything else (our timeout, a
      // bad URL) and an exhausted budget fail loud as before.
      if (isConnectError(err) && attempt < SIBLING_CONNECT_RETRY_DELAYS_MS.length) {
        await sleep(SIBLING_CONNECT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const reason =
        (err as Error).name === "AbortError" ? `timed out after ${SIBLING_TIMEOUT_MS}ms` : (err as Error).message;
      const tries = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
      throw new SiblingError(sibling, path, null, `${sibling}-service GET ${path} unreachable${tries}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    throw new SiblingError(
      sibling,
      path,
      res.status,
      `${sibling}-service GET ${path} answered ${res.status} with non-JSON: ${text.slice(0, 200)}`,
    );
  }
  return { status: res.status, body };
}

/** GET that must succeed (2xx); any other status is a SiblingError. */
export async function siblingGetOk<T>(
  sibling: Sibling,
  path: string,
  identity: SiblingIdentity,
): Promise<T> {
  const r = await siblingGet(sibling, path, identity);
  if (r.status < 200 || r.status >= 300) {
    throw new SiblingError(
      sibling,
      path,
      r.status,
      `${sibling}-service GET ${path} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
    );
  }
  return r.body as T;
}

/** Map over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
