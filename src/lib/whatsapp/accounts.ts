/**
 * The brand's linked WhatsApp accounts, as the send and the phone resolution
 * use them: the dedicated Matrix account, its sync token, and the bridge login
 * (the account's own number). Connected = the bridge says CONNECTED right now.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixConnections, matrixLinks } from "../../db/schema.js";
import { bridgeLogins } from "../matrix/bridge.js";

export interface WhatsappAccount {
  linkId: string;
  connectionId: string;
  matrixUserId: string;
  accessToken: string;
  /** The account's own number, digits (the bridge login id). */
  loginId: string;
  /** The brand marked this account as the one first messages go out from. */
  outreachDefault: boolean;
}

/** Every linked WhatsApp account of the brand with a token and a login, oldest link first. */
export async function linkedWhatsappAccounts(orgId: string, brandId: string): Promise<WhatsappAccount[]> {
  const rows = await db
    .select({
      linkId: matrixLinks.id,
      connectionId: matrixConnections.id,
      matrixUserId: matrixConnections.matrixUserId,
      accessToken: matrixConnections.accessToken,
      connStatus: matrixConnections.status,
      loginId: matrixLinks.remoteLoginId,
      outreachDefault: matrixLinks.outreachDefault,
    })
    .from(matrixLinks)
    .innerJoin(matrixConnections, eq(matrixConnections.id, matrixLinks.connectionId))
    .where(
      and(
        eq(matrixLinks.orgId, orgId),
        eq(matrixLinks.brandId, brandId),
        eq(matrixLinks.channel, "whatsapp"),
        eq(matrixLinks.status, "linked"),
      ),
    )
    .orderBy(asc(matrixLinks.linkedAt), asc(matrixLinks.id));
  return rows
    .filter((r) => !!r.accessToken && !!r.loginId && r.connStatus !== "paused")
    .map((r) => ({
      linkId: r.linkId,
      connectionId: r.connectionId,
      matrixUserId: r.matrixUserId,
      accessToken: r.accessToken!,
      loginId: r.loginId!,
      outreachDefault: r.outreachDefault,
    }));
}

/** The subset the bridge reports CONNECTED right now (one `/whoami` per account). */
export async function connectedOnly(accounts: WhatsappAccount[]): Promise<WhatsappAccount[]> {
  const out: WhatsappAccount[] = [];
  for (const a of accounts) {
    const logins = await bridgeLogins("whatsapp", a.matrixUserId);
    if (logins.find((l) => l.id === a.loginId)?.state?.state_event === "CONNECTED") out.push(a);
  }
  return out;
}
