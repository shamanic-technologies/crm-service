import { Router } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { people } from "../db/schema.js";
import {
  apiKeyAuth,
  requireOrgAndUser,
  SERVICE_NAME,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import { createPlatformRun, updatePlatformRun } from "../lib/runs-client.js";
import { ensureScope, runPeopleBuildPass, runScopeBuild, type BuildSummary } from "../lib/people/build.js";
import { PEOPLE_SOURCES, type Presence } from "../lib/people/identity.js";
import { findPerson, readTimeline } from "../lib/people/timeline.js";

const router = Router();

const brandIdSchema = z.string().uuid();
const listQuerySchema = z.object({
  brandId: brandIdSchema,
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  source: z.enum(PEOPLE_SOURCES).optional(),
});

/** What a consumer needs of one source record, without the source's raw detail. */
function presenceView(p: Presence) {
  return {
    source: p.source,
    sourceRef: p.sourceRef,
    displayName: p.displayName,
    emails: p.emails,
    phones: p.phones,
    firstActivityAt: p.firstActivityAt,
    lastActivityAt: p.lastActivityAt,
    messageCount: p.messageCount,
    inboundCount: p.inboundCount,
    outboundCount: p.outboundCount,
    channel: typeof p.detail.channel === "string" ? p.detail.channel : p.source === "gohighlevel" ? "crm" : "email",
  };
}

function personView(row: typeof people.$inferSelect) {
  return {
    personKey: row.personKey,
    identityKeys: row.identityKeys as string[],
    displayName: row.displayName,
    company: row.company,
    emails: row.emails as string[],
    phones: row.phones as string[],
    sources: row.sources as string[],
    firstActivityAt: row.firstActivityAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
    state: row.state,
    stateSource: row.stateSource,
    stateDetail: row.stateDetail as Record<string, unknown> | null,
    presences: (row.presences as Presence[]).map(presenceView),
    mergeEvidence: row.mergeEvidence as unknown[],
  };
}

function scopeView(scope: { status: string; lastBuiltAt: Date | null; lastError: string | null }, building: boolean) {
  return {
    status: building && scope.status === "pending" ? "building" : scope.status,
    lastBuiltAt: scope.lastBuiltAt?.toISOString() ?? null,
    lastError: scope.lastError,
  };
}

// ─── GET /orgs/people?brandId= ───────────────────────────────────────────────

/**
 * Every person the brand is in conversation with, merged across sources, most
 * recent activity first (total order: last activity, then person key).
 *
 * The first read for a brand opens its people scope (attributed to the calling
 * user, so the cron can rebuild it later) and starts the first build in the
 * background; that read answers `scope.status = "building"` rather than an
 * empty list pretending to be an answer.
 */
router.get(
  "/orgs/people",
  apiKeyAuth,
  requireOrgAndUser("people.list"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: `invalid query: ${parsed.error.message}` });
    }
    const { brandId, source } = parsed.data;
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
    try {
      const { scope, created } = await ensureScope(req.orgId!, brandId, req.userId!);
      const building = created || scope.status === "pending";
      if (created) {
        setImmediate(() => {
          runScopeBuild(scope).catch((e) => console.error("[crm-service] first people build crashed:", e));
        });
      }

      const where = and(
        eq(people.scopeId, scope.id),
        source ? sql`${people.sources} @> ${JSON.stringify([source])}::jsonb` : sql`true`,
      );
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(people).where(where);
      const rows = await db
        .select()
        .from(people)
        .where(where)
        .orderBy(sql`${people.lastActivityAt} DESC NULLS LAST`, asc(people.personKey))
        .limit(limit)
        .offset(offset);

      const perSource = (await db.execute(sql`
        SELECT s AS source, count(*)::int AS people
        FROM people, jsonb_array_elements_text(people.sources) s
        WHERE people.scope_id = ${scope.id}
        GROUP BY s
      `)) as unknown as { source: string; people: number }[];
      const reads = scope.sourceReads as BuildSummary | null;

      res.json({
        brandId,
        scope: scopeView(scope, building),
        sources: PEOPLE_SOURCES.map((s) => {
          const read = reads?.sources.find((r) => r.source === s) ?? null;
          return {
            source: s,
            status: read?.status ?? null,
            scope: read?.scope ?? (s === "gmail" ? "org" : "brand"),
            people: perSource.find((p) => p.source === s)?.people ?? 0,
            presences: read?.presences ?? 0,
            sourceCount: read?.sourceCount ?? null,
            sourceCountBasis: read?.sourceCountBasis ?? null,
            excludedOwn: read?.excludedOwn ?? 0,
            error: read?.error ?? null,
          };
        }),
        mergeEvidence: reads?.evidence ?? [],
        ownAddresses: reads?.ownAddresses ?? null,
        total,
        limit,
        offset,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
        people: rows.map(personView),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /orgs/people/timeline?brandId=&personKey= ───────────────────────────

const timelineQuerySchema = z.object({
  brandId: brandIdSchema,
  personKey: z.string().min(3).max(320),
});

/**
 * One person, every channel merged into one thread, oldest first. `personKey`
 * may be ANY of the person's identity keys (`email:…`, `phone:+…`).
 */
router.get(
  "/orgs/people/timeline",
  apiKeyAuth,
  requireOrgAndUser("people.timeline"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = timelineQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: `invalid query: ${parsed.error.message}` });
    }
    const { brandId, personKey } = parsed.data;
    try {
      const person = await findPerson(req.orgId!, brandId, personKey);
      if (!person) {
        return res.status(404).json({
          type: "not_found",
          reason: "person_not_found",
          error: `no person holds ${personKey} for brand ${brandId} (read GET /orgs/people first; the index is built in the background)`,
        });
      }
      const { scope } = await ensureScope(req.orgId!, brandId, req.userId!);
      const timeline = await readTimeline(person, scope.sourceReads as BuildSummary | null, {
        orgId: req.orgId!,
        userId: req.userId!,
        runId: req.runId!,
        brandId,
      });
      res.json({
        brandId,
        person: personView(person),
        builtAt: person.builtAt.toISOString(),
        sources: timeline.sources,
        itemCount: timeline.items.length,
        items: timeline.items,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /orgs/people/sync ──────────────────────────────────────────────────

router.post(
  "/orgs/people/sync",
  apiKeyAuth,
  requireOrgAndUser("people.sync"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z.object({ brandId: brandIdSchema }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) is required in the body" });
    }
    try {
      const { scope } = await ensureScope(req.orgId!, parsed.data.brandId, req.userId!);
      res.status(202).json({ status: "accepted", scopeId: scope.id });
      setImmediate(() => {
        runScopeBuild(scope).catch((e) => console.error("[crm-service] people build crashed:", e));
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /internal/people/sync (cron) ───────────────────────────────────────

/**
 * Rebuild every people scope (or one). The route's platform run tracks the
 * TRIGGER; each scope's build opens its own ORG run with the scope's creator.
 */
router.post("/internal/people/sync", apiKeyAuth, async (req, res) => {
  const parsed = z.object({ scopeId: z.string().uuid().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "scopeId must be a uuid" });
  }
  let platformRunId: string;
  try {
    const run = await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "people.sync.trigger" });
    platformRunId = run.id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  res.status(202).json({ status: "accepted", platformRunId });
  setImmediate(async () => {
    try {
      const result = await runPeopleBuildPass(parsed.data.scopeId);
      const failed = result.results.filter((r) => !r.ok).length;
      console.log(`[crm-service] people sync pass scopes=${result.scopes} failed=${failed}`);
      await updatePlatformRun(platformRunId, failed ? "failed" : "completed", SERVICE_NAME);
    } catch (err) {
      console.error("[crm-service] people sync pass crashed:", err);
      await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
        console.error("[crm-service] failed to close people sync run:", e),
      );
    }
  });
});

export default router;
