/**
 * Is this org a PAYING client? (TG-DAILY-DIGEST-1127: a paying client's API / MCP error still pings the owner live.)
 * billing-service owns the answer: `GET /internal/accounts/by-org/:orgId/cash` (owner rule « revenue is cash the
 * client paid; a granted or advanced credit being consumed is never revenue »): paying = `cash_paid_cents > 0`.
 * Never guessed: an unreadable answer throws, the caller decides what to do with the call.
 */

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; paying: boolean }>();

export async function isPayingOrg(orgId: string): Promise<boolean> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.paying;
  const url = process.env.BILLING_SERVICE_URL?.replace(/\/+$/, "");
  const key = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !key) throw new Error("BILLING_SERVICE_URL / BILLING_SERVICE_API_KEY not set: cannot tell a paying client");
  const res = await fetch(`${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}/cash`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`billing-service GET /internal/accounts/by-org/${orgId}/cash answered ${res.status}`);
  const body = (await res.json()) as { cash_paid_cents?: unknown };
  if (typeof body.cash_paid_cents !== "number") throw new Error(`billing-service cash for org ${orgId} carries no cash_paid_cents`);
  const paying = body.cash_paid_cents > 0;
  cache.set(orgId, { at: Date.now(), paying });
  return paying;
}

/** Tests only. */
export function resetPayingCache(): void {
  cache.clear();
}
