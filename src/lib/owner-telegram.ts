/**
 * One short Telegram message to the owner. Same bot and chat as the other owner
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
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"]);
const STAFF_DOMAIN = "@distribute.you";

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

/** The whole delivery, awaited. Never throws. */
export async function sendOwnerTelegram(text: string): Promise<OwnerTelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim();
  if (!token || !chatId) {
    const error = "TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set";
    console.error(`[crm-service] ${error}: owner NOT told: ${text}`);
    return { status: "unconfigured", error };
  }
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
