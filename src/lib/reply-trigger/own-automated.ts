/**
 * OUR OWN AUTOMATED SENDS ARE NEVER A PERSON WRITING (SOPHIE-BOT-LOOP-1023).
 *
 * A brand can link two WhatsApp accounts, both the Copilot's line (copilot.ts).
 * When the Copilot answers on account A to account B, its automated send lands
 * on B as an inbound message: handed to the Copilot again, answered from B to
 * A, and so on, forever (2026-10-22 23:00 UTC, +33770657585 <-> +77776879632,
 * one answer every ~10 s on the owner's phone). The same holds for any send we
 * make (Copilot, workflow, campaign) that arrives on another linked account.
 *
 * Which message is ours: every send of our route is recorded in
 * `whatsapp_sends` with the number it was addressed to (`phone`) and its exact
 * text. A message received on an account whose own number is that `phone`,
 * with that text, within minutes of the send, is the echo of our own send: it
 * is never handed to the Copilot and never fires a reply trigger (reason
 * `own_automated_send`). Generic: any org, any brand, any pair of accounts.
 *
 * What stays answered: the owner TYPING BY HAND from one of his linked numbers
 * to the Copilot's line (owner 2026-10-18, « the owner and staff test from their
 * own numbers and must get an answer »): a hand-typed message has no
 * `whatsapp_sends` row, so it is handed off as before. A stranger too.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixLinks, whatsappSends } from "../../db/schema.js";
import type { BurstMessage } from "./thread.js";

/** A send recorded at most this long BEFORE a received message can be its origin (the bridge's delivery delay). */
export const ECHO_BEFORE_MS = 15 * 60_000;
/** ... or this long AFTER it (the send row's clock vs the homeserver's: measured -0.44 s in prod). */
export const ECHO_AFTER_MS = 2 * 60_000;

export interface OurSendTo {
  text: string;
  at: Date;
}

/** PURE: the burst messages that are the echo of one of our sends addressed to this account (same text, close in time). */
export function automatedEchoes(messages: BurstMessage[], sends: OurSendTo[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    const at = Date.parse(m.at);
    const text = m.text.trim();
    if (!text) continue;
    const hit = sends.some((s) => {
      const delta = at - s.at.getTime();
      return s.text.trim() === text && delta <= ECHO_BEFORE_MS && delta >= -ECHO_AFTER_MS;
    });
    if (hit) out.add(m.eventId);
  }
  return out;
}

/**
 * The burst messages received on this WhatsApp account that one of our own
 * sends (any org, any brand, any sending account) produced. Empty when the
 * account's number is unknown or the channel is not WhatsApp.
 */
export async function ourAutomatedEchoesOn(connectionId: string, channel: string, messages: BurstMessage[]): Promise<Set<string>> {
  if (channel !== "whatsapp" || messages.length === 0) return new Set();
  const logins = await db
    .select({ login: matrixLinks.remoteLoginId })
    .from(matrixLinks)
    .where(eq(matrixLinks.connectionId, connectionId));
  const numbers = [...new Set(logins.map((l) => (l.login ?? "").replace(/\D/g, "")).filter((d) => d.length > 0))].map((d) => `+${d}`);
  if (numbers.length === 0) return new Set();
  const times = messages.map((m) => Date.parse(m.at));
  const sends = await db
    .select({ text: whatsappSends.text, at: whatsappSends.createdAt })
    .from(whatsappSends)
    .where(
      and(
        inArray(whatsappSends.phone, numbers),
        inArray(whatsappSends.status, ["sent", "sending"]),
        gte(whatsappSends.createdAt, new Date(Math.min(...times) - ECHO_BEFORE_MS)),
        lte(whatsappSends.createdAt, new Date(Math.max(...times) + ECHO_AFTER_MS)),
      ),
    )
    .orderBy(sql`${whatsappSends.createdAt} DESC`)
    .limit(500);
  return automatedEchoes(messages, sends);
}
