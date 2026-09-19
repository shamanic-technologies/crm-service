/**
 * Resolving the customer's GoHighLevel credential — from key-service, never here.
 *
 * crm-service does NOT store this token. key-service is the fleet's credential
 * store and owns it, scoped to an (organisation, brand) pair, so one brand can
 * never be handed another brand's key. This module is the only place that
 * fetches it, it hands it straight to the client, and nothing persists it.
 *
 * The brand-scoped read has NO org-wide fallback and this module adds none: an
 * absent brand credential is a refusal, because falling back to the org's key
 * would connect a brand to whichever GoHighLevel account somebody configured
 * elsewhere. key-service serves that resolution at
 * `GET /keys/brands/{brandId}/{provider}/decrypt`, 404 when the brand has no
 * credential of its own.
 */

/** The provider name the credential is stored under in key-service. */
export const GHL_PROVIDER = "gohighlevel";

export class CredentialError extends Error {
  /** 'missing' — no credential for this brand. 'upstream' — key-service failed. */
  readonly kind: "missing" | "upstream";
  readonly status: number;

  constructor(kind: "missing" | "upstream", status: number, message: string) {
    super(message);
    this.name = "CredentialError";
    this.kind = kind;
    this.status = status;
  }
}

function keyServiceUrl(): string {
  const url = process.env.KEY_SERVICE_URL;
  if (!url) throw new Error("[crm-service] KEY_SERVICE_URL is required");
  return url.replace(/\/+$/, "");
}

function keyServiceApiKey(): string {
  const key = process.env.KEY_SERVICE_API_KEY;
  if (!key) throw new Error("[crm-service] KEY_SERVICE_API_KEY is required");
  return key;
}

export interface CredentialIdentity {
  orgId: string;
  /** The org user the read is attributed to. From the connection row in a cron. */
  userId: string;
  /** This service's run id, forwarded so key-service can trace the resolve. */
  runId?: string;
}

/**
 * The brand's GoHighLevel Private Integration Token.
 *
 * Fails loud in both directions: a 404 is a `missing` CredentialError (the
 * customer has not stored a token for this brand), anything else is `upstream`.
 * Neither is swallowed and neither falls back.
 */
export async function resolveGhlToken(
  brandId: string,
  identity: CredentialIdentity,
): Promise<string> {
  const path = `/keys/brands/${encodeURIComponent(brandId)}/${GHL_PROVIDER}/decrypt`;

  let res: Response;
  try {
    res = await fetch(`${keyServiceUrl()}${path}`, {
      method: "GET",
      headers: {
        "x-api-key": keyServiceApiKey(),
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        ...(identity.runId ? { "x-run-id": identity.runId } : {}),
        // key-service records which providers a caller needs from these.
        "X-Caller-Service": "crm-service",
        "X-Caller-Method": "GET",
        "X-Caller-Path": path,
      },
    });
  } catch (err) {
    throw new CredentialError(
      "upstream",
      502,
      `key-service unreachable: ${(err as Error).message}`,
    );
  }

  const body = await res.text();

  if (res.status === 404) {
    throw new CredentialError(
      "missing",
      400,
      `no GoHighLevel credential stored for brand ${brandId} — store it in key-service first`,
    );
  }
  if (!res.ok) {
    throw new CredentialError(
      "upstream",
      502,
      `key-service GET ${path} returned ${res.status}: ${body.slice(0, 300)}`,
    );
  }

  const parsed = JSON.parse(body) as { key?: unknown };
  if (typeof parsed.key !== "string" || parsed.key.length === 0) {
    throw new CredentialError(
      "upstream",
      502,
      `key-service returned no key for brand ${brandId}`,
    );
  }
  return parsed.key;
}
