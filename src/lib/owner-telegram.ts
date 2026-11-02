/**
 * A Telegram message to the owner (split in parts when longer than Telegram allows). Same bot and chat as the other owner
 * alerts of the fleet (client-service signup steps, billing-service payments,
 * the landing chat): `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` in this
 * service's env file.
 *
 * Fleet rules, the same as client-service `owner-telegram.ts`:
 *  - never the owner's own actions: a staff address sends nothing
 *    (`isStaffEmail`, the callers also exclude any session ever his);
 *  - never fails the thing it reports: `sendOwnerTelegram` never throws, and
 *    callers run it off the request path. A failure is logged loudly instead.
 */

const SEND_TIMEOUT_MS = 10_000;

/**
 * Staff, mirrored from client-service / billing-service `isStaffEmail` (itself
 * mirrored from api-service STAFF_EMAILS), plus any `@distribute.you` address
 * (our own test accounts). Plus-addressing is ignored.
 */
export const STAFF_EMAIL_LIST = ["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"] as const;
const STAFF_EMAILS = new Set<string>(STAFF_EMAIL_LIST);
export const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = normalized.split("@");
  return STAFF_EMAILS.has(`${local.split("+")[0]}@${domain}`);
}

export type OwnerTelegramResult =
  | { status: "sent"; messageId: number }
  | { status: "unconfigured"; error: string }
  | { status: "failed"; error: string };

/** Telegram refuses a message over 4096 characters. */
export const TELEGRAM_MESSAGE_MAX = 4096;

/**
 * PURE: the text cut into Telegram-sized parts, nothing dropped (SOPHIE-ONLY-TG-1102:
 * « arrête de tronquer les messages, je veux tout lire »). Each cut falls on the
 * last line break, else the last space, of the part; a word longer than a part is
 * cut on code points. Joining the parts back (with the separator each cut ate)
 * gives the text.
 */
export function splitTelegramText(text: string, max = TELEGRAM_MESSAGE_MAX): string[] {
  const parts: string[] = [];
  let rest = [...text];
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut < max && (rest[cut] === "\n" || rest[cut] === " ") ? cut + 1 : cut);
  }
  parts.push(rest.join(""));
  return parts;
}

/**
 * The whole delivery, awaited. Never throws. A text over one Telegram message
 * goes out as several in a row, in order; the result names the FIRST message,
 * or the first part that failed (the parts after it are not sent).
 */
export async function sendOwnerTelegram(text: string): Promise<OwnerTelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim();
  if (!token || !chatId) {
    const error = "TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set";
    console.error(`[crm-service] ${error}: owner NOT told: ${text}`);
    return { status: "unconfigured", error };
  }
  const parts = splitTelegramText(text);
  let first: number | null = null;
  for (const [i, part] of parts.entries()) {
    const r = await sendOne(token, chatId, part);
    if (r.status !== "sent") return parts.length > 1 ? { status: "failed", error: `part ${i + 1}/${parts.length}: ${r.error}` } : r;
    first ??= r.messageId;
  }
  return { status: "sent", messageId: first! };
}

async function sendOne(token: string, chatId: string, text: string): Promise<OwnerTelegramResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;
    if (!res.ok || !body?.ok || typeof body.result?.message_id !== "number") {
      const error = `Telegram refused ${res.status}: ${body?.description ?? "no body"}`;
      console.error(`[crm-service] owner Telegram ping ${error} (${text})`);
      return { status: "failed", error };
    }
    return { status: "sent", messageId: body.result.message_id };
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[crm-service] owner Telegram ping failed (${text}):`, err);
    return { status: "failed", error };
  }
}
