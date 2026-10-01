import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { contacts, conversations, matrixConnections, matrixLeads } from "../db/schema.js";
import {
  apiKeyAuth,
  requireOrg,
  requireOrgAndUser,
  AuthenticatedRequest,
  SERVICE_NAME,
} from "../middleware/auth.js";
import { MATRIX_CHANNELS } from "../lib/matrix/events.js";
import { LEAD_STATUSES } from "../lib/matrix/leads.js";
import { rebuildFromBronze, runSyncPass } from "../lib/matrix/sync.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { BridgeError, LINK_METHODS } from "../lib/matrix/bridge.js";
import { LinkUnavailableError, getLinkView, listLinks, startLink, unlink } from "../lib/matrix/link.js";

const router = Router();

const brandIdSchema = z.string().uuid();

// ─── POST /orgs/matrix/connections ───────────────────────────────────────────

const connectionBodySchema = z.object({
  brandId: z.string().uuid(),
  channel: z.enum(MATRIX_CHANNELS),
  /** MXID of the user's OWN bridged account (sender == this → outbound). */
  matrixUserId: z.string().min(1),
  /** Bridge ghost-user MXID prefix that identifies this channel's rooms. */
  counterpartPrefix: z.string().min(1),
});

/**
 * Register (or update) the Matrix connection for a brand + channel.
 *
 * Requires x-user-id: the creator is PERSISTED on the row because the sync cron
 * has no inbound identity headers, and the org run + the chat-service lead
 * reading it triggers must still be billed to this org.
 */
router.post(
  "/orgs/matrix/connections",
  apiKeyAuth,
  requireOrgAndUser("matrix.connections.create"),
  async (req: AuthenticatedRequest, res) => {
    const parsed = connectionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        type: "validation",
        error: `brandId (uuid), channel (${MATRIX_CHANNELS.join("|")}), matrixUserId and counterpartPrefix are required`,
      });
    }
    const body = parsed.data;

    const [row] = await db
      .insert(matrixConnections)
      .values({
        orgId: req.orgId!,
        brandId: body.brandId,
        channel: body.channel,
        matrixUserId: body.matrixUserId,
        counterpartPrefix: body.counterpartPrefix,
        createdByUserId: req.userId!,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [
          matrixConnections.orgId,
          matrixConnections.brandId,
          matrixConnections.channel,
        ],
        set: {
          matrixUserId: body.matrixUserId,
          counterpartPrefix: body.counterpartPrefix,
          createdByUserId: req.userId!,
        },
      })
      .returning();

    res.json({ connection: toConnectionView(row) });
  },
);

// ─── PATCH /orgs/matrix/connections/:id ──────────────────────────────────────

const connectionPatchSchema = z.object({ status: z.enum(["active", "paused"]) });

/** Pause / resume a connection. A paused connection is skipped by the sync pass. */
router.patch(
  "/orgs/matrix/connections/:id",
  apiKeyAuth,
  requireOrg("matrix.connections.update"),
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
      .update(matrixConnections)
      .set({ status: parsed.data.status, lastError: null })
      .where(
        and(eq(matrixConnections.id, idParse.data), eq(matrixConnections.orgId, req.orgId!)),
      )
      .returning();
    if (!row) return res.status(404).json({ type: "not_found", error: "connection not found" });

    res.json({ connection: toConnectionView(row) });
  },
);

// ─── GET /orgs/matrix/connections?brandId= ───────────────────────────────────

function toConnectionView(row: typeof matrixConnections.$inferSelect) {
  return {
    id: row.id,
    brandId: row.brandId,
    channel: row.channel,
    matrixUserId: row.matrixUserId,
    counterpartPrefix: row.counterpartPrefix,
    status: row.status,
    /** True once the connection has a /sync cursor — i.e. it has synced at least once. */
    synced: row.sinceToken !== null,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    lastRunId: row.lastRunId,
    createdAt: row.createdAt,
  };
}

/** Connection health for a brand — what a dashboard shows for "is this live?". */
router.get(
  "/orgs/matrix/connections",
  apiKeyAuth,
  requireOrg("matrix.connections.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }

    const rows = await db
      .select()
      .from(matrixConnections)
      .where(
        and(
          eq(matrixConnections.orgId, req.orgId!),
          eq(matrixConnections.brandId, brandParse.data),
        ),
      )
      .orderBy(matrixConnections.channel);

    res.json({ connections: rows.map(toConnectionView) });
  },
);

// ─── GET /orgs/matrix/leads?brandId= ─────────────────────────────────────────

/**
 * The gold leads list: one row per conversation, carrying the LLM's reading plus
 * the deterministic conversation counters and the contact identity.
 */
router.get(
  "/orgs/matrix/leads",
  apiKeyAuth,
  requireOrg("matrix.leads.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    const statusRaw = req.query.status;
    let status: string | undefined;
    if (statusRaw !== undefined) {
      const statusParse = z.enum(LEAD_STATUSES).safeParse(statusRaw);
      if (!statusParse.success) {
        return res
          .status(400)
          .json({ type: "validation", error: `status must be one of ${LEAD_STATUSES.join("|")}` });
      }
      status = statusParse.data;
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Number(req.query.offset) || 0;

    const filters = [
      eq(matrixLeads.orgId, req.orgId!),
      eq(matrixLeads.brandId, brandParse.data),
    ];
    if (status) filters.push(eq(matrixLeads.status, status));

    const rows = await db
      .select({
        id: matrixLeads.id,
        brandId: matrixLeads.brandId,
        status: matrixLeads.status,
        nextStep: matrixLeads.nextStep,
        estimatedValueUsd: matrixLeads.estimatedValueUsd,
        summary: matrixLeads.summary,
        model: matrixLeads.model,
        computedAt: matrixLeads.computedAt,
        computedThroughEventId: matrixLeads.computedThroughEventId,
        contactId: contacts.id,
        contactName: contacts.fullName,
        channel: conversations.channel,
        channelHandle: contacts.channelHandle,
        phoneE164: contacts.phoneE164,
        conversationId: conversations.id,
        firstMessageAt: conversations.firstMessageAt,
        lastMessageAt: conversations.lastMessageAt,
        messageCount: conversations.messageCount,
        inboundCount: conversations.inboundCount,
        outboundCount: conversations.outboundCount,
      })
      .from(matrixLeads)
      .innerJoin(conversations, eq(conversations.id, matrixLeads.conversationId))
      .innerJoin(contacts, eq(contacts.id, matrixLeads.contactId))
      .where(and(...filters))
      // `id` breaks ties so the order is total and limit/offset paging is stable.
      .orderBy(desc(conversations.lastMessageAt), asc(matrixLeads.id))
      .limit(limit)
      .offset(offset);

    res.json({ leads: rows });
  },
);

// ─── Self-serve linking: /orgs/matrix/links ──────────────────────────────────

const linkStartSchema = z.object({
  brandId: z.string().uuid(),
  channel: z.enum(MATRIX_CHANNELS),
  method: z.enum(LINK_METHODS),
  /** International format (+33612345678). Required for method 'phone'. */
  phoneNumber: z.string().min(1).max(32).optional(),
});

/**
 * Start linking a channel for a brand. Answers with the link once the bridge
 * has produced its first code: a QR (method 'qr') or an 8-character pairing
 * code (method 'phone'). The code refreshes on WhatsApp's schedule — poll
 * `GET /orgs/matrix/links` for the current one and for completion.
 */
router.post(
  "/orgs/matrix/links",
  apiKeyAuth,
  requireOrgAndUser("matrix.links.start"),
  async (req: AuthenticatedRequest, res) => {
    const parsed = linkStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        type: "validation",
        error: `brandId (uuid), channel (${MATRIX_CHANNELS.join("|")}) and method (${LINK_METHODS.join("|")}) are required`,
      });
    }
    const body = parsed.data;
    if (body.method === "phone" && !body.phoneNumber) {
      return res
        .status(400)
        .json({ type: "validation", error: "phoneNumber is required for method 'phone'" });
    }
    const scope = { orgId: req.orgId!, brandId: body.brandId, channel: body.channel };
    try {
      await startLink({
        ...scope,
        method: body.method,
        phoneNumber: body.phoneNumber,
        userId: req.userId!,
        runId: req.runId ?? null,
      });
    } catch (err) {
      if (err instanceof LinkUnavailableError) {
        return res.status(409).json({
          type: "channel_unavailable",
          channel: err.channel,
          error: err.reason,
        });
      }
      if (err instanceof BridgeError) {
        return res.status(err.isRefusal ? 422 : 502).json({
          type: "bridge",
          error: err.bridgeMessage,
          bridgeStatus: err.status,
          bridgeError: { code: err.code, message: err.bridgeMessage },
          link: await getLinkView(scope),
        });
      }
      throw err;
    }
    res.json({ link: await getLinkView(scope) });
  },
);

/** Every channel of a brand: availability, link status, the CURRENT code. Poll this. */
router.get(
  "/orgs/matrix/links",
  apiKeyAuth,
  requireOrg("matrix.links.list"),
  async (req: AuthenticatedRequest, res) => {
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    res.json({ links: await listLinks(req.orgId!, brandParse.data) });
  },
);

/**
 * Unlink a channel: the bridge logs the account out, syncing stops, and
 * everything mirrored for it is deleted. Its people leave the person layer on
 * the next build (one is started right away).
 */
router.delete(
  "/orgs/matrix/links/:channel",
  apiKeyAuth,
  requireOrg("matrix.links.unlink"),
  async (req: AuthenticatedRequest, res) => {
    const channelParse = z.enum(MATRIX_CHANNELS).safeParse(req.params.channel);
    if (!channelParse.success) {
      return res
        .status(400)
        .json({ type: "validation", error: `channel must be one of ${MATRIX_CHANNELS.join("|")}` });
    }
    const brandParse = brandIdSchema.safeParse(req.query.brandId);
    if (!brandParse.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    const scope = { orgId: req.orgId!, brandId: brandParse.data, channel: channelParse.data };
    let result;
    try {
      result = await unlink(scope);
    } catch (err) {
      if (err instanceof BridgeError) {
        return res.status(502).json({
          type: "bridge",
          error: err.bridgeMessage,
          bridgeStatus: err.status,
          bridgeError: { code: err.code, message: err.bridgeMessage },
        });
      }
      throw err;
    }
    if (!result) return res.status(404).json({ type: "not_found", error: "no link for this brand and channel" });
    res.json({ ...result, link: await getLinkView(scope) });
  },
);

// ─── POST /internal/matrix/sync ──────────────────────────────────────────────

const internalBodySchema = z.object({ connectionId: z.string().uuid().optional() });

/**
 * Run a sync pass — the endpoint the 5-minute cron on the box hits.
 *
 * The pass itself opens ONE ORG RUN PER CONNECTION (the spend belongs to the org
 * that owns the connection). This route's own platform run tracks only the
 * trigger, so a runs-service outage fails the request instead of running
 * untracked.
 */
router.post("/internal/matrix/sync", apiKeyAuth, async (req, res) => {
  const parsed = internalBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
  }

  let platformRunId: string;
  try {
    const run = await createPlatformRun({
      serviceName: SERVICE_NAME,
      taskName: "matrix.sync.trigger",
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
        `[crm-service][matrix] sync pass: ${result.results.length} ok, ${result.failures.length} failed`,
      );
      await updatePlatformRun(
        platformRunId,
        result.failures.length > 0 ? "failed" : "completed",
        SERVICE_NAME,
      );
    } catch (err) {
      console.error("[crm-service][matrix] sync pass failed:", err);
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service][matrix] failed to close trigger run:", e),
      );
    }
  });
});

// ─── POST /internal/matrix/rebuild ───────────────────────────────────────────

/**
 * Rebuild silver + gold from BRONZE alone, no /sync call — the "truncate the
 * leads table and reproduce it" path, for schema or prompt changes.
 */
router.post("/internal/matrix/rebuild", apiKeyAuth, async (req, res) => {
  const parsed = internalBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "connectionId must be a uuid" });
  }

  let platformRunId: string;
  try {
    const run = await createPlatformRun({
      serviceName: SERVICE_NAME,
      taskName: "matrix.rebuild.trigger",
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
      const where = parsed.data.connectionId
        ? eq(matrixConnections.id, parsed.data.connectionId)
        : undefined;
      const rows = where
        ? await db.select().from(matrixConnections).where(where)
        : await db.select().from(matrixConnections);
      for (const conn of rows) {
        await rebuildFromBronze(conn);
      }
      await updatePlatformRun(platformRunId, "completed", SERVICE_NAME);
    } catch (err) {
      console.error("[crm-service][matrix] rebuild failed:", err);
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service][matrix] failed to close rebuild run:", e),
      );
    }
  });
});

export default router;
