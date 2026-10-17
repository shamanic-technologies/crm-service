/**
 * brand-service's COMPANY identity (`POST /internal/companies/resolve`): a company is a brand row like
 * any other (same domain = same brand id), nobody's client (owner 2026-10-13, LEAD-REFONTE-1013).
 * crm-service never mints a company id: it states what its tools say (a work email's domain, a CRM
 * contact's website) and attaches the id brand-service answers (PERSON-ORGANIZATIONS-1017).
 *
 * Contract (deployed, verified 2026-10-17): body `{companies: [{ref?, domain?, linkedinUrl?,
 * apolloOrganizationId?, name?}]}` (1..1000) -> `{companies: [{index, ref, brandId|null, domain,
 * matchedBy, created, unresolvedReason}]}`. A NAME is never an identity. Free (no scrape, no model).
 * Service auth, no org. Fails loud; a connect-phase failure (container swap) is retried.
 */
import { isConnectError, SIBLING_CONNECT_RETRY_DELAYS_MS } from "../people/siblings.js";

export const MAX_COMPANIES_PER_RESOLVE = 1000;
const TIMEOUT_MS = 60_000;

export interface CompanyResolution {
  index: number;
  ref: string | null;
  brandId: string | null;
  domain: string | null;
  matchedBy: "domain" | "linkedin_company" | "apollo_organization" | null;
  created: boolean;
  unresolvedReason: "no_safe_identity" | "invalid_domain" | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolveCompanies(companies: { ref: string; domain: string }[]): Promise<CompanyResolution[]> {
  if (companies.length === 0) return [];
  if (companies.length > MAX_COMPANIES_PER_RESOLVE) {
    throw new Error(`[crm-service][companies] ${companies.length} companies in one call; brand-service takes ${MAX_COMPANIES_PER_RESOLVE}`);
  }
  const url = process.env.BRAND_SERVICE_URL?.replace(/\/+$/, "");
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) throw new Error("BRAND_SERVICE_URL and BRAND_SERVICE_API_KEY are required");
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${url}/internal/companies/resolve`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ companies }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (isConnectError(err) && attempt < SIBLING_CONNECT_RETRY_DELAYS_MS.length) {
        await sleep(SIBLING_CONNECT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(`brand-service POST /internal/companies/resolve unreachable: ${(err as Error).message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`brand-service POST /internal/companies/resolve answered ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { companies?: CompanyResolution[] };
    if (!Array.isArray(body.companies) || body.companies.length !== companies.length) {
      throw new Error(`brand-service resolve answered ${body.companies?.length ?? "no"} results for ${companies.length} companies`);
    }
    return body.companies;
  }
}
