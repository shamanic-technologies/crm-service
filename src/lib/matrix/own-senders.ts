/**
 * WHO "we" are on one connection (OLIVE-TG-SELF-GHOST-1029, `events.ts` `OwnSenders`): the connection's own
 * Matrix account plus the bridge's self-ghost of every account linked on it (`matrix_links.remote_login_id`).
 * Read from the link rows, never guessed from a ghost's name.
 */
import { sql, type SQL } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixLinks } from "../../db/schema.js";
import { selfGhostMxid } from "./events.js";

export interface OwnSendersConnection {
  id: string;
  matrixUserId: string;
  counterpartPrefix: string;
}

export async function connectionOwnSenders(conn: OwnSendersConnection): Promise<string[]> {
  const links = await db
    .select({ remoteLoginId: matrixLinks.remoteLoginId })
    .from(matrixLinks)
    .where(eq(matrixLinks.connectionId, conn.id));
  const own = new Set<string>([conn.matrixUserId]);
  for (const l of links) {
    const ghost = selfGhostMxid(conn.counterpartPrefix, conn.matrixUserId, l.remoteLoginId);
    if (ghost) own.add(ghost);
  }
  return [...own];
}

/**
 * The same predicate in SQL, for readers that classify a raw event's direction in a query: TRUE when
 * `sender` is the connection's account or the self-ghost of an account linked on it. `connectionId` is the
 * event's connection column. Mirrors `selfGhostMxid` (prefix + login id without a leading `+` + the
 * account's server).
 */
export function ownSenderSql(sender: SQL, connectionId: SQL): SQL {
  return sql`(
    ${sender} = (SELECT os_mc.matrix_user_id FROM matrix_connections os_mc WHERE os_mc.id = ${connectionId})
    OR ${sender} IN (
      SELECT os_mc.counterpart_prefix || regexp_replace(btrim(os_ml.remote_login_id), '^\\+', '')
             || substr(os_mc.matrix_user_id, strpos(os_mc.matrix_user_id, ':'))
      FROM matrix_links os_ml JOIN matrix_connections os_mc ON os_mc.id = os_ml.connection_id
      WHERE os_ml.connection_id = ${connectionId} AND coalesce(btrim(os_ml.remote_login_id), '') <> ''
    )
  )`;
}
