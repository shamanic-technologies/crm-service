/**
 * The auth-provider ingestion pass: bronze → silver, for one connection.
 * Read-only toward the provider; free (Clerk does not bill API reads), so no
 * cost is declared — crm-service declares none of its own.
 *
 *  - BRONZE  every user, verbatim (minus server-only secrets) in
 *            `auth_raw_records`, keyed on the provider's user id. The upsert
 *            writes only when the content hash moved.
 *  - SILVER  users → `contacts` (source = the provider's name), read back from
 *            BRONZE, zero LLM. Only users whose bronze row moved are re-derived.
 *
 * Users are re-listed in full each pass (one request per 500 users), so a user
 * deleted in the provider is noticed: once a pass has listed EVERY user, a user
 * it did not list leaves bronze and silver (a deleted account is no signup).
 *
 * A provider with organizations (Clerk) also mirrors every MEMBERSHIP
 * (`kind = 'membership'`, same no-churn upsert, same complete-listing removal).
 * A user who only belongs to organizations someone else created was INVITED:
 * the contact carries `raw_attributes.signedUp = false` and states no signup
 * (`isSignup`). When any membership moves, every user is re-derived.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { authConnections, authRawRecords, contacts, type AuthConnection } from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, updateRun } from "../runs-client.js";
import { resolveBrandCredential } from "../gohighlevel/credentials.js";
import { canonicalHash } from "../gohighlevel/records.js";
import { normalizePhone } from "../people/identity.js";
import { isSignup, type AuthProviderAdapter, type DerivedAuthMembership } from "./provider.js";
import { AUTH_PROVIDERS, isAuthProvider } from "./providers.js";

export interface AuthSyncResult {
  connectionId: string;
  provider: string;
  runId: string;
  usersListed: number;
  usersChanged: number;
  usersRemoved: number;
  /** The provider's own count, beside what was listed. */
  providerUserCount: number;
  complete: boolean;
  /** Organization memberships (null = the provider has none). */
  memberships: { listed: number; changed: number; removed: number; providerCount: number; complete: boolean } | null;
  contactsDerived: number;
}

export function adapterOf(conn: Pick<AuthConnection, "provider">): AuthProviderAdapter {
  if (!isAuthProvider(conn.provider)) throw new Error(`[crm-service][auth] unknown provider ${conn.provider}`);
  return AUTH_PROVIDERS[conn.provider];
}

async function mirrorBatch(
  conn: AuthConnection,
  records: Record<string, unknown>[],
  idOf: (r: Record<string, unknown>) => string,
  kind: "user" | "membership" = "user",
) {
  const byId = new Map(records.map((r) => [idOf(r), r]));
  const values = [...byId.entries()].map(([externalId, payload]) => ({
    orgId: conn.orgId,
    brandId: conn.brandId,
    connectionId: conn.id,
    kind,
    externalId,
    contentHash: canonicalHash(payload),
    payload,
  }));
  const changed: string[] = [];
  for (let i = 0; i < values.length; i += 500) {
    const rows = await db
      .insert(authRawRecords)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [authRawRecords.connectionId, authRawRecords.kind, authRawRecords.externalId],
        set: { contentHash: sql`excluded.content_hash`, payload: sql`excluded.payload`, mirroredAt: new Date() },
        setWhere: sql`${authRawRecords.contentHash} <> excluded.content_hash`,
      })
      .returning({ externalId: authRawRecords.externalId });
    for (const row of rows) changed.push(row.externalId);
  }
  return changed;
}

async function readBronze(conn: AuthConnection, externalIds?: string[]): Promise<Record<string, unknown>[]> {
  const base = [eq(authRawRecords.connectionId, conn.id), eq(authRawRecords.kind, "user")];
  const read = async (ids?: string[]) =>
    (
      await db
        .select({ payload: authRawRecords.payload })
        .from(authRawRecords)
        .where(and(...base, ...(ids ? [inArray(authRawRecords.externalId, ids)] : [])))
    ).map((r) => r.payload as Record<string, unknown>);
  if (!externalIds) return read();
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < externalIds.length; i += 1000) out.push(...(await read(externalIds.slice(i, i + 1000))));
  return out;
}

/** Every mirrored membership, by user id (empty for a provider without organizations). */
async function membershipsByUser(conn: AuthConnection): Promise<Map<string, DerivedAuthMembership[]>> {
  const out = new Map<string, DerivedAuthMembership[]>();
  const derive = adapterOf(conn).memberships?.derive;
  if (!derive) return out;
  const rows = await db
    .select({ payload: authRawRecords.payload })
    .from(authRawRecords)
    .where(and(eq(authRawRecords.connectionId, conn.id), eq(authRawRecords.kind, "membership")));
  for (const r of rows) {
    const m = derive(r.payload as Record<string, unknown>);
    if (m) out.set(m.userId, [...(out.get(m.userId) ?? []), m]);
  }
  return out;
}

async function deriveContacts(conn: AuthConnection, externalIds?: string[]): Promise<number> {
  const adapter = adapterOf(conn);
  const now = new Date();
  const memberships = await membershipsByUser(conn);
  let derived = 0;
  for (const payload of await readBronze(conn, externalIds)) {
    const u = adapter.derive(payload);
    if (!u) continue;
    const fields = {
      primaryEmail: u.emails[0] ?? null,
      phoneE164: u.phones.map((p) => normalizePhone(p)).find((p) => !!p) ?? null,
      fullName: u.fullName,
      firstName: u.firstName,
      lastName: u.lastName,
      rawAttributes: {
        emails: u.emails,
        phones: u.phones,
        phoneSources: u.phoneSources,
        lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
        signedUp: isSignup(u.externalId, memberships.get(u.externalId) ?? []),
      },
      sourceCreatedAt: u.createdAt,
      sourceUpdatedAt: u.updatedAt,
      sourceConnectionId: conn.id,
      lastRebuiltAt: now,
    };
    await db
      .insert(contacts)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        ...fields,
        consentStatus: "unknown",
        unsubscribed: false,
        source: conn.provider,
        externalId: u.externalId,
      })
      .onConflictDoUpdate({
        target: [contacts.orgId, contacts.brandId, contacts.source, contacts.externalId],
        set: fields,
      });
    derived++;
  }
  return derived;
}

/** A complete membership listing that did not name a membership: the user left that organization. */
async function removeUnlistedMemberships(conn: AuthConnection, listed: Set<string>): Promise<number> {
  const gone = (
    await db
      .select({ externalId: authRawRecords.externalId })
      .from(authRawRecords)
      .where(and(eq(authRawRecords.connectionId, conn.id), eq(authRawRecords.kind, "membership")))
  )
    .map((r) => r.externalId)
    .filter((id) => !listed.has(id));
  for (let i = 0; i < gone.length; i += 1000) {
    await db
      .delete(authRawRecords)
      .where(
        and(
          eq(authRawRecords.connectionId, conn.id),
          eq(authRawRecords.kind, "membership"),
          inArray(authRawRecords.externalId, gone.slice(i, i + 1000)),
        ),
      );
  }
  return gone.length;
}

/** A complete listing that did not name a user: the account is gone from the provider. */
async function removeUnlisted(conn: AuthConnection, listed: Set<string>): Promise<number> {
  const gone = (
    await db
      .select({ externalId: authRawRecords.externalId })
      .from(authRawRecords)
      .where(and(eq(authRawRecords.connectionId, conn.id), eq(authRawRecords.kind, "user")))
  )
    .map((r) => r.externalId)
    .filter((id) => !listed.has(id));
  for (let i = 0; i < gone.length; i += 1000) {
    const ids = gone.slice(i, i + 1000);
    await db
      .delete(contacts)
      .where(
        and(eq(contacts.sourceConnectionId, conn.id), eq(contacts.source, conn.provider), inArray(contacts.externalId, ids)),
      );
    await db
      .delete(authRawRecords)
      .where(
        and(eq(authRawRecords.connectionId, conn.id), eq(authRawRecords.kind, "user"), inArray(authRawRecords.externalId, ids)),
      );
  }
  return gone.length;
}

export async function syncAuthConnection(conn: AuthConnection): Promise<AuthSyncResult> {
  const adapter = adapterOf(conn);
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: `${conn.provider}.sync`,
  });
  const identity = { orgId: conn.orgId, userId: conn.createdByUserId, runId: run.id, brandIds: [conn.brandId] };
  try {
    const key = await resolveBrandCredential(adapter.name, adapter.label, conn.brandId, {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
    });
    const providerUserCount = await adapter.countUsers(key);
    const listed = new Set<string>();
    const changed: string[] = [];
    for await (const page of adapter.listUsers(key)) {
      for (const r of page) listed.add(adapter.idOf(r));
      changed.push(...(await mirrorBatch(conn, page, adapter.idOf)));
    }
    // Memberships: who joined an organization someone else created.
    let memberships: AuthSyncResult["memberships"] = null;
    if (adapter.memberships) {
      const m = adapter.memberships;
      const providerCount = await m.count(key);
      const listedM = new Set<string>();
      let changedM = 0;
      const idOf = (r: Record<string, unknown>) => String(r.id);
      for await (const page of m.list(key)) {
        for (const r of page) listedM.add(idOf(r));
        changedM += (await mirrorBatch(conn, page, idOf, "membership")).length;
      }
      const completeM = listedM.size >= providerCount;
      const removedM = completeM ? await removeUnlistedMemberships(conn, listedM) : 0;
      memberships = { listed: listedM.size, changed: changedM, removed: removedM, providerCount, complete: completeM };
    }
    // Complete = it listed at least what the provider counted just before. A
    // listing cut by the page ceiling, or by a user deleted mid-pass, falls
    // short and removes nothing: never remove on a doubt.
    const complete = listed.size >= providerUserCount;
    const usersRemoved = complete ? await removeUnlisted(conn, listed) : 0;
    // A membership that moved can turn any user into (or out of) a signup: re-derive them all.
    const membershipsMoved = !!memberships && memberships.changed + memberships.removed > 0;
    const contactsDerived = await deriveContacts(conn, membershipsMoved ? undefined : changed);

    await db
      .update(authConnections)
      .set({ status: "active", lastError: null, lastRunId: run.id, lastSyncedAt: new Date(), providerUserCount })
      .where(eq(authConnections.id, conn.id));
    await updateRun(run.id, "completed", identity);
    return {
      connectionId: conn.id,
      provider: conn.provider,
      runId: run.id,
      usersListed: listed.size,
      usersChanged: changed.length,
      usersRemoved,
      providerUserCount,
      complete,
      contactsDerived,
      memberships,
    };
  } catch (err) {
    await db
      .update(authConnections)
      .set({ status: "error", lastError: (err as Error).message, lastRunId: run.id })
      .where(eq(authConnections.id, conn.id));
    await updateRun(run.id, "failed", identity).catch((e) =>
      console.error(`[crm-service][${conn.provider}] failed to close run:`, e),
    );
    throw err;
  }
}

/** Every active connection of a provider (or one). Failures are recorded AND returned, never swallowed. */
export async function runAuthSyncPass(provider: string, connectionId?: string) {
  const where = connectionId
    ? and(eq(authConnections.id, connectionId), eq(authConnections.provider, provider))
    : and(eq(authConnections.provider, provider), inArray(authConnections.status, ["active", "error"]));
  const connections = await db.select().from(authConnections).where(where);
  const results: AuthSyncResult[] = [];
  const failures: { connectionId: string; error: string }[] = [];
  for (const conn of connections) {
    if (conn.status === "paused") continue;
    try {
      results.push(await syncAuthConnection(conn));
    } catch (err) {
      console.error(`[crm-service][${provider}] sync failed for connection ${conn.id}:`, err);
      failures.push({ connectionId: conn.id, error: (err as Error).message });
    }
  }
  return { connections: connections.length, results, failures };
}

/** Re-derive all silver from bronze alone — no provider call, no credential. */
export async function rebuildAuthFromBronze(conn: AuthConnection) {
  const listed = (await readBronze(conn)).map((p) => adapterOf(conn).idOf(p));
  // Silver rows whose bronze row is gone (removed in a past pass) go too.
  await db
    .delete(contacts)
    .where(
      and(
        eq(contacts.sourceConnectionId, conn.id),
        eq(contacts.source, conn.provider),
        ...(listed.length ? [notInArray(contacts.externalId, listed)] : []),
      ),
    );
  return { contactsDerived: await deriveContacts(conn) };
}

/** The brand's auth user ids (every provider), for the PostHog persons they name. */
export async function authUserIds(orgId: string, brandId: string): Promise<string[]> {
  const rows = await db
    .select({ externalId: contacts.externalId })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.brandId, brandId),
        inArray(contacts.source, Object.keys(AUTH_PROVIDERS)),
      ),
    );
  return rows.map((r) => r.externalId).filter((id): id is string => !!id);
}
