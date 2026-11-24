/**
 * Shared helpers of the owner's Telegram pings: who is staff (the owner's own actions never alert), who a user / org
 * is (client-service), and the person's thread link in the staff Unibox.
 *
 * History: this module pinged the owner once per API / MCP conversation START (owner 2026-10-12, `conversation_pings`
 * keeps those rows). Retired by TG-EVERY-CALL-1124 (owner 2026-11-24, choice « B »: one line per call, every call):
 * the per-call line is `lib/api-calls/pings.ts`. The Copilot is pinged per message (`assistant-pings.ts`).
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiCalls, copilotMessages, personIds } from "../db/schema.js";
import type { CopilotDestination } from "./copilot/messages.js";
import { siblingGet, type SiblingIdentity } from "./people/siblings.js";
import { isStaffEmail } from "./owner-telegram.js";

/** Where the Unibox lives. */
export const DASHBOARD_ORIGIN = "https://dashboard.distribute.you";

/** PURE: true when any of these addresses is staff (a person ever him pings nothing). */
export function anyStaff(emails: (string | null | undefined)[]): boolean {
  return emails.some((e) => isStaffEmail(e));
}

/** PURE: the person's thread in the staff Unibox. */
export function uniboxThreadUrl(clerkOrgId: string, brandId: string, personId: string): string {
  return `${DASHBOARD_ORIGIN}/v2/orgs/${encodeURIComponent(clerkOrgId)}/brands/${encodeURIComponent(brandId)}/unibox?person=${encodeURIComponent(personId)}`;
}

// ─── staff ──────────────────────────────────────────────────────────────────

/**
 * True when this user id was EVER seen with a staff address, on the Copilot or
 * the API (a session of a person ever him), or the address itself is staff.
 */
export async function isStaffActor(email: string, userId: string): Promise<boolean> {
  if (isStaffEmail(email)) return true;
  const [chat, api] = await Promise.all([
    db.selectDistinct({ email: copilotMessages.email }).from(copilotMessages).where(eq(copilotMessages.chatUserId, userId)),
    db.selectDistinct({ email: apiCalls.email }).from(apiCalls).where(eq(apiCalls.callerUserId, userId)),
  ]);
  return anyStaff([...chat, ...api].map((r) => r.email));
}

// ─── who they are (client-service), the thread link ─────────────────────────

const LOOKUP_TTL_MS = 60 * 60 * 1000;
const orgCache = new Map<string, { at: number; org: { externalId: string | null; name: string | null } | null }>();

export async function readOrg(orgId: string, identity: SiblingIdentity): Promise<{ externalId: string | null; name: string | null } | null> {
  const hit = orgCache.get(orgId);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.org;
  const r = await siblingGet("client", `/internal/orgs/${encodeURIComponent(orgId)}`, identity);
  if (r.status === 404) {
    orgCache.set(orgId, { at: Date.now(), org: null });
    return null;
  }
  if (r.status !== 200) throw new Error(`client-service GET /internal/orgs/${orgId} returned ${r.status}`);
  const body = r.body as { externalId?: string | null; name?: string | null };
  const org = { externalId: body.externalId ?? null, name: body.name?.trim() || null };
  orgCache.set(orgId, { at: Date.now(), org });
  return org;
}

export async function readUserName(userId: string, identity: SiblingIdentity): Promise<string | null> {
  const r = await siblingGet("client", `/internal/users/${encodeURIComponent(userId)}`, identity);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`client-service GET /internal/users/${userId} returned ${r.status}`);
  const u = (r.body as { user?: { firstName?: string | null; lastName?: string | null } }).user;
  const name = [u?.firstName, u?.lastName].map((x) => x?.trim()).filter(Boolean).join(" ");
  return name || null;
}

/**
 * The person's opaque id in the staff Unibox, so the link opens their thread.
 * A brand-new chatter has none until the next people build (cron): the id is
 * minted here exactly as the build would mint it (`person_ids` is the build's
 * own memory, keyed on the identity key: `email:<addr>`, `matrix:<contact id>`),
 * so the build adopts it and the link keeps working; a later merge keeps it
 * working through `person_id_aliases`.
 */
export async function mintPersonId(dest: CopilotDestination, identityKey: string): Promise<string> {
  await db
    .insert(personIds)
    .values({ orgId: dest.orgId, brandId: dest.brandId, identityKey, personId: randomUUID() })
    .onConflictDoNothing({ target: [personIds.orgId, personIds.brandId, personIds.identityKey] });
  const [row] = await db
    .select({ personId: personIds.personId })
    .from(personIds)
    .where(and(eq(personIds.orgId, dest.orgId), eq(personIds.brandId, dest.brandId), eq(personIds.identityKey, identityKey)))
    .limit(1);
  return row.personId;
}
