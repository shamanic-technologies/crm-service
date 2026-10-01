/**
 * Reads of the sibling services the person layer stands on: google-service
 * (Gmail), instantly-service (cold email) and lead-service (our leads' standing).
 *
 * READ-ONLY by construction: this module only issues GETs. The person layer
 * never writes to a sibling, and through it to no outside tool.
 *
 * Each call carries the org's identity and this service's run id, so the
 * sibling attributes the read. A sibling answer is returned with its status so
 * the caller can keep "not connected" (a documented 404), "nothing" and
 * "failed" apart; nothing here turns a failure into an empty list.
 */

export type Sibling = "google" | "instantly" | "lead";

const ENV: Record<Sibling, { url: string; key: string }> = {
  google: { url: "GOOGLE_SERVICE_URL", key: "GOOGLE_SERVICE_API_KEY" },
  instantly: { url: "INSTANTLY_SERVICE_URL", key: "INSTANTLY_SERVICE_API_KEY" },
  lead: { url: "LEAD_SERVICE_URL", key: "LEAD_SERVICE_API_KEY" },
};

export const SIBLING_TIMEOUT_MS = Number(process.env.PEOPLE_SIBLING_TIMEOUT_MS) || 30_000;

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
 * reached or did not answer JSON.
 */
export async function siblingGet(
  sibling: Sibling,
  path: string,
  identity: SiblingIdentity,
): Promise<SiblingResponse> {
  const { url, key } = envOf(sibling);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIBLING_TIMEOUT_MS);
  let res: Response;
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
  } catch (err) {
    const reason =
      (err as Error).name === "AbortError" ? `timed out after ${SIBLING_TIMEOUT_MS}ms` : (err as Error).message;
    throw new SiblingError(sibling, path, null, `${sibling}-service GET ${path} unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
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
