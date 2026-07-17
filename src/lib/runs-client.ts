/**
 * HTTP client for runs-service. Run tracking is mandatory: every authenticated
 * request creates its own run, and a failure to reach runs-service must fail the
 * request (502) — never continue without a run id.
 *
 * crm-service declares NO cost of its own. The only external/metered call is the
 * one column-typing completion routed through chat-service, which self-declares
 * its cost against the run id crm-service forwards. So this client only creates,
 * updates, and (for internal reprocess) platform-tracks runs — it never posts costs.
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";
const RUNS_SERVICE_TIMEOUT_MS = Number(process.env.RUNS_SERVICE_TIMEOUT_MS) || 10_000;

export class RunsServiceError extends Error {
  readonly kind: "timeout" | "network" | "http";
  readonly status?: number;
  readonly path: string;
  readonly method: string;
  readonly body?: string;
  constructor(args: {
    kind: "timeout" | "network" | "http";
    path: string;
    method: string;
    status?: number;
    body?: string;
    message: string;
  }) {
    super(args.message);
    this.name = "RunsServiceError";
    this.kind = args.kind;
    this.status = args.status;
    this.path = args.path;
    this.method = args.method;
    this.body = args.body;
  }
}

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string | null;
  userId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityHeaders {
  orgId?: string;
  userId?: string;
  runId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

async function runsRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    identity?: IdentityHeaders;
    serviceNameHeader?: string;
  } = {},
): Promise<T> {
  const { method = "GET", body, identity, serviceNameHeader } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
  };

  if (serviceNameHeader) headers["x-service-name"] = serviceNameHeader;
  if (identity?.orgId) headers["x-org-id"] = identity.orgId;
  if (identity?.userId) headers["x-user-id"] = identity.userId;
  if (identity?.runId) headers["x-run-id"] = identity.runId;
  if (identity?.brandIds?.length) headers["x-brand-id"] = identity.brandIds.join(",");
  if (identity?.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity?.audienceId) headers["x-audience-id"] = identity.audienceId;
  if (identity?.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity?.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNS_SERVICE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new RunsServiceError({
        kind: "timeout",
        path,
        method,
        message: `runs-service ${method} ${path} timed out after ${RUNS_SERVICE_TIMEOUT_MS}ms`,
      });
    }
    throw new RunsServiceError({
      kind: "network",
      path,
      method,
      message: `runs-service ${method} ${path} network error: ${(err as Error).message}`,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new RunsServiceError({
      kind: "http",
      path,
      method,
      status: response.status,
      body: errorText,
      message: `runs-service ${method} ${path} failed: ${response.status} - ${errorText}`,
    });
  }

  return response.json() as Promise<T>;
}

export interface CreateRunParams {
  orgId: string;
  userId?: string;
  brandIds?: string[];
  serviceName: string;
  taskName: string;
  parentRunId?: string;
}

/**
 * Create an org-scoped run. parentRunId is sent as x-run-id → becomes
 * parentRunId on the runs-service row.
 */
export async function createRun(params: CreateRunParams): Promise<Run> {
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    identity: {
      orgId: params.orgId,
      userId: params.userId,
      runId: params.parentRunId,
      brandIds: params.brandIds,
    },
    body: {
      brandIds: params.brandIds,
      serviceName: params.serviceName,
      taskName: params.taskName,
    },
  });
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityHeaders,
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    identity: { ...identity, runId },
    body: { status },
  });
}

/**
 * Create a platform-level run for org-less internal work (the /internal reprocess
 * endpoint). Requires x-service-name; no org balance gate.
 */
export async function createPlatformRun(params: {
  serviceName: string;
  taskName: string;
}): Promise<Run> {
  return runsRequest<Run>("/v1/platform-runs", {
    method: "POST",
    serviceNameHeader: params.serviceName,
    body: { serviceName: params.serviceName, taskName: params.taskName },
  });
}

export async function updatePlatformRun(
  runId: string,
  status: "completed" | "failed",
  serviceName: string,
): Promise<Run> {
  return runsRequest<Run>(`/v1/platform-runs/${runId}`, {
    method: "PATCH",
    serviceNameHeader: serviceName,
    body: { status },
  });
}
