/**
 * Matrix client-server API client.
 *
 * crm-service CONSUMES a homeserver (conduwuit + mautrix bridges) that runs
 * outside this repo. It never builds, configures or deploys it.
 *
 * Two calls: `GET /_matrix/client/v3/sync` with a `since` cursor (the mirror),
 * and `sendText`, the ONE write: a text message into a DM room, used only by
 * the WhatsApp send (`lib/whatsapp/send.ts`, owner 2026-10-12). Nothing else
 * writes, so every other channel (Discord, LinkedIn, Telegram) stays read-only.
 * Account creation for self-serve links lives in `account.ts`; it creates and
 * logs in accounts, and it sends nothing either.
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

export function homeserverUrl(): string {
  const url = process.env.MATRIX_HOMESERVER_URL;
  if (!url) throw new Error("[crm-service] MATRIX_HOMESERVER_URL is required");
  return url.replace(/\/+$/, "");
}

export function platformAccessToken(): string {
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
 * `token` = the access token to sync AS. A self-serve connection passes its own
 * dedicated account's token; a hand-registered one passes the platform account's
 * (`platformAccessToken()`). The caller decides, explicitly — no default.
 *
 * Fails loud: any non-2xx or transport error throws.
 */
export async function sync(since: string | null, token: string): Promise<MatrixSyncResponse> {
  const params = new URLSearchParams({ timeout: "0", filter: SYNC_FILTER });
  if (since) params.set("since", since);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(`${homeserverUrl()}/_matrix/client/v3/sync?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
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

const SEND_TIMEOUT_MS = 30_000;

/**
 * Send a plain text message into `roomId` as the account owning `token`.
 * `txnId` is Matrix's own idempotency key: the homeserver answers the SAME event
 * id for a repeated (token, txnId), so a retry never sends twice.
 * Fails loud: any non-2xx or transport error throws.
 */
export async function sendText(token: string, roomId: string, txnId: string, text: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
  try {
    const res = await fetch(`${homeserverUrl()}${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: text }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`[crm-service][matrix] PUT send returned ${res.status}: ${body.slice(0, 300)}`);
    const eventId = (JSON.parse(body) as { event_id?: unknown }).event_id;
    if (typeof eventId !== "string") throw new Error(`[crm-service][matrix] send answered no event_id: ${body.slice(0, 300)}`);
    return eventId;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][matrix] PUT send aborted after ${SEND_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Join `roomId` as the account owning `token` (a no-op when already joined).
 * The bridge invites the account to a DM it opens; joining first makes the
 * send independent of whether the bridge's double-puppet join landed yet.
 */
export async function joinRoom(token: string, roomId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${homeserverUrl()}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[crm-service][matrix] POST join returned ${res.status}: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** One `m.bridge` (or legacy `uk.half-shot.bridge`) state event: whom the bridge says the room talks to. */
export interface RoomBridgeInfo {
  type: string;
  /** The network's chat id (WhatsApp: the counterpart's JID, `…@lid` or `…@s.whatsapp.net`). */
  channelId: string | null;
  /** The login the portal belongs to (`fi.mau.receiver`), when the bridge states it. */
  receiver: string | null;
  displayname: string | null;
}

const BRIDGE_STATE_TYPES = ["m.bridge", "uk.half-shot.bridge"];

/**
 * The bridge's own statement of WHO a room delivers to, read from the room
 * state as the account owning `token` (it must be a member). Read only.
 * Fails loud: any non-2xx or transport error throws.
 */
export async function readRoomBridgeInfo(token: string, roomId: string): Promise<RoomBridgeInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${homeserverUrl()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`[crm-service][matrix] GET room state returned ${res.status}: ${body.slice(0, 300)}`);
    const events = JSON.parse(body) as MatrixEvent[];
    return events
      .filter((e) => BRIDGE_STATE_TYPES.includes(e.type))
      .map((e) => {
        const channel = (e.content?.channel ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        return {
          type: e.type,
          channelId: str(channel.id),
          receiver: str(channel["fi.mau.receiver"]),
          displayname: str(channel.displayname),
        };
      });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][matrix] GET room state aborted after ${SEND_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
