/**
 * PostHog (what a person DID on the brand's website) and Stripe (what they
 * PAID) — two read-only sources of the person thread, connected per brand.
 *
 * Both follow the GoHighLevel connection contract exactly:
 *  - the credential lives in key-service, scoped to (org, brand), no org-wide
 *    fallback; crm-service never stores it;
 *  - the connection row is written only once the credential has been PROVEN
 *    against the vendor, and a refusal quotes the vendor's own status and words
 *    (`vendorStatus`, `vendorError`);
 *  - `/internal/<source>/sync` (cron) opens one ORG run per connection.
 */

import { Router, type Response } from "express";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { contacts, posthogConnections, stripeConnections, stripeRawRecords } from "../db/schema.js";
import {
  apiKeyAuth,
  requireOrg,
  requireOrgAndUser,
  SERVICE_NAME,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import { CredentialError, resolveBrandCredential } from "../lib/gohighlevel/credentials.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { countIdentifiedPersons, PosthogError, POSTHOG_REGIONS } from "../lib/posthog/client.js";
import { POSTHOG_SOURCE } from "../lib/posthog/records.js";
import { POSTHOG_PROVIDER, rebuildPosthogFromBronze, runPosthogSyncPass, targetOf } from "../lib/posthog/sync.js";
import { readStripeAccount, restrictedKeyMode, StripeError, verifyStripeAccess } from "../lib/stripe/client.js";
import { STRIPE_SOURCE } from "../lib/stripe/records.js";
import {
  rebuildStripeFromBronze,
  runStripeSyncPass,
  STRIPE_PROVIDER,
  STRIPE_PROVIDER_PATTERN,
} from "../lib/stripe/sync.js";

const router = Router();
const uuid = z.string().uuid();

function posthogView(row: typeof posthogConnections.$inferSelect) {
  return {
    id: row.id,
    brandId: row.brandId,
    projectId: row.projectId,
    region: row.region,
    status: row.status,
    synced: row.lastSyncedAt !== null,
    lastSyncedAt: row.lastSyncedAt,
    syncedThrough: row.syncedThrough,
    lastError: row.lastError,
    lastRunId: row.lastRunId,
    createdAt: row.createdAt,
  };
}

function stripeView(row: typeof stripeConnections.$inferSelect) {
  return {
    id: row.id,
    brandId: row.brandId,
    keyMode: row.keyMode,
    credentialProvider: row.credentialProvider,
    account: row.accountId ? { id: row.accountId, name: row.accountName } : null,
    status: row.status,
    synced: row.lastSyncedAt !== null,
    lastSyncedAt: row.lastSyncedAt,
    lastFullSyncAt: row.lastFullSyncAt,
    lastError: row.lastError,
    lastRunId: row.lastRunId,
    createdAt: row.createdAt,
  };
}

/** Resolve the brand's credential; on refusal answer the request and return null. */
async function credentialOr4xx(
  req: AuthenticatedRequest,
  res: Response,
  provider: string,
  label: string,
  brandId: string,
): Promise<string | null> {
  try {
    return await resolveBrandCredential(provider, label, brandId, {
      orgId: req.orgId!,
      userId: req.userId!,
      runId: req.runId,
    });
  } catch (err) {
    if (err instanceof CredentialError) {
      res.status(err.status).json({ type: err.kind === "missing" ? "validation" : "upstream", error: err.message });
      return null;
    }
    throw err;
  }
}

const vendorRefusal = (res: Response, label: string, status: number, message: string) =>
  res.status(400).json({
    type: "vendor",
    error: `${label} refused the credential: ${message}`,
    vendorStatus: status,
    vendorError: message,
  });

// ─── PostHog connections ─────────────────────────────────────────────────────

const posthogBodySchema = z.object({
  brandId: uuid,
  /** The PostHog project id (Project settings → Project ID). */
  projectId: z.string().regex(/^\d+$/, "projectId is PostHog's numeric project id"),
  /** PostHog Cloud region: `us` (us.posthog.com) or `eu` (eu.posthog.com). */
  region: z.enum(POSTHOG_REGIONS),
});

/**
 * Connect a brand's PostHog project. The brand's personal API key (stored in
 * key-service under provider `posthog`; only `query:read` is needed) is proven
 * by counting the project's identified persons through PostHog's own query API.
 */
router.post(
  "/orgs/posthog/connections",
  apiKeyAuth,
  requireOrgAndUser("posthog.connections.create"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = posthogBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        type: "validation",
        error: "brandId (uuid), projectId (numeric) and region (us|eu) are required",
      });
    }
    const { brandId, projectId, region } = parsed.data;
    try {
      const apiKey = await credentialOr4xx(req, res, POSTHOG_PROVIDER, "PostHog", brandId);
      if (apiKey === null) return;
      let identifiedPersons: number;
      try {
        identifiedPersons = await countIdentifiedPersons(targetOf({ region, projectId }, apiKey));
      } catch (err) {
        if (err instanceof PosthogError) return vendorRefusal(res, "PostHog", err.status, err.vendorMessage);
        throw err;
      }
      const [row] = await db
        .insert(posthogConnections)
        .values({ orgId: req.orgId!, brandId, projectId, region, createdByUserId: req.userId!, status: "active" })
        .onConflictDoUpdate({
          target: [posthogConnections.orgId, posthogConnections.brandId],
          set: { projectId, region, createdByUserId: req.userId!, status: "active", lastError: null },
        })
        .returning();
      res.json({ connection: posthogView(row), identifiedPersons });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/orgs/posthog/connections",
  apiKeyAuth,
  requireOrg("posthog.connections.list"),
  async (req: AuthenticatedRequest, res, next) => {
    const brand = uuid.safeParse(req.query.brandId);
    if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    try {
      const rows = await db
        .select()
        .from(posthogConnections)
        .where(and(eq(posthogConnections.orgId, req.orgId!), eq(posthogConnections.brandId, brand.data)));
      res.json({ connections: rows.map(posthogView) });
    } catch (err) {
      next(err);
    }
  },
);

const patchSchema = z.object({ status: z.enum(["active", "paused"]) });

router.patch(
  "/orgs/posthog/connections/:id",
  apiKeyAuth,
  requireOrg("posthog.connections.update"),
  async (req: AuthenticatedRequest, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    const body = patchSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ type: "validation", error: "status must be active|paused" });
    try {
      const [row] = await db
        .update(posthogConnections)
        .set({ status: body.data.status, lastError: null })
        .where(and(eq(posthogConnections.id, id.data), eq(posthogConnections.orgId, req.orgId!)))
        .returning();
      if (!row) return res.status(404).json({ type: "not_found", error: "connection not found" });
      res.json({ connection: posthogView(row) });
    } catch (err) {
      next(err);
    }
  },
);

/** Disconnect: the row goes, with (by cascade) its mirror and activities, and its silver contacts. */
router.delete(
  "/orgs/posthog/connections/:id",
  apiKeyAuth,
  requireOrg("posthog.connections.delete"),
  async (req: AuthenticatedRequest, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    try {
      const [existing] = await db
        .select()
        .from(posthogConnections)
        .where(and(eq(posthogConnections.id, id.data), eq(posthogConnections.orgId, req.orgId!)));
      if (!existing) return res.status(404).json({ type: "not_found", error: "connection not found" });
      await db
        .delete(contacts)
        .where(and(eq(contacts.sourceConnectionId, existing.id), eq(contacts.source, POSTHOG_SOURCE)));
      await db.delete(posthogConnections).where(eq(posthogConnections.id, existing.id));
      res.json({ disconnected: true, connectionId: existing.id });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Stripe connections ──────────────────────────────────────────────────────

/**
 * Connect one of a brand's Stripe accounts. A brand connects N accounts, each
 * with its own RESTRICTED key stored in key-service under its own provider name
 * (`credentialProvider`: `stripe` for the first, the default, `stripe-<label>`
 * for each further one). Re-posting the same `credentialProvider` re-proves and
 * re-activates THAT connection; another name adds an account.
 *
 * The key needs READ permission on Customers, Charges, Refunds and
 * Subscriptions; a secret key `sk_…` can move money and is refused before any
 * call. It is proven by one read of each resource; a missing permission comes
 * back in Stripe's words. The account it reads is named from Stripe
 * (`GET /v1/account`) when the key may read it. The same account connected
 * twice would count every payment twice: refused (409) on the account id, or
 * when the key's newest objects are already mirrored by another connection.
 */
router.post(
  "/orgs/stripe/connections",
  apiKeyAuth,
  requireOrgAndUser("stripe.connections.create"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z
      .object({ brandId: uuid, credentialProvider: z.string().regex(STRIPE_PROVIDER_PATTERN).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        type: "validation",
        error: "brandId (uuid) is required; credentialProvider, when given, is 'stripe' or 'stripe-<label>' (a-z, 0-9, - _)",
      });
    }
    const { brandId } = parsed.data;
    const credentialProvider = parsed.data.credentialProvider ?? STRIPE_PROVIDER;
    try {
      const key = await credentialOr4xx(req, res, credentialProvider, "Stripe", brandId);
      if (key === null) return;
      const keyMode = restrictedKeyMode(key);
      if (!keyMode) {
        return res.status(400).json({
          type: "validation",
          error:
            "the stored Stripe key is not a restricted key (rk_live_… / rk_test_…). Create a restricted key with READ permission on Customers, Charges, Refunds and Subscriptions and store that one: a secret key can move money and is never accepted.",
        });
      }
      let newest: Record<string, string[]>;
      let account: Awaited<ReturnType<typeof readStripeAccount>>;
      try {
        newest = await verifyStripeAccess(key);
        account = await readStripeAccount(key);
      } catch (err) {
        if (err instanceof StripeError) return vendorRefusal(res, "Stripe", err.status, err.vendorMessage);
        throw err;
      }

      const others = await db
        .select()
        .from(stripeConnections)
        .where(
          and(
            eq(stripeConnections.orgId, req.orgId!),
            eq(stripeConnections.brandId, brandId),
            ne(stripeConnections.credentialProvider, credentialProvider),
          ),
        );
      const sameAccount = account ? others.find((o) => o.accountId === account!.id) : undefined;
      const sampleIds = Object.values(newest).flat();
      const [overlap] =
        !sameAccount && others.length && sampleIds.length
          ? await db
              .select({ connectionId: stripeRawRecords.connectionId })
              .from(stripeRawRecords)
              .where(
                and(
                  inArray(
                    stripeRawRecords.connectionId,
                    others.map((o) => o.id),
                  ),
                  inArray(stripeRawRecords.externalId, sampleIds),
                ),
              )
              .limit(1)
          : [];
      const twin = sameAccount?.id ?? overlap?.connectionId;
      if (twin) {
        return res.status(409).json({
          type: "stripe_account_already_connected",
          error: "This Stripe account is already connected to this brand.",
          connectionId: twin,
        });
      }

      const identity = { accountId: account?.id ?? null, accountName: account?.name ?? null };
      const [row] = await db
        .insert(stripeConnections)
        .values({
          orgId: req.orgId!,
          brandId,
          credentialProvider,
          keyMode,
          ...identity,
          createdByUserId: req.userId!,
          status: "active",
        })
        .onConflictDoUpdate({
          target: [stripeConnections.orgId, stripeConnections.brandId, stripeConnections.credentialProvider],
          set: { keyMode, ...identity, createdByUserId: req.userId!, status: "active", lastError: null },
        })
        .returning();
      res.json({ connection: stripeView(row) });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/orgs/stripe/connections",
  apiKeyAuth,
  requireOrg("stripe.connections.list"),
  async (req: AuthenticatedRequest, res, next) => {
    const brand = uuid.safeParse(req.query.brandId);
    if (!brand.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    try {
      const rows = await db
        .select()
        .from(stripeConnections)
        .where(and(eq(stripeConnections.orgId, req.orgId!), eq(stripeConnections.brandId, brand.data)));
      res.json({ connections: rows.map(stripeView) });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/orgs/stripe/connections/:id",
  apiKeyAuth,
  requireOrg("stripe.connections.update"),
  async (req: AuthenticatedRequest, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    const body = patchSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ type: "validation", error: "status must be active|paused" });
    try {
      const [row] = await db
        .update(stripeConnections)
        .set({ status: body.data.status, lastError: null })
        .where(and(eq(stripeConnections.id, id.data), eq(stripeConnections.orgId, req.orgId!)))
        .returning();
      if (!row) return res.status(404).json({ type: "not_found", error: "connection not found" });
      res.json({ connection: stripeView(row) });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/orgs/stripe/connections/:id",
  apiKeyAuth,
  requireOrg("stripe.connections.delete"),
  async (req: AuthenticatedRequest, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    try {
      const [existing] = await db
        .select()
        .from(stripeConnections)
        .where(and(eq(stripeConnections.id, id.data), eq(stripeConnections.orgId, req.orgId!)));
      if (!existing) return res.status(404).json({ type: "not_found", error: "connection not found" });
      await db
        .delete(contacts)
        .where(and(eq(contacts.sourceConnectionId, existing.id), eq(contacts.source, STRIPE_SOURCE)));
      await db.delete(stripeConnections).where(eq(stripeConnections.id, existing.id));
      res.json({ disconnected: true, connectionId: existing.id });
    } catch (err) {
      next(err);
    }
  },
);

// ─── /internal sync + rebuild (cron, staff) ──────────────────────────────────

const internalBody = z.object({ connectionId: uuid.optional() });

function internalTrigger(
  taskName: string,
  log: string,
  work: (connectionId?: string) => Promise<{ results: unknown[]; failures: unknown[] }>,
) {
  return async (req: AuthenticatedRequest, res: Response) => {
    const parsed = internalBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
    let platformRunId: string;
    try {
      platformRunId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName })).id;
    } catch (err) {
      return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
    }
    res.status(202).json({ status: "accepted", platformRunId });
    setImmediate(async () => {
      try {
        const result = await work(parsed.data.connectionId);
        console.log(`[crm-service][${log}] pass: ${result.results.length} ok, ${result.failures.length} failed`);
        await updatePlatformRun(platformRunId, result.failures.length ? "failed" : "completed", SERVICE_NAME);
      } catch (err) {
        console.error(`[crm-service][${log}] pass crashed:`, err);
        await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
          console.error(`[crm-service][${log}] failed to close trigger run:`, e),
        );
      }
    });
  };
}

router.post(
  "/internal/posthog/sync",
  apiKeyAuth,
  internalTrigger("posthog.sync.trigger", "posthog", runPosthogSyncPass),
);
router.post("/internal/stripe/sync", apiKeyAuth, internalTrigger("stripe.sync.trigger", "stripe", runStripeSyncPass));

/** Re-derive silver from the mirror alone — no vendor call, no credential. Synchronous. */
router.post("/internal/posthog/rebuild", apiKeyAuth, async (req, res, next) => {
  const parsed = internalBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
  try {
    const conns = await db
      .select()
      .from(posthogConnections)
      .where(parsed.data.connectionId ? eq(posthogConnections.id, parsed.data.connectionId) : undefined);
    const results = [];
    for (const conn of conns) results.push({ connectionId: conn.id, ...(await rebuildPosthogFromBronze(conn)) });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

router.post("/internal/stripe/rebuild", apiKeyAuth, async (req, res, next) => {
  const parsed = internalBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
  try {
    const conns = await db
      .select()
      .from(stripeConnections)
      .where(parsed.data.connectionId ? eq(stripeConnections.id, parsed.data.connectionId) : undefined);
    const results = [];
    for (const conn of conns) results.push({ connectionId: conn.id, ...(await rebuildStripeFromBronze(conn)) });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

export default router;
