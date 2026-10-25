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
  /**
   * LEDGER-HISTORY-1024: this run serves a SUPPORT function (spend that produces no outcome by design), marked at
   * creation at runs-service: its cost and its non-declaring subtree's never ride an outcome. Never on a run that
   * declares a produced outcome (runs-service 409 `run_marked_support`).
   */
  support?: { kind: SupportFunction; reason: string };
}

/** runs-service's support functions (doctrine: agent-config skill `cost-accounting`). */
export type SupportFunction =
  | "payment_fees"
  | "brand_setup"
  | "copilot"
  | "platform_llm"
  | "staff_experiment"
  | "product_feature"
  | "retired_product";

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
      ...(params.support ? { support: params.support } : {}),
    },
  });
}

/**
 * A child run opened on first use (`runId()`), closed by the caller (`close`). Used to keep one kind of spend on a run
 * of its own: the reply judging (what positive replies are declared on), or a support function marked at creation.
 */
export function lazyChildRun(
  parent: () => Promise<string>,
  ids: { orgId: string; userId: string; brandId: string },
  task: { serviceName: string; taskName: string; support?: CreateRunParams["support"] },
) {
  let created: Promise<string> | null = null;
  return {
    runId: () =>
      (created ??= parent().then((parentRunId) =>
        createRun({ orgId: ids.orgId, userId: ids.userId, brandIds: [ids.brandId], ...task, parentRunId }).then((r) => r.id),
      )),
    /** The run id once opened (null when nothing asked for it). */
    async opened(): Promise<string | null> {
      return created ? created.catch(() => null) : null;
    },
    async close(failed: boolean): Promise<void> {
      if (!created) return;
      const id = await created.catch(() => null);
      if (!id) return;
      await updateRun(id, failed ? "failed" : "completed", { orgId: ids.orgId, userId: ids.userId }).catch((e) =>
        console.error(`[crm-service] failed to close ${task.taskName} run ${id}:`, e),
      );
    },
  };
}

/** The support functions crm-service's own spend serves, each on a child run marked at creation (LEDGER-HISTORY-1024). */
export const SUPPORT_RUNS = {
  /** The Matrix thread reading (status, next step, summary on the Unibox lead card): a product feature. */
  leadReading: { serviceName: "crm-service", taskName: "matrix.lead-reading", support: { kind: "product_feature", reason: "Unibox lead card: reading a mirrored thread into status, next step and summary" } },
  /** A brand's own CRM vocabulary (GoHighLevel stage meanings, client / disqualified labels): a product feature. */
  crmLabels: { serviceName: "crm-service", taskName: "gohighlevel.label-meanings", support: { kind: "product_feature", reason: "Reading the brand's own CRM stage and tag meanings" } },
  /** Typing the columns of a CRM file the client uploaded: a product feature. */
  columnTyping: { serviceName: "crm-service", taskName: "contacts.column-typing", support: { kind: "product_feature", reason: "Typing the columns of an uploaded CRM file" } },
  /** Which person a calendar attendee / Meet participant is: a product feature (the meeting is the lead's act, not ours). */
  calendarMatching: { serviceName: "crm-service", taskName: "calendar.judge", support: { kind: "product_feature", reason: "Matching calendar attendees and Meet participants to the brand's people" } },
  /** Voice notes received on the Copilot's own line: the Copilot. */
  copilotVoice: { serviceName: "crm-service", taskName: "copilot.voice-notes", support: { kind: "copilot", reason: "Transcribing voice notes the Copilot reads" } },
  /**
   * LEDGER-RESIDUAL-1025: re-reading the brand's mail threads into the Unibox store and search index (google-service cleans
   * each message body with Jev on the way). The freshness watch's whole run, and the message index step of a people build.
   */
  mailboxRefresh: { serviceName: "crm-service", taskName: "people.freshness", support: { kind: "product_feature", reason: "Unibox store: re-reading the brand's mail threads that moved" } },
  messageIndex: { serviceName: "crm-service", taskName: "people.message-index", support: { kind: "product_feature", reason: "Unibox search index: re-reading the brand's mail and cold-email threads after a people build" } },
  /** A person's thread opened in the Unibox with no caller run (the dashboard): a product feature. Read under a caller's run, it rides that run. */
  timelineRead: { serviceName: "crm-service", taskName: "people.timeline", support: { kind: "product_feature", reason: "Unibox thread read: a person's timeline opened with no caller run" } },
} as const satisfies Record<string, { serviceName: string; taskName: string; support: NonNullable<CreateRunParams["support"]> }>;

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

/** The support-mark selection answer (runs-service owner door, preview and apply). */
export interface SupportMarkAnswer {
  matchedRunCount: number;
  toMarkCount: number;
  alreadyMarkedCount: number;
  declaresOutcomesCount: number;
  onOutcomeNowCount: number | null;
  spend: { grossCents: string; netCents: string };
  tooMany: boolean;
  [k: string]: unknown;
}

/**
 * Mark crm-service's OWN past runs support, naming the function (runs-service owner door
 * `/v1/platform-runs/support-marks/{preview|apply}`, all or nothing, idempotent: a marked run keeps its first function;
 * a run that declared an outcome is never marked). New runs are marked at creation instead (`support` on createRun).
 */
export async function markOwnRunsSupport(
  step: "preview" | "apply",
  body: {
    kind: SupportFunction;
    reason: string;
    markedBy: string;
    /** Runs to mark, or a selection over the caller's own runs (exclusive at runs-service). */
    runIds?: string[];
    taskNames?: string[];
    topLevelOnly?: boolean;
    withSpendOnly?: boolean;
    startedAfter?: string;
    startedBefore?: string;
    offOutcomeOnly?: boolean;
    offAncestorMarkOnly?: boolean;
  },
): Promise<SupportMarkAnswer> {
  return runsRequest<SupportMarkAnswer>(`/v1/platform-runs/support-marks/${step}`, {
    method: "POST",
    serviceNameHeader: "crm-service",
    body,
  });
}
