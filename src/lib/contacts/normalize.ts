/**
 * Deterministic normalizers for the structured contact fields a CSV column or a contact
 * added one by one can state (CRM-ADD-ONE-CONTACT-1021). No model, no network.
 */

/** A bare lowercased host ("ntt.com") from a domain, a URL or an email-like "x@ntt.com"; null when none. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = String(raw).trim().toLowerCase();
  if (v === "") return null;
  if (v.includes("@") && !v.includes("/")) v = v.split("@").pop() ?? "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/**
 * A LinkedIn profile URL in ONE spelling (`https://www.linkedin.com/in/<slug>`), so the same
 * person stated twice (with or without `www.`, a trailing slash, a query, a country subdomain)
 * is one key. A non-profile LinkedIn URL (a company page) keeps its path, lowercased.
 * Null when it is no LinkedIn URL.
 */
export function normalizeLinkedinUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = String(raw).trim();
  if (v === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length === 0) return null;
  const path = parts[0].toLowerCase() === "in" && parts[1] ? `in/${parts[1].toLowerCase()}` : parts.join("/").toLowerCase();
  return `https://www.linkedin.com/${path}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  return v === "" ? null : v;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, "");
  return cleaned === "" || cleaned === "+" ? null : cleaned;
}

/** Trimmed text, null when empty. */
export function cleanText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  return v === "" ? null : v;
}
