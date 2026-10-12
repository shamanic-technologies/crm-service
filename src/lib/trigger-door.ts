/**
 * campaign-service's generic trigger door (`POST /internal/trigger-events`), the
 * ONE way crm-service tells campaign-service "this happened to this person":
 * a new CRM form fill (`form_submitted`, lib/form-trigger/) and a person
 * answering a thread a campaign opened on a personal channel
 * (`positive_reply_received`, lib/reply-trigger/). Nothing here is specific to
 * a trigger, a channel, a brand or a campaign.
 *
 * Every caller sends an `idempotencyKey` naming the occurrence itself, so a
 * retry (a timeout, a crash between the call and our write) returns
 * campaign-service's FIRST event (`replayed: true`) and nothing fires twice.
 */

const TIMEOUT_MS = Number(process.env.CAMPAIGN_SERVICE_TIMEOUT_MS) || 30_000;

export interface DoorIdentity {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
}

export interface RecordedOccurrence {
  eventId: string;
  recordedAt: Date | null;
  replayed: boolean;
  /** campaign-service's event as it answered it (status, outcome, skip reason...). */
  event: Record<string, unknown>;
}

/** campaign-service answered and refused: nothing was recorded there. */
export class CampaignRefusal extends Error {
  readonly status: number;
  readonly reason: string | null;
  constructor(status: number, reason: string | null, message: string) {
    super(message);
    this.name = "CampaignRefusal";
    this.status = status;
    this.reason = reason;
  }
}

/** A refusal campaign-service states as final (a bad body): never retried. */
export const FINAL_REFUSAL_STATUSES = new Set([400, 422]);

function env(): { url: string; key: string } {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const key = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url) throw new Error("CAMPAIGN_SERVICE_URL is required to report trigger occurrences");
  if (!key) throw new Error("CAMPAIGN_SERVICE_API_KEY is required to report trigger occurrences");
  return { url: url.replace(/\/+$/, ""), key };
}

export function campaignServiceConfigured(): boolean {
  return !!process.env.CAMPAIGN_SERVICE_URL && !!process.env.CAMPAIGN_SERVICE_API_KEY;
}

function headers(identity: DoorIdentity, key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
    "x-brand-id": identity.brandId,
  };
}

async function call(
  method: "GET" | "POST",
  path: string,
  identity: DoorIdentity,
  body?: unknown,
): Promise<{ status: number; ok: boolean; text: string; json: Record<string, unknown> }> {
  const { url, key } = env();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: headers(identity, key),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = (err as Error).name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : (err as Error).message;
    throw new Error(`campaign-service ${method} ${path.split("?")[0]} unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON: quoted by the caller.
  }
  return { status: res.status, ok: res.ok, text, json };
}

/**
 * Record one occurrence. Resolves with campaign-service's event; throws
 * `CampaignRefusal` on a 4xx (nothing recorded there), a plain Error on a 5xx /
 * unreachable (the caller retries: the idempotency key makes that safe).
 */
export async function recordTriggerEvent(identity: DoorIdentity, body: Record<string, unknown>): Promise<RecordedOccurrence> {
  const res = await call("POST", "/internal/trigger-events", identity, body);
  if (res.status >= 400 && res.status < 500) {
    throw new CampaignRefusal(
      res.status,
      typeof res.json.reason === "string" ? res.json.reason : null,
      `campaign-service refused the occurrence (${res.status}): ${res.text.slice(0, 300)}`,
    );
  }
  if (!res.ok) throw new Error(`campaign-service POST /internal/trigger-events returned ${res.status}: ${res.text.slice(0, 300)}`);
  const event = (res.json.event ?? {}) as Record<string, unknown>;
  const eventId = typeof event.id === "string" ? event.id : null;
  if (!eventId) throw new Error(`campaign-service answered ${res.status} with no event id: ${res.text.slice(0, 300)}`);
  // The event serves no creation stamp today: `processedAt` (when it fired) is
  // the closest campaign-service-side time; `createdAt` wins if it ever serves one.
  const stamp = typeof event.createdAt === "string" ? event.createdAt : event.processedAt;
  const created = typeof stamp === "string" ? new Date(stamp) : null;
  return {
    eventId,
    recordedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    replayed: res.json.replayed === true,
    event,
  };
}

/**
 * The offer a campaign states (`GET /campaigns/{id}`, scoped to the org). Null
 * when the campaign states none; throws when campaign-service cannot answer
 * (404 = not a campaign of this org: a `CampaignRefusal`).
 */
export async function readCampaignOffer(identity: DoorIdentity, campaignId: string): Promise<string | null> {
  const res = await call("GET", `/campaigns/${encodeURIComponent(campaignId)}`, identity);
  if (res.status >= 400 && res.status < 500) {
    throw new CampaignRefusal(res.status, null, `campaign-service GET /campaigns/${campaignId} answered ${res.status}: ${res.text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`campaign-service GET /campaigns/${campaignId} returned ${res.status}: ${res.text.slice(0, 300)}`);
  const campaign = (res.json.campaign ?? {}) as Record<string, unknown>;
  return typeof campaign.offerId === "string" && campaign.offerId ? campaign.offerId : null;
}
