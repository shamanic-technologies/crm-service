/**
 * Matrix client-server API client — READ ONLY.
 *
 * crm-service CONSUMES a homeserver (conduwuit + mautrix bridges) that runs
 * outside this repo. It never builds, configures or deploys it, and it NEVER
 * writes a message back: there is no send path in this module, by design. That
 * is what makes the Discord channel read-only.
 *
 * The only call is `GET /_matrix/client/v3/sync` with a `since` cursor.
 */

export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  content?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MatrixJoinedRoom {
  timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
  state?: { events?: MatrixEvent[] };
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: { join?: Record<string, MatrixJoinedRoom> };
}

const SYNC_TIMEOUT_MS = Number(process.env.MATRIX_SYNC_TIMEOUT_MS) || 30_000;

/** How many timeline events a single /sync page may carry. */
export const SYNC_TIMELINE_LIMIT = 200;

function homeserverUrl(): string {
  const url = process.env.MATRIX_HOMESERVER_URL;
  if (!url) throw new Error("[crm-service] MATRIX_HOMESERVER_URL is required");
  return url.replace(/\/+$/, "");
}

function accessToken(): string {
  const token = process.env.MATRIX_ACCESS_TOKEN;
  if (!token) throw new Error("[crm-service] MATRIX_ACCESS_TOKEN is required");
  return token;
}

/**
 * Only the two event types this service reads are requested: messages (the
 * conversation itself) and member state (who the counterpart is). Everything
 * else the bridges emit is noise for our purposes and is not mirrored.
 */
const SYNC_FILTER = JSON.stringify({
  room: {
    timeline: { limit: SYNC_TIMELINE_LIMIT, types: ["m.room.message", "m.room.member"] },
    state: { types: ["m.room.member"] },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
});

/**
 * One `/sync` page. `since` omitted = initial sync (full room state).
 * `timeout=0` — this is a polling consumer driven by a cron, never a long-poll.
 *
 * Fails loud: any non-2xx or transport error throws.
 */
export async function sync(since: string | null): Promise<MatrixSyncResponse> {
  const params = new URLSearchParams({ timeout: "0", filter: SYNC_FILTER });
  if (since) params.set("since", since);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(`${homeserverUrl()}/_matrix/client/v3/sync?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken()}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[crm-service][matrix] GET /sync returned ${res.status}: ${text}`);
    }
    return (await res.json()) as MatrixSyncResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][matrix] GET /sync aborted after ${SYNC_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
