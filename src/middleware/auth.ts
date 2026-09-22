import { Request, Response, NextFunction } from "express";
import { createRun, updateRun, RunsServiceError, IdentityHeaders } from "../lib/runs-client.js";

export const SERVICE_NAME = "crm-service";

/**
 * The API key that authenticates inbound service-to-service calls. Read at module
 * load so the process CRASHES AT BOOT if it is missing — auth is never silently
 * skipped.
 */
const CRM_SERVICE_API_KEY = process.env.CRM_SERVICE_API_KEY;
if (!CRM_SERVICE_API_KEY) {
  throw new Error("[crm-service] CRM_SERVICE_API_KEY is required — refusing to start without auth");
}

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  userId?: string;
  /** This service's own run id (forwarded downstream as x-run-id). */
  runId?: string;
  /** Inbound x-run-id from the caller. */
  parentRunId?: string;
  brandIds?: string[];
}

export function parseBrandIds(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A v4-shaped uuid. Anything else is not a brand id and is not attributed. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Attribute a brand to this request's run.
 *
 * The x-brand-id identity header is authoritative when present, but the
 * api-service gateway only ever promotes `brandId` to that header from a header
 * or a QUERY param — never from a request BODY and never from a path param. So
 * every crm-service route whose brand lives in the body (GoHighLevel / Matrix
 * connection create, serve-next) arrives with no brand at all.
 *
 * Rather than make each of those callers send an extra header (the consumer-side
 * patch that was already applied once, for the CSV upload, and which every route
 * added since has had to inherit), read the brand off the request the caller
 * already sends. `express.json()` runs app-wide before any router, so the parsed
 * body is available here. A multipart upload's body is NOT parsed yet (multer
 * runs inside the route), so that one keeps using its header.
 *
 * Attribution is best-effort: a route whose brand is only reachable via a path
 * param + a DB lookup gets no brand, and its run opens unattributed rather than
 * failing.
 */
export function resolveBrandIds(req: Request): string[] {
  const fromHeader = parseBrandIds(req.headers["x-brand-id"] as string | undefined);
  if (fromHeader.length) return fromHeader;

  const body = req.body as Record<string, unknown> | undefined;
  for (const candidate of [body?.brandId, req.query?.brandId]) {
    if (typeof candidate === "string" && UUID_RE.test(candidate)) return [candidate];
  }
  return [];
}

/** apiKeyAuth — validates x-api-key on every /public, /internal, /orgs request. */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers["x-api-key"] as string | undefined;
  if (!provided || provided !== CRM_SERVICE_API_KEY) {
    return res.status(401).json({ type: "auth", error: "Invalid or missing x-api-key" });
  }
  next();
}

function identityOf(req: AuthenticatedRequest): IdentityHeaders {
  return {
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
    brandIds: req.brandIds,
  };
}

/**
 * Create this service's own run and close it on response finish. Run tracking is
 * mandatory: a runs-service failure fails the request with 502.
 */
async function attachRun(
  req: AuthenticatedRequest,
  res: Response,
  taskName: string,
): Promise<boolean> {
  try {
    const run = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandIds: req.brandIds,
      serviceName: SERVICE_NAME,
      taskName,
      parentRunId: req.parentRunId,
    });
    req.runId = run.id;
  } catch (err) {
    if (err instanceof RunsServiceError) {
      res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${err.message}` });
      return false;
    }
    throw err;
  }

  res.on("finish", () => {
    const status = res.statusCode < 400 ? "completed" : "failed";
    updateRun(req.runId!, status, identityOf(req)).catch((e) =>
      console.error(`[crm-service] failed to close run ${req.runId}:`, e),
    );
  });

  return true;
}

/** requireOrgId + run tracking. taskName labels this service's run. */
export function requireOrg(taskName: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.headers["x-org-id"] as string | undefined;
    if (!orgId) {
      return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    }
    req.orgId = orgId;
    if (req.headers["x-user-id"]) req.userId = req.headers["x-user-id"] as string;
    req.parentRunId = (req.headers["x-run-id"] as string | undefined) ?? undefined;
    req.brandIds = resolveBrandIds(req);

    if (await attachRun(req, res, taskName)) next();
  };
}

/** requireOrgId AND x-user-id + run tracking (routes that call chat-service). */
export function requireOrgAndUser(taskName: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.headers["x-org-id"] as string | undefined;
    const userId = req.headers["x-user-id"] as string | undefined;
    if (!orgId) {
      return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    }
    if (!userId) {
      return res.status(400).json({ type: "validation", error: "x-user-id header required" });
    }
    req.orgId = orgId;
    req.userId = userId;
    req.parentRunId = (req.headers["x-run-id"] as string | undefined) ?? undefined;
    req.brandIds = resolveBrandIds(req);

    if (await attachRun(req, res, taskName)) next();
  };
}
