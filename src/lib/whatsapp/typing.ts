/**
 * « typing… » WHILE THE ANSWERING AI WORKS (SOPHIE-WA-HUMAN-1106, owner 2026-11-04: Kevin waited 3 min of silence).
 *
 * The answering AI (chat-service) says when it starts working on an answer to a person and when it stops:
 * `POST /orgs/whatsapp/typing {state: "start" | "stop"}`. From `start`, the brand's account that would answer
 * (the send's own pick) shows WhatsApp's "typing..." in the person's room (a Matrix typing notification, bridged
 * as WhatsApp's composing presence), re-sent every `TYPING_REFRESH_MS`, until the first of:
 *  - `stop` (the AI decided not to write now): "typing..." ends at once;
 *  - a send into that room (`endTypingIn`, called by the send): the message itself replaces it;
 *  - `TYPING_HOLD_MS` after the LAST `start` (a caller that died never leaves it on; a long turn calls `start` again).
 * In-process only (one crm-service container): a restart ends every hold, WhatsApp clears it after the timeout.
 * Ephemeral: nothing stored, no cost.
 */
import { setTyping } from "../matrix/client.js";

/** One `start` keeps "typing..." on this long (each later `start` extends it). */
export const TYPING_HOLD_MS = 3 * 60_000;
/** "typing..." is re-sent this often while held. */
export const TYPING_REFRESH_MS = 20_000;
/** Each typing notification asks the homeserver to keep it this long (covers one refresh missed). */
export const TYPING_TIMEOUT_MS = 30_000;

export interface TypingAccount {
  accessToken: string;
  matrixUserId: string;
}

interface Hold {
  key: string;
  account: TypingAccount;
  roomId: string;
  until: number;
  timer: ReturnType<typeof setInterval>;
}

/** Active holds by caller key (org|brand|who) and by room (`roomId|account`). */
const byKey = new Map<string, Hold>();
const byRoom = new Map<string, Hold>();
const roomKey = (roomId: string, mxid: string) => `${roomId}|${mxid}`;

/** The key a caller names a hold by: the person as the caller named them (phone first, else email). */
export function typingKey(orgId: string, brandId: string, who: { phone: string | null; email: string | null }): string {
  return `${orgId}|${brandId}|${who.phone ?? ""}|${who.email ?? ""}`;
}

function release(h: Hold): void {
  clearInterval(h.timer);
  if (byKey.get(h.key) === h) byKey.delete(h.key);
  const rk = roomKey(h.roomId, h.account.matrixUserId);
  if (byRoom.get(rk) === h) byRoom.delete(rk);
}

/** Show "typing..." now and hold it (see the file header). Returns until when it is held. */
export async function startTyping(key: string, account: TypingAccount, roomId: string, now: number = Date.now()): Promise<Date> {
  const until = now + TYPING_HOLD_MS;
  const existing = byKey.get(key);
  if (existing && existing.roomId === roomId && existing.account.matrixUserId === account.matrixUserId) {
    existing.until = until;
  } else {
    if (existing) release(existing);
    const sameRoom = byRoom.get(roomKey(roomId, account.matrixUserId));
    if (sameRoom) release(sameRoom);
    const hold: Hold = {
      key,
      account,
      roomId,
      until,
      timer: setInterval(() => {
        if (Date.now() >= hold.until) {
          release(hold);
          void setTyping(account.accessToken, roomId, account.matrixUserId, false);
          return;
        }
        void setTyping(account.accessToken, roomId, account.matrixUserId, true, TYPING_TIMEOUT_MS);
      }, TYPING_REFRESH_MS),
    };
    hold.timer.unref?.();
    byKey.set(key, hold);
    byRoom.set(roomKey(roomId, account.matrixUserId), hold);
  }
  await setTyping(account.accessToken, roomId, account.matrixUserId, true, TYPING_TIMEOUT_MS);
  return new Date(until);
}

/** End the caller's hold: "typing..." stops at once. False when nothing was held under that key. */
export async function stopTyping(key: string): Promise<boolean> {
  const h = byKey.get(key);
  if (!h) return false;
  release(h);
  await setTyping(h.account.accessToken, h.roomId, h.account.matrixUserId, false);
  return true;
}

/** A send went into this room as this account: the hold ends (the message replaces "typing..."). */
export function endTypingIn(roomId: string, mxid: string): void {
  const h = byRoom.get(roomKey(roomId, mxid));
  if (!h) return;
  release(h);
  void setTyping(h.account.accessToken, roomId, mxid, false);
}

/** Tests only: whether a hold is active under this key, and its room. */
export function heldTyping(key: string): { roomId: string; until: number } | null {
  const h = byKey.get(key);
  return h ? { roomId: h.roomId, until: h.until } : null;
}

/** Tests only. */
export function clearTypingHolds(): void {
  for (const h of [...byKey.values()]) release(h);
}
