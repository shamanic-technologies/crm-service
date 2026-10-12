import { Router, type Response } from "express";
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
import type { PossibleLead } from "../lib/people/sources.js";
import type { PersonRelevance } from "../lib/people/relevance.js";
import { findPerson, readTimeline } from "../lib/people/timeline.js";
import { readFacts } from "../lib/people/facts.js";
import { findPersonById } from "../lib/people/person-id.js";
import { listMerges, mergeApplied, mergeView, stateMerge, undoMerge } from "../lib/people/merges.js";
import { OUTCOME_STEPS, readCampaignReach, readOutcomeCounts, readOutcomePeople, type CampaignReach, type OutcomeStep } from "../lib/people/outcomes.js";
import { LEG_STEPS, listLegReachBrands, parseLegStep, readLegReach } from "../lib/people/leg-reach.js";
import { familyOf, LEAD_FAMILIES, readBrandFamilies, type FamilyVerdict, type LeadFamily } from "../lib/people/families.js";
import {
  matchesOf,
  messageHitsFor,
  messageIndexCoverage,
  messageMatchKeys,
  searchPredicate,
  SEARCH_MAX_LENGTH,
} from "../lib/people/search.js";

const router = Router();

const brandIdSchema = z.string().uuid();
const listQuerySchema = z.object({
  brandId: brandIdSchema,
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  source: z.enum(PEOPLE_SOURCES).optional(),
  // Automated senders (Jev-judged digests, notifications, no-replies) are hidden unless asked for.
  includeAutomated: z.enum(["true", "false"]).optional(),
  // Personal-channel people Jev judged not about this brand (personal life, another
  // business) are hidden unless asked for (people/relevance.ts).
  includeNotBusiness: z.enum(["true", "false"]).optional(),
  // Only people with a conversation Jev tied to this offer of the brand.
  offerId: z.string().uuid().optional(),
  // Search: name, any email / phone, company, and what was said in their messages.
  // Blank (or absent) = the plain list, unchanged.
  q: z.string().max(SEARCH_MAX_LENGTH).optional(),
  // Unibox family filter (features-service's verdict on our lead). Absent = All.
  family: z.enum(LEAD_FAMILIES).optional(),
});

const PRESENCE_CHANNEL: Partial<Record<Presence["source"], string>> = {
  gohighlevel: "crm",
  posthog: "web",
  stripe: "payment",
};

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
    channel: typeof p.detail.channel === "string" ? p.detail.channel : PRESENCE_CHANNEL[p.source] ?? "email",
  };
}

function personView(row: typeof people.$inferSelect) {
  return {
    // Opaque, stable across rebuilds, no personal data: the id to put in a URL.
    personId: row.personId,
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
    automated: row.automated,
    automatedVerdict: row.automatedVerdict as { email: string; verdict: string | null; confidence: number | null }[] | null,
    notBusiness: row.notBusiness,
    offerIds: row.offerIds as string[],
    relevance: row.relevance as PersonRelevance["relevance"],
    possibleLeads: row.possibleLeads as PossibleLead[],
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
    const { brandId, source, family } = parsed.data;
    const includeAutomated = parsed.data.includeAutomated === "true";
    const includeNotBusiness = parsed.data.includeNotBusiness === "true";
    const offerId = parsed.data.offerId ?? null;
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
    const q = parsed.data.q?.trim() || null;
    try {
      const { scope, created } = await ensureScope(req.orgId!, brandId, req.userId!);
      const building = created || scope.status === "pending";
      if (created) {
        setImmediate(() => {
          runScopeBuild(scope).catch((e) => console.error("[crm-service] first people build crashed:", e));
        });
      }

      const startedAt = Date.now();
      const familiesRead = readBrandFamilies({ orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId }).then(
        (f) => ({ ok: true as const, f }),
        (err: Error) => ({ ok: false as const, error: err.message }),
      );
      const keys = q ? await messageMatchKeys(scope.id, req.orgId!, brandId, q) : null;
      const where = and(
        eq(people.scopeId, scope.id),
        source ? sql`${people.sources} @> ${JSON.stringify([source])}::jsonb` : sql`true`,
        includeAutomated ? sql`true` : eq(people.automated, false),
        includeNotBusiness ? sql`true` : eq(people.notBusiness, false),
        offerId ? sql`${people.offerIds} @> ${JSON.stringify([offerId])}::jsonb` : sql`true`,
        q && keys ? searchPredicate(q, keys) : sql`true`,
      );
      const [{ automatedHidden }] = includeAutomated
        ? [{ automatedHidden: 0 }]
        : await db
            .select({ automatedHidden: sql<number>`count(*)::int` })
            .from(people)
            .where(
              and(
                eq(people.scopeId, scope.id),
                eq(people.automated, true),
                // Under a search: the automated people the search WOULD have returned.
                q && keys ? searchPredicate(q, keys) : sql`true`,
              ),
            );
      const [{ notBusinessHidden }] = includeNotBusiness
        ? [{ notBusinessHidden: 0 }]
        : await db
            .select({ notBusinessHidden: sql<number>`count(*)::int` })
            .from(people)
            .where(
              and(
                eq(people.scopeId, scope.id),
                eq(people.notBusiness, true),
                includeAutomated ? sql`true` : eq(people.automated, false),
                q && keys ? searchPredicate(q, keys) : sql`true`,
              ),
            );

      // Families: counted over the list's own population (source / automated / search
      // applied, family not), so each button shows what it would return.
      const fam = await familiesRead;
      if (family && !fam.ok) {
        return res.status(502).json({
          type: "upstream",
          reason: "lead_families_unavailable",
          error: `cannot filter on family "${family}": ${fam.error}`,
        });
      }
      const verdicts = new Map<string, FamilyVerdict>();
      const familyCounts = Object.fromEntries(LEAD_FAMILIES.map((f) => [f, 0])) as Record<LeadFamily, number>;
      let population = 0;
      if (fam.ok) {
        const members = await db.select({ personKey: people.personKey, emails: people.emails }).from(people).where(where);
        population = members.length;
        for (const m of members) {
          const v = familyOf(m.emails as string[], fam.f.byEmail);
          if (!v) continue;
          verdicts.set(m.personKey, v);
          familyCounts[v.family] += 1;
        }
      }
      const familyKeys = family ? [...verdicts].filter(([, v]) => v.family === family).map(([k]) => k) : null;
      const listWhere = familyKeys
        ? and(where, sql`${people.personKey} IN (SELECT jsonb_array_elements_text(${JSON.stringify(familyKeys)}::jsonb))`)
        : where;
      const withFamily = verdicts.size;
      const families = fam.ok
        ? {
            status: "ok" as const,
            error: null,
            filter: family ?? null,
            counts: familyCounts,
            lostBreakdown: {
              wentCold: [...verdicts.values()].filter((v) => v.lostReason === "went_cold").length,
              ruledOut: [...verdicts.values()].filter((v) => v.lostReason === "ruled_out").length,
            },
            withFamily,
            withoutFamily: population - withFamily,
            producerCounts: fam.f.producerCounts,
            readAt: fam.f.readAt,
          }
        : {
            status: "failed" as const,
            error: fam.error,
            filter: null,
            counts: null,
            lostBreakdown: null,
            withFamily: null,
            withoutFamily: null,
            producerCounts: null,
            readAt: null,
          };

      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(people).where(listWhere);
      const rows = await db
        .select()
        .from(people)
        .where(listWhere)
        .orderBy(sql`${people.lastActivityAt} DESC NULLS LAST`, asc(people.personKey))
        .limit(limit)
        .offset(offset);

      const perSource = (await db.execute(sql`
        SELECT s AS source, count(*)::int AS people
        FROM people, jsonb_array_elements_text(people.sources) s
        WHERE people.scope_id = ${scope.id} ${includeAutomated ? sql`` : sql`AND people.automated = false`}
          ${includeNotBusiness ? sql`` : sql`AND people.not_business = false`}
        GROUP BY s
      `)) as unknown as { source: string; people: number }[];
      const reads = scope.sourceReads as BuildSummary | null;

      let search: { q: string; messageIndex: Awaited<ReturnType<typeof messageIndexCoverage>>; tookMs: number } | null = null;
      let matches: ReturnType<typeof matchesOf>[] = [];
      if (q && keys) {
        const pageEmails = rows.flatMap((r) => r.emails as string[]).filter((e) => keys.addresses.includes(e));
        const pageConvs = rows
          .flatMap((r) => r.presences as Presence[])
          .filter((p) => p.source === "matrix" && typeof p.detail.conversationId === "string")
          .map((p) => p.detail.conversationId as string)
          .filter((c) => keys.conversationIds.includes(c));
        const hits = await messageHitsFor(scope.id, q, pageEmails, pageConvs);
        matches = rows.map((r) =>
          matchesOf(
            {
              displayName: r.displayName,
              company: r.company,
              emails: r.emails as string[],
              phones: r.phones as string[],
              presences: r.presences as Presence[],
            },
            q,
            hits,
          ),
        );
        search = { q, messageIndex: await messageIndexCoverage(scope.id), tookMs: Date.now() - startedAt };
      }

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
        senderVerdicts: reads?.senderVerdicts ?? null,
        automatedHidden,
        relevance: reads?.relevance ?? null,
        notBusinessHidden,
        offerId,
        total,
        limit,
        offset,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
        ...(search ? { search } : {}),
        families,
        people: rows.map((r, i) => ({
          ...personView(r),
          // null = not one of our leads, OR the family read failed (`families.status` says which).
          family: verdicts.get(r.personKey)?.family ?? null,
          familyLostReason: verdicts.get(r.personKey)?.lostReason ?? null,
          ...(search ? matches[i] : {}),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /orgs/people/timeline?brandId=&personKey= ───────────────────────────

const timelineQuerySchema = z
  .object({
    brandId: brandIdSchema,
    personKey: z.string().min(3).max(320).optional(),
    personId: z.string().uuid().optional(),
  })
  .refine((q) => (q.personKey === undefined) !== (q.personId === undefined), {
    message: "exactly one of personId (uuid) or personKey is required",
  });

/**
 * One person, every channel merged into one thread, oldest first. The person is
 * named by `personId` (the opaque id served on every person, stable across
 * rebuilds; a retired id still opens the person it merged into) or by
 * `personKey`, ANY of the person's identity keys (`email:…`, `phone:+…`).
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
    const { brandId, personKey, personId } = parsed.data;
    try {
      const person = personId
        ? await findPersonById(req.orgId!, brandId, personId)
        : await findPerson(req.orgId!, brandId, personKey!);
      if (!person) {
        return res.status(404).json({
          type: "not_found",
          reason: "person_not_found",
          error: `no person holds ${personId ? `id ${personId}` : personKey} for brand ${brandId} (read GET /orgs/people first; the index is built in the background)`,
        });
      }
      const { scope } = await ensureScope(req.orgId!, brandId, req.userId!);
      const timeline = await readTimeline(scope, person, scope.sourceReads as BuildSummary | null, {
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

// ─── GET /orgs/people/outcomes ───────────────────────────────────────────────

/** Opens the scope on a brand's first read (like GET /orgs/people), so the fact feed starts filling. */
async function openScope(req: AuthenticatedRequest, brandId: string) {
  const { scope, created } = await ensureScope(req.orgId!, brandId, req.userId!);
  if (created) {
    setImmediate(() => {
      runScopeBuild(scope).catch((e) => console.error("[crm-service] first people build crashed:", e));
    });
  }
  return scopeView(scope, created || scope.status === "pending");
}

/**
 * The people OUR campaigns brought to these steps (lead-service's buckets).
 * Unreadable → null after answering 502: all sources without our campaigns
 * would be a lower figure posing as the whole.
 */
async function campaignReachOr502(req: AuthenticatedRequest, res: Response, brandId: string, steps: readonly OutcomeStep[]): Promise<CampaignReach[] | null> {
  try {
    return await readCampaignReach({ orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId }, steps);
  } catch (err) {
    res.status(502).json({
      type: "upstream",
      reason: "campaign_outcomes_unavailable",
      error: `cannot read the people our campaigns brought to each step: ${(err as Error).message}`,
    });
    return null;
  }
}

/** Per outcome step, distinct people of the brand who reached it, any source (people/outcomes.ts). */
router.get(
  "/orgs/people/outcomes",
  apiKeyAuth,
  requireOrgAndUser("people.outcomes"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z.object({ brandId: brandIdSchema }).safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    try {
      const scope = await openScope(req, parsed.data.brandId);
      const campaigns = await campaignReachOr502(req, res, parsed.data.brandId, OUTCOME_STEPS);
      if (!campaigns) return;
      const steps = await readOutcomeCounts(req.orgId!, parsed.data.brandId, campaigns);
      res.json({ brandId: parsed.data.brandId, scope, steps });
    } catch (err) {
      next(err);
    }
  },
);

const outcomePeopleQuerySchema = z.object({
  brandId: brandIdSchema,
  step: z.enum(OUTCOME_STEPS),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** The people who reached one step, earliest first; pages to exactly that step's count. */
router.get(
  "/orgs/people/outcomes/people",
  apiKeyAuth,
  requireOrgAndUser("people.outcomes.people"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = outcomePeopleQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: `invalid query: ${parsed.error.message}` });
    }
    const { brandId, step } = parsed.data;
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
    try {
      await openScope(req, brandId);
      const campaigns = await campaignReachOr502(req, res, brandId, [step]);
      if (!campaigns) return;
      const page = await readOutcomePeople(req.orgId!, brandId, step, limit, offset, campaigns);
      res.json({ brandId, step, total: page.total, limit, offset, people: page.people });
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

// ─── Stated merges: two people of a brand are one human ──────────────────────

/** Rebuild the brand's people in the background so a statement shows on the next read. */
async function kickRebuild(req: AuthenticatedRequest, brandId: string) {
  const { scope } = await ensureScope(req.orgId!, brandId, req.userId!);
  setImmediate(() => {
    runScopeBuild(scope).catch((e) => console.error("[crm-service] people build crashed:", e));
  });
}

const mergeBodySchema = z.object({
  brandId: brandIdSchema,
  personIds: z.tuple([z.string().uuid(), z.string().uuid()]),
  reason: z.string().trim().min(1).max(1000).optional(),
});

/**
 * State that two people of the brand are the same human (people/merges.ts). The
 * statement is recorded at once and honoured by every rebuild until undone; a
 * rebuild starts now, so the merged person shows on the next read (~1 min).
 */
router.post(
  "/orgs/people/merges",
  apiKeyAuth,
  requireOrgAndUser("people.merge"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = mergeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: `invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    }
    const { brandId, personIds, reason } = parsed.data;
    try {
      const outcome = await stateMerge({
        orgId: req.orgId!,
        brandId,
        personIds,
        reason: reason ?? null,
        userId: req.userId!,
        runId: req.runId ?? null,
      });
      if (!outcome.ok) {
        const { status, ...body } = outcome.refusal;
        return res.status(status).json({ type: "refused", ...body });
      }
      if (!outcome.duplicate) await kickRebuild(req, brandId);
      res.status(outcome.duplicate ? 200 : 201).json({
        merge: mergeView(outcome.merge),
        duplicate: outcome.duplicate,
        ...(await mergeApplied(outcome.merge)),
        rebuild: outcome.duplicate ? "not_needed" : "started",
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Every statement of the brand, newest first, each with whether the latest build applied it. */
router.get(
  "/orgs/people/merges",
  apiKeyAuth,
  requireOrgAndUser("people.merges.list"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z.object({ brandId: brandIdSchema }).safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    }
    try {
      const rows = await listMerges(req.orgId!, parsed.data.brandId);
      const merges = await Promise.all(rows.map(async (m) => ({ ...mergeView(m), ...(m.undoneAt ? { applied: null, personId: null } : await mergeApplied(m)) })));
      res.json({ brandId: parsed.data.brandId, merges });
    } catch (err) {
      next(err);
    }
  },
);

/** Take a statement back: each person gets their own id back; a rebuild starts now. */
router.post(
  "/orgs/people/merges/:mergeId/undo",
  apiKeyAuth,
  requireOrgAndUser("people.merge.undo"),
  async (req: AuthenticatedRequest, res, next) => {
    const mergeId = z.string().uuid().safeParse(req.params.mergeId);
    const body = z.object({ brandId: brandIdSchema }).safeParse(req.body ?? {});
    if (!mergeId.success || !body.success) {
      return res.status(400).json({ type: "validation", error: "mergeId (uuid) path param and brandId (uuid) body are required" });
    }
    try {
      const outcome = await undoMerge({
        orgId: req.orgId!,
        brandId: body.data.brandId,
        mergeId: mergeId.data,
        userId: req.userId!,
        runId: req.runId ?? null,
      });
      if (!outcome.ok) {
        const { status, ...rest } = outcome.refusal;
        return res.status(status).json({ type: "refused", ...rest });
      }
      if (!outcome.duplicate) await kickRebuild(req, body.data.brandId);
      res.json({ merge: mergeView(outcome.merge), duplicate: outcome.duplicate, rebuild: outcome.duplicate ? "not_needed" : "started" });
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

// ─── GET /internal/people/facts (lead-service pulls the fact feed) ──────────

const factsQuerySchema = z.object({
  since: z
    .string()
    .regex(/^\d+$/, "since must be a cursor returned by this route (digits)")
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  orgId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
});

/**
 * The fact feed after `since` (exclusive), in feed order. Read-only and
 * DB-only (no cost); its own platform run, like every internal route.
 */
router.get("/internal/people/facts", apiKeyAuth, async (req, res) => {
  const parsed = factsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: parsed.error.issues.map((i) => i.message).join("; ") });
  }
  let platformRunId: string;
  try {
    const run = await createPlatformRun({ serviceName: SERVICE_NAME, taskName: "people.facts.read" });
    platformRunId = run.id;
  } catch (err) {
    return res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
  }
  try {
    const { since, limit, orgId, brandId } = parsed.data;
    const page = await readFacts({ since: since ? Number(since) : 0, limit: limit ?? 500, orgId, brandId });
    await updatePlatformRun(platformRunId, "completed", SERVICE_NAME);
    res.json(page);
  } catch (err) {
    console.error("[crm-service] people facts read failed:", err);
    await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
      console.error("[crm-service] failed to close people facts run:", e),
    );
    res.status(500).json({ type: "internal", error: (err as Error).message });
  }
});

// ─── GET /internal/people/leg-reach (features-service: the brand's own team per leg) ──

/** One platform run around a read-only internal handler; failures answer 500 and fail the run. */
async function withPlatformRun(res: Response, taskName: string, handler: () => Promise<void>) {
  let platformRunId: string;
  try {
    platformRunId = (await createPlatformRun({ serviceName: SERVICE_NAME, taskName })).id;
  } catch (err) {
    res.status(502).json({ type: "upstream", error: `run tracking unavailable: ${(err as Error).message}` });
    return;
  }
  try {
    await handler();
    await updatePlatformRun(platformRunId, "completed", SERVICE_NAME);
  } catch (err) {
    console.error(`[crm-service] ${taskName} failed:`, err);
    await updatePlatformRun(platformRunId, "failed", SERVICE_NAME).catch((e) =>
      console.error(`[crm-service] failed to close ${taskName} run:`, e),
    );
    if (!res.headersSent) res.status(500).json({ type: "internal", error: (err as Error).message });
  }
}

/**
 * Of the brand's people who reached FROM and whom our campaigns never
 * contacted, how many reached TO, dated per UTC day (people/leg-reach.ts).
 * Never opens a scope; DB-only, no cost.
 */
router.get("/internal/people/leg-reach", apiKeyAuth, async (req, res) => {
  const brand = brandIdSchema.safeParse(req.query.brandId);
  if (!brand.success) {
    return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
  }
  let orgId: string | null = null;
  if (req.query.orgId !== undefined) {
    const org = z.string().uuid().safeParse(req.query.orgId);
    if (!org.success) return res.status(400).json({ type: "validation", error: "orgId must be a uuid" });
    orgId = org.data;
  }
  const from = parseLegStep(req.query.from);
  const to = parseLegStep(req.query.to);
  if (!from || !to) {
    return res.status(400).json({ type: "validation", error: `from and to are required, one of: ${LEG_STEPS.join(", ")}` });
  }
  if (from === to) return res.status(400).json({ type: "validation", error: "from and to must differ" });
  await withPlatformRun(res, "people.leg-reach.read", async () => {
    const out = await readLegReach(brand.data, orgId, from, to);
    if (out.status === "ambiguous") {
      res.status(409).json({
        type: "ambiguous",
        error: `${out.orgIds.length} orgs hold people for brand ${brand.data}; pass orgId`,
        orgIds: out.orgIds,
      });
      return;
    }
    const { status: _status, ...body } = out;
    res.json({ brandId: brand.data, fromStep: from, toStep: to, ...body });
  });
});

/** Every (org, brand) the leg read can be asked about, with the steps each can answer. */
router.get("/internal/people/leg-reach/brands", apiKeyAuth, async (_req, res) => {
  await withPlatformRun(res, "people.leg-reach.brands", async () => {
    res.json({ steps: LEG_STEPS, brands: await listLegReachBrands() });
  });
});

export default router;
