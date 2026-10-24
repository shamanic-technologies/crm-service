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
 *
 * ⚠️ `brandIds` is OMITTED entirely when we have no brand, never sent as `[]`.
 * runs-service validates the body-level list as min-1-WHEN-PRESENT (and its own
 * schema marks it deprecated in favour of the x-brand-id header), so an empty
 * array is a 400 — `{"fieldErrors":{"brandIds":["Too small: expected array to
 * have >=1 items"]}}` — which fails run creation and therefore the whole
 * request, before the route handler ever runs. A legitimately brand-less
 * org-scoped request (a brand that lives in the BODY or in a path param, which
 * the gateway never promotes to the identity header) must still be able to open
 * its run.
 */
export async function createRun(params: CreateRunParams): Promise<Run> {
  const brandIds = params.brandIds?.length ? params.brandIds : undefined;
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    identity: {
      orgId: params.orgId,
      userId: params.userId,
      runId: params.parentRunId,
      brandIds,
    },
    body: {
      ...(brandIds ? { brandIds } : {}),
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

/** One outcome occurrence a run states (COST-ACCOUNTING-1023): a catalogue step reached by one subject. */
export interface OutcomeOccurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface DeclareOutcomesBody {
  produced?: OutcomeOccurrence[];
  consumed?: OutcomeOccurrence[];
  /**
   * BACKFILL (COST-BACKFILL-1023-RUNS): when the occurrences count as declared. `run_started_at` = the run's start;
   * absent = now (on time). runs-service keys consumption resolution, reuse rank and stored days on it.
   */
  occurredAt?: string;
}

export interface DeclareOutcomesAnswer {
  runId: string;
  recordedCount: number;
  alreadyRecordedCount: number;
}

/**
 * State on an ORG run the outcome occurrences it produced and consumed (runs-service, the
 * production-cost ledger). Idempotent there per (run, direction, key, subject): a replay answers
 * `alreadyRecordedCount`. x-org-id must be the run's org (else 409 `run_org_mismatch`).
 */
export async function declareRunOutcomes(runId: string, orgId: string, body: DeclareOutcomesBody): Promise<DeclareOutcomesAnswer> {
  return runsRequest<DeclareOutcomesAnswer>(`/v1/runs/${runId}/outcomes`, {
    method: "POST",
    identity: { orgId },
    body,
  });
}

/** One run of an org as `GET /v1/runs?include=subtreeCost` lists it. */
export interface ListedRun {
  id: string;
  serviceName: string;
  taskName: string;
  startedAt: string;
  totalCostInUsdCents?: string;
}

const LIST_RUNS_LIMIT = 500;

/**
 * An org's runs started in a window, each with the BILLED cost of its whole subtree (runs-service
 * `GET /v1/runs`, org-scoped by x-org-id). A full page is refused loud: the window must be read whole.
 */
export async function listOrgRuns(
  orgId: string,
  filter: { serviceName: string; taskName?: string; startedAfter: string; startedBefore: string },
): Promise<ListedRun[]> {
  const q = new URLSearchParams({ ...filter, include: "subtreeCost", limit: String(LIST_RUNS_LIMIT) } as Record<string, string>);
  const answer = await runsRequest<{ runs: ListedRun[] }>(`/v1/runs?${q}`, { identity: { orgId } });
  if (answer.runs.length >= LIST_RUNS_LIMIT) {
    throw new Error(`runs-service listed ${answer.runs.length} runs of org ${orgId} in ${filter.startedAfter}..${filter.startedBefore}: window not read whole`);
  }
  return answer.runs;
}

export interface BatchRunOutcomes {
  runId: string;
  produced?: OutcomeOccurrence[];
  consumed?: OutcomeOccurrence[];
  /** `run_started_at` or an ISO instant between the run's start and now (runs-service backfill semantics). */
  occurredAt?: string;
}

export interface BatchOutcomesAnswer {
  recordedCount: number;
  alreadyRecordedCount: number;
  runs: Array<{ runId: string; recordedCount: number; alreadyRecordedCount: number }>;
}

/** runs-service's per-run refusal of a batch (422 `invalid_runs`): nothing of the batch was written. */
export interface InvalidRun {
  runId: string;
  reason: string;
  message?: string;
}

/**
 * Declare the outcomes of up to 500 runs / 1000 occurrences in one call (runs-service
 * `POST /v1/platform-runs/outcomes/batch`, all or nothing, idempotent). A 422 names the invalid
 * runs (`invalidRunsOf`), nothing written.
 */
export async function declareOutcomesBatch(runs: BatchRunOutcomes[]): Promise<BatchOutcomesAnswer> {
  return runsRequest<BatchOutcomesAnswer>("/v1/platform-runs/outcomes/batch", {
    method: "POST",
    serviceNameHeader: "crm-service",
    body: { runs },
  });
}

/** PURE: the invalid runs a 422 `invalid_runs` answer names, or null when the error is something else. */
export function invalidRunsOf(err: unknown): InvalidRun[] | null {
  if (!(err instanceof RunsServiceError) || err.kind !== "http" || err.status !== 422 || !err.body) return null;
  try {
    const parsed = JSON.parse(err.body) as { error?: string; details?: { invalid?: InvalidRun[] } };
    return parsed.error === "invalid_runs" && Array.isArray(parsed.details?.invalid) ? parsed.details!.invalid! : null;
  } catch {
    return null;
  }
}
