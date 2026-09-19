import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { contacts, ghlConnections } from "../db/schema.js";
import {
  apiKeyAuth,
  requireOrg,
  requireOrgAndUser,
  AuthenticatedRequest,
  SERVICE_NAME,
} from "../middleware/auth.js";
import { GoHighLevelError, verifyAccess } from "../lib/gohighlevel/client.js";
import { CredentialError, resolveGhlToken } from "../lib/gohighlevel/credentials.js";
import { GHL_SOURCE } from "../lib/gohighlevel/records.js";
import { rebuildFromBronze, runSyncPass } from "../lib/gohighlevel/sync.js";
import { readPipelineView } from "../lib/gohighlevel/view.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";

const router = Router();

const brandIdSchema = z.string().uuid();

function toConnectionView(row: typeof ghlConnections.$inferSelect) {
  return {
    id: row.id,
    brandId: row.brandId,
    locationId: row.locationId,
    status: row.status,
    /** True once the connection has completed a sync. */
    synced: row.lastSyncedAt !== null,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    lastRunId: row.lastRunId,
    createdAt: row.createdAt,
  };
}

// ─── POST /orgs/gohighlevel/connections ──────────────────────────────────────

const connectionBodySchema = z.object({
  brandId: z.string().uuid(),
  /** The GoHighLevel sub-account ("location") id the token is bound to. */
  locationId: z.string().min(1),
});

/**
 * Connect a brand to GoHighLevel.
 *
 * The connection is only written once the credential has been PROVEN: the token
 * is resolved from key-service for this exact (org, brand), then used against
 * GoHighLevel itself. A token that cannot authenticate, or one bound to a
 * different sub-account than the id supplied, is refused here — with
 * GoHighLevel's own status and message, not a generic error.
 *
 * Requires x-user-id: the creating user is persisted, because the sync cron has
 * no inbound identity and the org run it opens must still be attributed.
 */
router.post(
  "/orgs/gohighlevel/connections",
  apiKeyAuth,
  requireOrgAndUser("gohighlevel.connections.create"),
  async (req: AuthenticatedRequest, res) => {
    const parsed = connectionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        type: "validation",
        error: "brandId (uuid) and locationId are required",
      });
    }
    const { brandId, locationId } = parsed.data;

    let token: string;
    try {
      token = await resolveGhlToken(brandId, {
        orgId: req.orgId!,
        userId: req.userId!,
        runId: req.runId,
      });
    } catch (err) {
      if (err instanceof CredentialError) {
        return res
          .status(err.status)
          .json({ type: err.kind === "missing" ? "validation" : "upstream", error: err.message });
      }
      throw err;
    }

    try {
      await verifyAccess(token, locationId);
    } catch (err) {
      if (err instanceof GoHighLevelError) {
        // GoHighLevel's own words — the customer needs its reason, not ours.
        return res.status(400).json({
          type: "vendor",
          error: `GoHighLevel refused the credential: ${err.vendorMessage}`,
          vendorStatus: err.status,
          vendorError: err.vendorMessage,
        });
      }
      throw err;
    }

    const [row] = await db
      .insert(ghlConnections)
      .values({
        orgId: req.orgId!,
        brandId,
        locationId,
        createdByUserId: req.userId!,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [ghlConnections.orgId, ghlConnections.brandId],
        set: {
          locationId,
          createdByUserId: req.userId!,
          status: "active",
          lastError: null,
        },
      })
      .returning();

    res.json({ connection: toConnectionView(row) });
  },
);

// ─── PATCH /orgs/gohighlevel/connections/:id ─────────────────────────────────

const connectionPatchSchema = z.object({ status: z.enum(["active", "paused"]) });

/** Pause / resume. A paused connection is skipped by every sync pass. */
router.patch(
  "/orgs/gohighlevel/connections/:id",
  apiKeyAuth,
  requireOrg("gohighlevel.connections.update"),
  async (req: AuthenticatedRequest, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    }
    const parsed = connectionPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "status must be active|paused" });
    }

    const [row] = await db
      .update(ghlConnections)
      .set({ status: parsed.data.status, lastError: null })
      .where(and(eq(ghlConnections.id, idParse.data), eq(ghlConnections.orgId, req.orgId!)))
      .returning();
    if (!row) return res.status(404).json({ type: "not_found", error: "connection not found" });

    res.json({ connection: toConnectionView(row) });
  },
);

// ─── DELETE /orgs/gohighlevel/connections/:id ────────────────────────────────

/**
 * Disconnect. The connection row goes, and with it — by cascade — the mirrored
 * records, the pipelines and the opportunities derived from them. No connection
 * row means no sync: the pass has nothing to iterate.
 *
 * The brand's GoHighLevel-sourced silver contacts are removed in the same
 * statement; they exist only as a projection of that connection's mirror.
 */
router.delete(
  "/orgs/gohighlevel/connections/:id",
  apiKeyAuth,
  requireOrg("gohighlevel.connections.delete"),
  async (req: AuthenticatedRequest, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      return res.status(400).json({ type: "validation", error: "connection id must be a uuid" });
    }

    const [existing] = await db
      .select()
      .from(ghlConnections)
      .where(and(eq(ghlConnections.id, idParse.data), eq(ghlConnections.orgId, req.orgId!)));
    if (!existing) {
      return res.status(404).json({ type: "not_found", error: "connection not found" });
    }

    await db
      .delete(contacts)
      .where(
        and(eq(contacts.sourceConnectionId, existing.id), eq(contacts.source, GHL_SOURCE)),
      );
    await db.delete(ghlConnections).where(eq(ghlConnections.id, existing.id));

    res.json({ disconnected: true, connectionId: existing.id });
  },
);

// ─── GET /orgs/gohighlevel/connections?brandId= ──────────────────────────────

/** Connection health for a brand — is it working, when did it last sync, why not. */
router.get(
  "/orgs/gohighlevel/connections",
  apiKeyAuth,
  requireOrg("gohighlevel.connections.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }

    const rows = await db
      .select()
      .from(ghlConnections)
      .where(
        and(eq(ghlConnections.orgId, req.orgId!), eq(ghlConnections.brandId, brandParse.data)),
      );

    res.json({ connections: rows.map(toConnectionView) });
  },
);

// ─── GET /orgs/gohighlevel/contacts?brandId= ─────────────────────────────────

/** The brand's GoHighLevel contacts, as mirrored. */
router.get(
  "/orgs/gohighlevel/contacts",
  apiKeyAuth,
  requireOrg("gohighlevel.contacts.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Number(req.query.offset) || 0;

    const rows = await db
      .select({
        id: contacts.id,
        brandId: contacts.brandId,
        externalId: contacts.externalId,
        primaryEmail: contacts.primaryEmail,
        phoneE164: contacts.phoneE164,
        fullName: contacts.fullName,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        unsubscribed: contacts.unsubscribed,
        lastRebuiltAt: contacts.lastRebuiltAt,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, req.orgId!),
          eq(contacts.brandId, brandParse.data),
          eq(contacts.source, GHL_SOURCE),
        ),
      )
      .orderBy(asc(contacts.fullName))
      .limit(limit)
      .offset(offset);

    res.json({ contacts: rows });
  },
);

// ─── GET /orgs/gohighlevel/opportunities?brandId= ────────────────────────────

/**
 * The brand's sales pipeline, grouped by pipeline then stage exactly as
 * GoHighLevel groups it. Opportunities whose pipeline is unknown to us are
 * returned under `ungrouped`, so the counts still add up.
 */
router.get(
  "/orgs/gohighlevel/opportunities",
  apiKeyAuth,
  requireOrg("gohighlevel.opportunities.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }

    const view = await readPipelineView(req.orgId!, brandParse.data);
    res.json(view);
  },
);

// ─── POST /internal/gohighlevel/sync ─────────────────────────────────────────

const internalBodySchema = z.object({ connectionId: z.string().uuid().optional() });

/**
 * Run a sync pass — the endpoint the cron on the box hits.
 *
 * The pass opens ONE ORG RUN PER CONNECTION (the work belongs to the org that
 * owns it). This route's own platform run tracks only the trigger, so a
 * runs-service outage fails the request instead of running untracked.
 */
router.post("/internal/gohighlevel/sync", apiKeyAuth, async (req, res) => {
  const parsed = internalBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
  }

  let platformRunId: string;
  try {
    const run = await createPlatformRun({
      serviceName: SERVICE_NAME,
      taskName: "gohighlevel.sync.trigger",
    });
    platformRunId = run.id;
  } catch (err) {
    return res
      .status(502)
      .json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }

  res.status(202).json({ status: "accepted", platformRunId });

  setImmediate(async () => {
    try {
      const result = await runSyncPass(parsed.data.connectionId);
      console.log(
        `[crm-service][ghl] sync pass: ${result.results.length} ok, ${result.failures.length} failed`,
      );
      await updatePlatformRun(
        platformRunId,
        result.failures.length > 0 ? "failed" : "completed",
        SERVICE_NAME,
      );
    } catch (err) {
      console.error("[crm-service][ghl] sync pass failed:", err);
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service][ghl] failed to close trigger run:", e),
      );
    }
  });
});

// ─── POST /internal/gohighlevel/rebuild ──────────────────────────────────────

/**
 * Rebuild silver from BRONZE alone — no GoHighLevel call, no credential.
 * The path that makes the derived layers reproducible after a wipe.
 */
router.post("/internal/gohighlevel/rebuild", apiKeyAuth, async (req, res) => {
  const parsed = internalBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
  }

  let platformRunId: string;
  try {
    const run = await createPlatformRun({
      serviceName: SERVICE_NAME,
      taskName: "gohighlevel.rebuild.trigger",
    });
    platformRunId = run.id;
  } catch (err) {
    return res
      .status(502)
      .json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }

  res.status(202).json({ status: "accepted", platformRunId });

  setImmediate(async () => {
    try {
      const rows = parsed.data.connectionId
        ? await db
            .select()
            .from(ghlConnections)
            .where(eq(ghlConnections.id, parsed.data.connectionId))
        : await db.select().from(ghlConnections);
      for (const conn of rows) {
        await rebuildFromBronze(conn);
      }
      await updatePlatformRun(platformRunId, "completed", SERVICE_NAME);
    } catch (err) {
      console.error("[crm-service][ghl] rebuild failed:", err);
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service][ghl] failed to close rebuild run:", e),
      );
    }
  });
});

export default router;
