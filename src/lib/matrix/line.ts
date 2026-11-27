import { inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixLinks } from "../../db/schema.js";
import { automationOn, isAccountType, type AccountType } from "./account-types.js";

/**
 * WHICH OF THE BRAND'S LINES A MATRIX MESSAGE IS ON (LEAD-REPLY-CHANNEL-1127).
 *
 * Owner rule 2026-10-13: an automated answer continues THE conversation the person
 * wrote in (same app, same line, same thread), « never another thread nor another
 * persona ». A timeline message named its room and conversation, never the brand's
 * linked account it was received on / sent from, so a writer could not tell a
 * message to the owner's personal Telegram from one to the AI's WhatsApp line.
 *
 * Every Matrix message the person thread serves carries `line` = the account its
 * connection mirrors, as the brand stated it (type, automation), and `account` in
 * the form the WhatsApp reach / send take as `fromAccount` (E.164 of the linked
 * number). Passing it there lets crm-service's OWN rules decide (a personal line
 * answers `automation_not_allowed`): `automationAllowed` is the same verdict
 * (`automationOn`), served so a reader on another app need not ask. Generic on
 * every channel; nothing is keyed on an app name.
 */
export interface MessageLine {
  /** The mirrored connection the message was read from (`matrix_connections.id`). */
  connectionId: string;
  /** The brand's link of that account (PATCH /orgs/matrix/links/{linkId}); null = a hand-registered connection. */
  linkId: string | null;
  /** whatsapp | telegram | linkedin | discord ... (the connection's channel). */
  channel: string;
  /**
   * The account as the brand linked it. WhatsApp: its number, E.164 (`+33612345678`), exactly what
   * `fromAccount` takes on the WhatsApp reach / send / typing routes. Other channels: the bridge's own
   * login id, verbatim. Null when the link holds none (hand-registered, not linked yet).
   */
  account: string | null;
  /** The type the brand picked (`pro_ai` | `pro_human` | `personal_human`), null = not typed. */
  accountType: AccountType | null;
  /**
   * May automation write from this account: the account is linked, the brand allows automation on it and it is
   * not a personal line (`automationOn`, the rule the WhatsApp send applies). Today only WhatsApp has an automated
   * send route; on another channel true means the brand allows it, not that a route exists.
   */
  automationAllowed: boolean;
}

export interface LineLink {
  id: string;
  connectionId: string | null;
  status: string;
  remoteLoginId: string | null;
  accountType: string | null;
  automationAllowed: boolean;
  linkedAt: Date | null;
  updatedAt: Date;
}

/** PURE: the account form a send takes (`fromAccount`): a WhatsApp number in E.164, else the login id verbatim. */
export function accountOf(channel: string, remoteLoginId: string | null): string | null {
  if (!remoteLoginId) return null;
  if (channel === "whatsapp") {
    const digits = remoteLoginId.replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }
  return remoteLoginId;
}

/**
 * PURE: the line of one connection from its links (a relink of the same mirror keeps one row, but an old
 * failed / unlinked row can still point at it): the `linked` one first, then the latest.
 */
export function lineOf(conn: { id: string; channel: string }, links: LineLink[]): MessageLine {
  const mine = links
    .filter((l) => l.connectionId === conn.id)
    .sort((a, b) => Number(b.status === "linked") - Number(a.status === "linked") || b.updatedAt.getTime() - a.updatedAt.getTime());
  const link = mine[0] ?? null;
  if (!link) return { connectionId: conn.id, linkId: null, channel: conn.channel, account: null, accountType: null, automationAllowed: false };
  const accountType = isAccountType(link.accountType) ? link.accountType : null;
  return {
    connectionId: conn.id,
    linkId: link.id,
    channel: conn.channel,
    account: accountOf(conn.channel, link.remoteLoginId),
    accountType,
    automationAllowed: link.status === "linked" && automationOn({ automationAllowed: link.automationAllowed, accountType }),
  };
}

/** The line of each connection asked (two indexed reads). A connection that no longer exists is absent. */
export async function readLines(connectionIds: string[]): Promise<Map<string, MessageLine>> {
  const ids = [...new Set(connectionIds)];
  if (ids.length === 0) return new Map();
  const [conns, links] = await Promise.all([
    db.select({ id: matrixConnections.id, channel: matrixConnections.channel }).from(matrixConnections).where(inArray(matrixConnections.id, ids)),
    db
      .select({
        id: matrixLinks.id,
        connectionId: matrixLinks.connectionId,
        status: matrixLinks.status,
        remoteLoginId: matrixLinks.remoteLoginId,
        accountType: matrixLinks.accountType,
        automationAllowed: matrixLinks.automationAllowed,
        linkedAt: matrixLinks.linkedAt,
        updatedAt: matrixLinks.updatedAt,
      })
      .from(matrixLinks)
      .where(inArray(matrixLinks.connectionId, ids)),
  ]);
  return new Map(conns.map((c) => [c.id, lineOf(c, links)]));
}
