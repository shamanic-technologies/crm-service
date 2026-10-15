/**
 * A CAMPAIGN THAT CANNOT WRITE ON WHATSAPP IS TOLD TO STAFF (WHATSAPP-RESOLVE-1015).
 *
 * Prod 2026-10-15: Doc Dinners' AI Meeting Booking answered a Meta Ads form; the
 * email went, the WhatsApp step was refused `whatsapp_not_linked` (the brand has
 * never linked a WhatsApp account) and the workflow skipped it by design. Nobody
 * knew: a refusal only the customer can lift was silent.
 *
 * Now a fresh refusal that needs the CUSTOMER to act (link / relink WhatsApp),
 * on a send a campaign asked for, sends the owner one Telegram message per
 * (code, brand, UTC day): which brand, what was skipped, what the customer
 * must do, and the page where they do it. Claimed in `staff_alerts` before the
 * send (at most once, never retried). Never throws, never awaited by the send.
 */

import { db } from "../../db/index.js";
import { staffAlerts } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { DASHBOARD_ORIGIN, readOrg } from "../conversation-pings.js";
import { brandNamesFor } from "../people/timeline.js";
import type { SiblingIdentity } from "../people/siblings.js";
import { sendOwnerTelegram } from "../owner-telegram.js";
import type { SendRefusalCode } from "./send.js";

/** The refusals only the customer can lift. Every other code is about the person, not the brand. */
export const CUSTOMER_ACTION_CODES: ReadonlySet<SendRefusalCode> = new Set(["whatsapp_not_linked", "whatsapp_not_connected"]);

export interface RefusalAlertInput {
  code: SendRefusalCode;
  orgId: string;
  brandId: string;
  campaignId: string | null;
  runId: string;
  userId: string | null;
  at: Date;
}

/** PURE: the dedupe key, one per (code, brand, UTC day). */
export function alertKeyFor(code: string, brandId: string, at: Date): string {
  return `whatsapp_send:${code}:${brandId}:${at.toISOString().slice(0, 10)}`;
}

/** PURE: the brand's Integrations page, where WhatsApp is linked. */
export function integrationsUrl(clerkOrgId: string, brandId: string): string {
  return `${DASHBOARD_ORIGIN}/v2/orgs/${encodeURIComponent(clerkOrgId)}/brands/${encodeURIComponent(brandId)}/integrations`;
}

/** PURE: the message. */
export function composeRefusalAlert(p: { code: SendRefusalCode; brandName: string; orgName: string | null; url: string | null }): string {
  const who = p.orgName && p.orgName !== p.brandName ? `${p.brandName} (${p.orgName})` : p.brandName;
  const why =
    p.code === "whatsapp_not_linked"
      ? "the brand has no WhatsApp account linked"
      : "the brand's WhatsApp is linked but logged out";
  const todo = p.code === "whatsapp_not_linked" ? "link their WhatsApp" : "relink their WhatsApp (scan the QR again)";
  const lines = [
    `WhatsApp message not sent: ${who}`,
    `A campaign wanted to write to a prospect on WhatsApp, but ${why}. Nothing was sent on WhatsApp.`,
    `To fix: the customer must ${todo} on the Integrations page.`,
  ];
  if (p.url) lines.push(p.url);
  lines.push("Told once a day per brand.");
  return lines.join("\n");
}

async function claim(key: string): Promise<boolean> {
  const rows = await db.insert(staffAlerts).values({ alertKey: key, status: "sending" }).onConflictDoNothing().returning();
  return rows.length > 0;
}

/** Tell the owner, once per (code, brand, day). Never throws. */
export async function alertRefusal(input: RefusalAlertInput): Promise<void> {
  try {
    if (!CUSTOMER_ACTION_CODES.has(input.code) || !input.campaignId) return;
    const key = alertKeyFor(input.code, input.brandId, input.at);
    if (!(await claim(key))) return;

    let brandName = input.brandId.slice(0, 8);
    let orgName: string | null = null;
    let url: string | null = null;
    if (input.userId) {
      const identity: SiblingIdentity = { orgId: input.orgId, userId: input.userId, runId: input.runId, brandId: input.brandId };
      const [names, org] = await Promise.all([
        brandNamesFor([input.brandId], identity).catch((err) => {
          console.error(`[crm-service][whatsapp] refusal alert: brand name unreadable:`, (err as Error).message);
          return new Map<string, string>();
        }),
        readOrg(input.orgId, identity).catch((err) => {
          console.error(`[crm-service][whatsapp] refusal alert: org unreadable:`, (err as Error).message);
          return null;
        }),
      ]);
      brandName = names.get(input.brandId) ?? brandName;
      orgName = org?.name ?? null;
      if (org?.externalId) url = integrationsUrl(org.externalId, input.brandId);
    }

    const text = composeRefusalAlert({ code: input.code, brandName, orgName, url });
    console.error(`[crm-service][whatsapp] customer action needed (${input.code}) brand=${input.brandId} campaign=${input.campaignId}`);
    const r = await sendOwnerTelegram(text);
    await db
      .update(staffAlerts)
      .set({ status: r.status, error: r.status === "sent" ? null : r.error })
      .where(eq(staffAlerts.alertKey, key));
  } catch (err) {
    console.error(`[crm-service][whatsapp] refusal alert failed (${input.code}, brand ${input.brandId}):`, err);
  }
}
