/**
 * Auth providers (Clerk today) — the tool holding every person who signed up to
 * the brand's product, connected per brand, read-only.
 *
 * Same connection contract as GoHighLevel / PostHog / Stripe:
 *  - the secret key lives in key-service under the provider's name, scoped to
 *    (org, brand), no org-wide fallback; crm-service never stores it;
 *  - the connection row is written only once the key has been PROVEN against
 *    the provider (it must list the users), and a refusal quotes the provider's
 *    own status and words (`vendorStatus`, `vendorError`);
 *  - `/internal/<provider>/sync` (cron) opens one ORG run per connection.
 *
 * One set of routes per registered provider (`AUTH_PROVIDERS`): a sibling
 * provider gets its routes by being registered, with no route code.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { authConnections, contacts } from "../db/schema.js";
import { apiKeyAuth, requireOrg, requireOrgAndUser, type AuthenticatedRequest } from "../middleware/auth.js";
import { AuthProviderError } from "../lib/auth/provider.js";
import { AUTH_PROVIDERS } from "../lib/auth/providers.js";
import { rebuildAuthFromBronze, runAuthSyncPass } from "../lib/auth/sync.js";
import { credentialOr4xx, internalTrigger, vendorRefusal } from "./posthog-stripe.js";

const router = Router();
const uuid = z.string().uuid();
const internalBody = z.object({ connectionId: uuid.optional() });
const patchSchema = z.object({ status: z.enum(["active", "paused"]) });

export function authConnectionView(row: typeof authConnections.$inferSelect) {
  return {
    id: row.id,
    brandId: row.brandId,
    provider: row.provider,
    status: row.status,
    synced: row.lastSyncedAt !== null,
    lastSyncedAt: row.lastSyncedAt,
    providerUserCount: row.providerUserCount,
    lastError: row.lastError,
    lastRunId: row.lastRunId,
    createdAt: row.createdAt,
  };
}

for (const adapter of Object.values(AUTH_PROVIDERS)) {
  const p = adapter.name;
  const base = `/orgs/${p}/connections`;
  const own = (req: AuthenticatedRequest, id: string) =>
    and(eq(authConnections.id, id), eq(authConnections.orgId, req.orgId!), eq(authConnections.provider, p));

  /**
   * Connect: the brand's secret key (stored in key-service under provider `p`)
   * is proven by counting the users through the provider's own API. The first
   * sync starts at once; the cron keeps it current.
   */
  router.post(base, apiKeyAuth, requireOrgAndUser(`${p}.connections.create`), async (req: AuthenticatedRequest, res, next) => {
    const parsed = z.object({ brandId: uuid }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) is required" });
    const { brandId } = parsed.data;
    try {
      const key = await credentialOr4xx(req, res, p, adapter.label, brandId);
      if (key === null) return;
      const refused = adapter.rejectKey(key);
      if (refused) return res.status(400).json({ type: "validation", error: `${adapter.label} key refused: ${refused}` });
      let userCount: number;
      try {
        userCount = await adapter.countUsers(key);
      } catch (err) {
        if (err instanceof AuthProviderError) return vendorRefusal(res, adapter.label, err.status, err.vendorMessage);
        throw err;
      }
      const [row] = await db
        .insert(authConnections)
        .values({ orgId: req.orgId!, brandId, provider: p, createdByUserId: req.userId!, status: "active" })
        .onConflictDoUpdate({
          target: [authConnections.orgId, authConnections.brandId, authConnections.provider],
          set: { createdByUserId: req.userId!, status: "active", lastError: null },
        })
        .returning();
      res.json({ connection: authConnectionView(row), userCount });
      setImmediate(() => {
        runAuthSyncPass(p, row.id).catch((e) => console.error(`[crm-service][${p}] first sync crashed:`, e));
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(base, apiKeyAuth, requireOrg(`${p}.connections.list`), async (req: AuthenticatedRequest, res, next) => {
    const brand = uuid.safeParse(req.query.brandId);
    if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    try {
      const rows = await db
        .select()
        .from(authConnections)
        .where(
          and(eq(authConnections.orgId, req.orgId!), eq(authConnections.brandId, brand.data), eq(authConnections.provider, p)),
        );
      res.json({ connections: rows.map(authConnectionView) });
    } catch (err) {
      next(err);
    }
  });

  router.patch(`${base}/:id`, apiKeyAuth, requireOrg(`${p}.connections.update`), async (req: AuthenticatedRequest, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    const body = patchSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ type: "validation", error: "status must be active|paused" });
    try {
      const [row] = await db
        .update(authConnections)
        .set({ status: body.data.status, lastError: null })
        .where(own(req, id.data))
        .returning();
      if (!row) return res.status(404).json({ type: "not_found", error: "connection not found" });
      res.json({ connection: authConnectionView(row) });
    } catch (err) {
      next(err);
    }
  });

  /** Disconnect: the row goes, with (by cascade) its mirror, and its silver contacts. Facts already emitted stay. */
  router.delete(`${base}/:id`, apiKeyAuth, requireOrg(`${p}.connections.delete`), async (req: AuthenticatedRequest, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    try {
      const [existing] = await db.select().from(authConnections).where(own(req, id.data));
      if (!existing) return res.status(404).json({ type: "not_found", error: "connection not found" });
      await db.delete(contacts).where(and(eq(contacts.sourceConnectionId, existing.id), eq(contacts.source, p)));
      await db.delete(authConnections).where(eq(authConnections.id, existing.id));
      res.json({ disconnected: true, connectionId: existing.id });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    `/internal/${p}/sync`,
    apiKeyAuth,
    internalTrigger(`${p}.sync.trigger`, p, (connectionId) => runAuthSyncPass(p, connectionId)),
  );

  /** Re-derive silver from the mirror alone — no provider call, no credential. Synchronous. */
  router.post(`/internal/${p}/rebuild`, apiKeyAuth, async (req, res, next) => {
    const parsed = internalBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
    try {
      const conns = await db
        .select()
        .from(authConnections)
        .where(
          parsed.data.connectionId
            ? and(eq(authConnections.id, parsed.data.connectionId), eq(authConnections.provider, p))
            : eq(authConnections.provider, p),
        );
      const results = [];
      for (const conn of conns) results.push({ connectionId: conn.id, ...(await rebuildAuthFromBronze(conn)) });
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });
}

export default router;
