/**
 * The distribute.you Copilot as a conversation SOURCE of the staff Unibox.
 *
 * The Copilot (chat-service's agent) is a member of OUR staff: every chat turn
 * (the user's message and the Copilot's answer) is a staff conversation with
 * that person, exactly like a staff Gmail mailbox. chat-service PUSHES each turn
 * (`POST /internal/copilot/messages`); this module stores it and serves it to
 * the people layer.
 *
 * PRIVACY is structural, not a filter a caller can widen: the scope a turn is
 * filed under is NOT in the request. It is the staff Unibox scope configured on
 * the box (`COPILOT_UNIBOX_ORG_ID` + `COPILOT_UNIBOX_BRAND_ID`), so a turn can
 * never land in the chatting user's own org, nor in any customer org, nor in
 * another org that happens to carry the distribute.you brand id. The people
 * reads answer `not_connected` for every other (org, brand).
 *
 * Idempotent: one row per chat-service message id; a turn pushed twice is
 * stored once. A chat the user deletes on their side STAYS here (staff record).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { copilotMessages, type CopilotMessage } from "../../db/schema.js";
import { normalizeEmail, type Presence } from "../people/identity.js";

/** How the Copilot is named on a thread: a staff member like any other. */
export const COPILOT_SENDER_NAME = "AI Copilot";
/** The channel of a Copilot turn (a chat inside the dashboard or through the API). */
export const COPILOT_CHANNEL = "chat";

export const COPILOT_ROLES = ["user", "assistant"] as const;
export type CopilotRole = (typeof COPILOT_ROLES)[number];

export interface CopilotDestination {
  orgId: string;
  brandId: string;
}

export class CopilotDestinationMissingError extends Error {
  constructor() {
    super("COPILOT_UNIBOX_ORG_ID and COPILOT_UNIBOX_BRAND_ID must be set: the staff Unibox scope Copilot turns are filed under");
  }
}

/** The staff Unibox scope, or null when the box does not configure one. */
export function copilotDestination(): CopilotDestination | null {
  const orgId = process.env.COPILOT_UNIBOX_ORG_ID?.trim();
  const brandId = process.env.COPILOT_UNIBOX_BRAND_ID?.trim();
  return orgId && brandId ? { orgId, brandId } : null;
}

/** True only for the staff Unibox scope (org AND brand: the brand id alone is shared with test orgs). */
export function isCopilotDestination(orgId: string, brandId: string): boolean {
  const d = copilotDestination();
  return d !== null && d.orgId === orgId && d.brandId === brandId;
}

export interface CopilotTurnInput {
  orgId: string;
  userId: string;
  email: string;
  displayName?: string | null;
  sessionId: string;
  messages: { messageId: string; role: CopilotRole; text: string; at: string }[];
}

/** Postgres refuses NUL in text. */
const stripNul = (s: string) => s.replace(/\u0000/g, "");

/** Store one turn under the staff scope. Returns how many messages were new. */
export async function storeCopilotTurn(
  input: CopilotTurnInput,
  runId: string | null,
): Promise<{ stored: number; duplicates: number; newMessageIds: string[] }> {
  const destination = copilotDestination();
  if (!destination) throw new CopilotDestinationMissingError();
  const email = normalizeEmail(input.email);
  if (!email) throw new Error(`not an email address: ${input.email}`);
  const rows = input.messages.map((m) => ({
    orgId: destination.orgId,
    brandId: destination.brandId,
    chatOrgId: input.orgId,
    chatUserId: input.userId,
    email,
    displayName: input.displayName?.trim() ? stripNul(input.displayName.trim()) : null,
    sessionId: input.sessionId,
    messageId: m.messageId,
    role: m.role,
    text: stripNul(m.text),
    sentAt: new Date(m.at),
    runId,
  }));
  const inserted = await db
    .insert(copilotMessages)
    .values(rows)
    .onConflictDoNothing({ target: copilotMessages.messageId })
    .returning({ messageId: copilotMessages.messageId });
  return {
    stored: inserted.length,
    duplicates: rows.length - inserted.length,
    newMessageIds: inserted.map((r) => r.messageId),
  };
}

/** PURE: one presence per chatting address, from that address's stored turns. */
export function copilotPresences(rows: CopilotMessage[]): Presence[] {
  const byEmail = new Map<string, CopilotMessage[]>();
  for (const r of rows) byEmail.set(r.email, [...(byEmail.get(r.email) ?? []), r]);
  return [...byEmail.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([email, msgs]) => {
      const sorted = [...msgs].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || (a.id < b.id ? -1 : 1));
      const named = [...sorted].reverse().find((m) => m.displayName);
      return {
        source: "copilot" as const,
        sourceRef: email,
        displayName: named?.displayName ?? null,
        company: null,
        emails: [email],
        phones: [],
        firstActivityAt: sorted[0].sentAt.toISOString(),
        lastActivityAt: sorted[sorted.length - 1].sentAt.toISOString(),
        messageCount: sorted.length,
        inboundCount: sorted.filter((m) => m.role === "user").length,
        outboundCount: sorted.filter((m) => m.role === "assistant").length,
        detail: {
          channel: COPILOT_CHANNEL,
          chatOrgIds: [...new Set(sorted.map((m) => m.chatOrgId))].sort(),
          chatUserIds: [...new Set(sorted.map((m) => m.chatUserId))].sort(),
          sessions: new Set(sorted.map((m) => m.sessionId)).size,
        },
      };
    });
}

/** Every stored turn of the scope (empty for any scope but the staff Unibox). */
export async function readCopilotRows(orgId: string, brandId: string): Promise<CopilotMessage[]> {
  if (!isCopilotDestination(orgId, brandId)) return [];
  return db
    .select()
    .from(copilotMessages)
    .where(and(eq(copilotMessages.orgId, orgId), eq(copilotMessages.brandId, brandId)));
}

/** The stored turns of these addresses in the staff scope, oldest first. */
export async function readCopilotThread(orgId: string, brandId: string, emails: string[]): Promise<CopilotMessage[]> {
  if (!isCopilotDestination(orgId, brandId) || emails.length === 0) return [];
  return db
    .select()
    .from(copilotMessages)
    .where(
      and(
        eq(copilotMessages.orgId, orgId),
        eq(copilotMessages.brandId, brandId),
        inArray(copilotMessages.email, emails.map((e) => e.toLowerCase())),
      ),
    )
    .orderBy(asc(copilotMessages.sentAt), sql`CASE ${copilotMessages.role} WHEN 'user' THEN 0 ELSE 1 END`, asc(copilotMessages.id));
}
