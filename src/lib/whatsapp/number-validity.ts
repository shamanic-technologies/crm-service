/**
 * A NUMBER THAT DOES NOT EXIST is not a bridge outage (WHATSAPP-RESOLVE-1015).
 *
 * WhatsApp answers `resolve_identifier` for a malformed number with
 * `<contact type="invalid">`, and mautrix-whatsapp turns that into a bare
 * `500 M_UNKNOWN "Internal error resolving identifier"` — the same answer as a
 * real bridge failure. Prod 2026-10-14/15: a signup typed `+254 111 022 9905`
 * (Kenya has 9-digit national numbers, this one has 10). Every send to them
 * answered 502 `bridge_error` (a failed workflow step instead of a skip), and
 * every people build of the brand stopped its WhatsApp phone resolution on
 * that number, so every phone sorting after it was never resolved.
 *
 * The bridge's 500 alone cannot say which it is, so it is read together with
 * a deterministic check of the number against the numbering plan
 * (libphonenumber, full metadata): a bridge error on a number that plan says
 * cannot exist = WhatsApp's "invalid", answered as "not on WhatsApp". A valid
 * number never takes this path, so a real outage stays loud.
 */

import { isValidPhoneNumber } from "libphonenumber-js/max";
import { BridgeError } from "../matrix/bridge.js";

/** True when `phone` (E.164) cannot exist under its country's numbering plan. */
export function isImpossibleNumber(phone: string): boolean {
  return !isValidPhoneNumber(phone);
}

/** The bridge's answer for `phone` means WhatsApp has no such number (404, or a 500 on a number that cannot exist). */
export function bridgeSaysNoSuchNumber(err: unknown, phone: string): "not_on_whatsapp" | "invalid_number" | null {
  if (!(err instanceof BridgeError)) return null;
  if (err.status === 404) return "not_on_whatsapp";
  if (err.status === 500 && isImpossibleNumber(phone)) return "invalid_number";
  return null;
}
