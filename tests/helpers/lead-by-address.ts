/**
 * lead-service's by-address read (`POST /internal/brands/{brandId}/leads/by-address`) answering
 * "no lead" for every address asked: the stub for suites whose brand has no lead at lead-service.
 */
export function noLeadsByAddress(init?: RequestInit): Response {
  const emails = (JSON.parse(String(init?.body)) as { emails: string[] }).emails.map((e) => e.trim().toLowerCase());
  const addresses = [...new Set(emails)].map((email) => ({ email, leads: [] }));
  return new Response(JSON.stringify({ brandId: null, addresses, count: addresses.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
