import { CONNECTION_TAGS, type PersonConnectionTag } from "../lib/people/connection-tags.js";
import { CORRECTION_KINDS, correctionView, listCorrections, stateCorrection, undoCorrection } from "../lib/people/corrections.js";
import { DOMAIN_KINDS } from "../lib/people/organizations.js";
import type { PersonOrganization } from "../lib/people/organizations.js";
import { personIdOfRelationKey, type PersonRelation } from "../lib/people/relations.js";
import { presenceStableKey } from "../lib/people/facts.js";
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
import type { LeadCompanyTags, LeadDisqualification, LeadHumanTags } from "../lib/people/state.js";
import type { PersonRelevance } from "../lib/people/relevance.js";
import { decodeCursor, findPerson, pageOf, readTimeline } from "../lib/people/timeline.js";
import { attachFactIds } from "../lib/people/fact-ids.js";
import { completeItems } from "../lib/people/item-fill.js";
import { readFacts } from "../lib/people/facts.js";
import { findPersonById } from "../lib/people/person-id.js";
import { listMerges, mergeApplied, mergeView, stateMerge, undoMerge } from "../lib/people/merges.js";
import {
  CampaignReachUnavailable,
  cachedCampaignReach,
  cachedOutcomeCounts,
  OUTCOME_STEPS,
  readOutcomePeople,
  type CampaignReach,
  type OutcomeStep,
} from "../lib/people/outcomes.js";
import { LEG_STEPS, listLegReachBrands, parseLegStep, readLegReach } from "../lib/people/leg-reach.js";
import { readLatestMessages } from "../lib/people/latest-messages.js";
import { LatestMessagesRequestSchema } from "../schemas.js";
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

/**
 * The Unibox list's base reads (hidden counts, population, per-source counts) per scope and
 * filter set, reused while the scope's build is the same one: `people` rows are only ever
 * replaced by a build, in the transaction that sets `last_built_at` (DASH-LATENCY-1014: the
 * population read alone was ~0.8 s on 9,890 people). `filters` null (a search) = never reused.
 */
type ListBase = {
  automatedHidden: number;
  groupMembersHidden: number;
  members: { personKey: string; emails: unknown; humanId: string | null }[];
  perSource: { source: string; people: number }[];
};
const LIST_BASE_MAX = 50;
const listBaseCache = new Map<string, ListBase>();

async function listBase(
  scope: { id: string; lastBuiltAt: Date | null },
  filters: string | null,
  read: () => Promise<ListBase>,
): Promise<ListBase> {
  if (filters === null) return read();
  const key = `${scope.id}|${scope.lastBuiltAt?.toISOString() ?? "never"}|${filters}`;
  const hit = listBaseCache.get(key);
  if (hit) return hit;
  const base = await read();
  listBaseCache.set(key, base);
  // Oldest first out (Map keeps insertion order); an old build's entries are never asked again.
  while (listBaseCache.size > LIST_BASE_MAX) listBaseCache.delete(listBaseCache.keys().next().value!);
  return base;
}

/** Test seam: forget the list's cached base reads. */
export function clearListBaseCache(): void {
  listBaseCache.clear();
}

/** A paged timeline read without `limit`: the latest 10 (owner 2026-10-14). */
const TIMELINE_PAGE_DEFAULT = 10;

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
  // People known ONLY as members of the brand's messaging groups, who never wrote a word.
  includeGroupMembers: z.enum(["true", "false"]).optional(),
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
    // Matrix: a DM counterpart or a member of the brand's groups; the groups they are in.
    ...(p.source === "matrix"
      ? { kind: (p.detail.kind as string | undefined) ?? "dm", groups: (p.detail.groups as unknown[] | undefined) ?? [] }
      : {}),
  };
}

/**
 * lead-service's Disqualified mark for the lead the person's state was read from
 * (`stateDetail.disqualification`, relayed verbatim at build). Null when the
 * person is not one of our leads, or lead-service says not disqualified.
 */
function disqualificationOf(row: typeof people.$inferSelect): LeadDisqualification | null {
  if (row.stateSource !== "lead_service") return null;
  const d = (row.stateDetail as { disqualification?: LeadDisqualification | null } | null)?.disqualification;
  return d ?? null;
}

/**
 * lead-service's COMPANY block for that same lead (client, signed up, company
 * Disqualified "not our target"), relayed verbatim at build. Null when the
 * person is not one of our leads or lead-service knows no company for them.
 */
function companyTagsOf(row: typeof people.$inferSelect): LeadCompanyTags | null {
  if (row.stateSource !== "lead_service") return null;
  return (row.stateDetail as { company?: LeadCompanyTags | null } | null)?.company ?? null;
}

/**
 * lead-service's HUMAN block for that same lead (opted out / do not contact,
 * from human-service's facts: every company, every brand), relayed verbatim at
 * build. Null when the person is not one of our leads, or lead-service could
 * not resolve the row's standing.
 */
function humanTagsOf(row: typeof people.$inferSelect): LeadHumanTags | null {
  if (row.stateSource !== "lead_service") return null;
  return (row.stateDetail as { human?: LeadHumanTags | null } | null)?.human ?? null;
}

function personView(row: typeof people.$inferSelect) {
  return {
    // Opaque, stable across rebuilds, no personal data: the id to put in a URL.
    personId: row.personId,
    // The fleet-wide human (human-service) this person IS; null when no email /
    // phone, or human-service has not answered yet (people/humans.ts).
    humanId: row.humanId ?? null,
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
    // lead-service's Disqualified mark, beside the state (never instead of it).
    disqualification: disqualificationOf(row),
    // lead-service's tags at THEIR level (LEAD-REFONTE-1013): the company's
    // (client, signed up, not our target) and the human's (opted out, do not contact).
    companyTags: companyTagsOf(row),
    humanTags: humanTagsOf(row),
    presences: (row.presences as Presence[]).map(presenceView),
    mergeEvidence: row.mergeEvidence as unknown[],
    automated: row.automated,
    automatedVerdict: row.automatedVerdict as { email: string; verdict: string | null; confidence: number | null }[] | null,
    notBusiness: row.notBusiness,
    groupOnly: row.groupOnly,
    // CONNECTION-TAGS-1017: in what capacity the human speaks (people/connection-tags.ts).
    connectionTags: (row.connectionTags as PersonConnectionTag[] | null) ?? [],
    // PERSON-ORGANIZATIONS-1017: the companies the person speaks for, each with its professional tags.
    organizations: (row.organizations as PersonOrganization[] | null) ?? [],
    // PERSON-RELATIONS-1017: the person x capacity rows, each with only its contact points.
    relations: (row.relations as PersonRelation[] | null) ?? [],
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
    const includeGroupMembers = parsed.data.includeGroupMembers === "true";
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
        includeGroupMembers ? sql`true` : eq(people.groupOnly, false),
        offerId ? sql`${people.offerIds} @> ${JSON.stringify([offerId])}::jsonb` : sql`true`,
        q && keys ? searchPredicate(q, keys) : sql`true`,
      );
      // RELATIONSHIP-TAGS-1014: no conversation verdict hides anyone (who a person is
      // to the brand is the `relationship` filter). Kept in the shape for old readers.
      const notBusinessHidden = 0;

      // The hidden counts, the list's own population (source / automated / search applied,
      // family and relationship not: what each family / relationship button would return) and
      // the per-source counts. Read together; without a search, reused until the next build
      // (people rows change only in a build, which moves lastBuiltAt: DASH-LATENCY-1014).
      const { automatedHidden, groupMembersHidden, members, perSource } = await listBase(
        scope,
        q ? null : JSON.stringify([source ?? null, includeAutomated, includeGroupMembers, offerId]),
        async () => {
          const [automated, groupMembers, memberRows, perSourceRows] = await Promise.all([
            includeAutomated
              ? Promise.resolve([{ automatedHidden: 0 }])
              : db
                  .select({ automatedHidden: sql<number>`count(*)::int` })
                  .from(people)
                  .where(
                    and(
                      eq(people.scopeId, scope.id),
                      eq(people.automated, true),
                      // Under a search: the automated people the search WOULD have returned.
                      q && keys ? searchPredicate(q, keys) : sql`true`,
                    ),
                  ),
            includeGroupMembers
              ? Promise.resolve([{ groupMembersHidden: 0 }])
              : db
                  .select({ groupMembersHidden: sql<number>`count(*)::int` })
                  .from(people)
                  .where(
                    and(
                      eq(people.scopeId, scope.id),
                      eq(people.groupOnly, true),
                      includeAutomated ? sql`true` : eq(people.automated, false),
                      q && keys ? searchPredicate(q, keys) : sql`true`,
                    ),
                  ),
            db.select({ personKey: people.personKey, emails: people.emails, humanId: people.humanId }).from(people).where(where),
            db.execute(sql`
              SELECT s AS source, count(*)::int AS people
              FROM people, jsonb_array_elements_text(people.sources) s
              WHERE people.scope_id = ${scope.id} ${includeAutomated ? sql`` : sql`AND people.automated = false`}
                ${includeGroupMembers ? sql`` : sql`AND people.group_only = false`}
              GROUP BY s
            `) as unknown as Promise<{ source: string; people: number }[]>,
          ]);
          return {
            automatedHidden: automated[0].automatedHidden,
            groupMembersHidden: groupMembers[0].groupMembersHidden,
            members: memberRows,
            perSource: perSourceRows,
          };
        },
      );
      const population = members.length;

      // Who each person is to the brand is lead-service's: it serves the Unibox list itself
      // (UNIBOX-FROM-LEAD-1017); this list no longer reads its relationships.
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
      if (fam.ok) {
        for (const m of members) {
          const v = familyOf(m.emails as string[], m.humanId, fam.f);
          if (!v) continue;
          verdicts.set(m.personKey, v);
          familyCounts[v.family] += 1;
        }
      }
      const familyKeys = family ? [...verdicts].filter(([, v]) => v.family === family).map(([k]) => k) : null;
      const keyed = (ks: string[]) => sql`${people.personKey} IN (SELECT jsonb_array_elements_text(${JSON.stringify(ks)}::jsonb))`;
      const listWhere = and(
        where,
        familyKeys ? keyed(familyKeys) : sql`true`,
      );
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

      const [[{ total }], rows] = await Promise.all([
        db.select({ total: sql<number>`count(*)::int` }).from(people).where(listWhere),
        db
          .select()
          .from(people)
          .where(listWhere)
          .orderBy(sql`${people.lastActivityAt} DESC NULLS LAST`, asc(people.personKey))
          .limit(limit)
          .offset(offset),
      ]);

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
        groupMembersHidden,
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
    // PERSON-RELATIONS-1017: one relation of the person (`rel:<personId>:...`): only its contact points' thread.
    relationKey: z.string().min(3).max(200).optional(),
    // Paged read (DASH-LATENCY-1014): the `limit` latest items older than `before`.
    // Neither = the whole thread, unchanged (every writer reads it whole).
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: z.string().min(1).max(2000).optional(),
  })
  .refine((q) => [q.personKey, q.personId, q.relationKey].filter((x) => x !== undefined).length === 1, {
    message: "exactly one of personId (uuid), personKey or relationKey is required",
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
    const { brandId, personKey, relationKey } = parsed.data;
    const personId = parsed.data.personId ?? (relationKey ? personIdOfRelationKey(relationKey) : undefined);
    if (relationKey && !personId) {
      return res.status(400).json({ type: "validation", error: "invalid query: relationKey must be a rel:<personId>:... key this service served" });
    }
    const paged = parsed.data.limit !== undefined || parsed.data.before !== undefined;
    const before = parsed.data.before !== undefined ? decodeCursor(parsed.data.before) : null;
    if (parsed.data.before !== undefined && !before) {
      return res.status(400).json({ type: "validation", error: "invalid query: before must be an olderCursor this route served" });
    }
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
      // A relation's thread = the person's thread read over ONLY that relation's contact points.
      let scoped = person;
      if (relationKey) {
        const relation = ((person.relations as PersonRelation[] | null) ?? []).find((r) => r.relationKey === relationKey);
        if (!relation) {
          return res.status(404).json({
            type: "not_found",
            reason: "relation_not_found",
            error: `person ${person.personId} holds no relation ${relationKey} (its relations are rebuilt with the people index)`,
          });
        }
        const points = new Set(relation.contactPoints.map((c) => c.id));
        scoped = {
          ...person,
          presences: (person.presences as Presence[]).filter((p) => points.has(presenceStableKey(p))),
          emails: relation.emails,
          phones: relation.phones,
        };
      }
      const { scope } = await ensureScope(req.orgId!, brandId, req.userId!);
      const timeline = await readTimeline(
        scope,
        scoped,
        scope.sourceReads as BuildSummary | null,
        { orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId },
        { paged },
      );
      if (paged) {
        const limit = parsed.data.limit ?? TIMELINE_PAGE_DEFAULT;
        const page = pageOf(timeline.items, limit, before);
        // Only the page's items get their heavy part (message text, API answer summary).
        await Promise.all([completeItems(page.items), attachFactIds(req.orgId!, brandId, person.emails as string[], page.items)]);
        return res.json({
          brandId,
          person: personView(person),
          builtAt: person.builtAt.toISOString(),
          sources: timeline.sources,
          itemCount: page.items.length,
          totalItems: page.totalItems,
          page: { limit, before: parsed.data.before ?? null, hasOlder: page.hasOlder, olderCursor: page.olderCursor },
          items: page.items,
        });
      }
      await attachFactIds(req.orgId!, brandId, person.emails as string[], timeline.items);
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

/** lead-service unreadable → 502: all sources without our campaigns would be a lower figure posing as the whole. */
function campaignOutcomesUnavailable(res: Response, err: Error) {
  res.status(502).json({
    type: "upstream",
    reason: "campaign_outcomes_unavailable",
    error: `cannot read the people our campaigns brought to each step: ${err.message}`,
  });
}

/**
 * The people OUR campaigns brought to these steps (lead-service's buckets, cached
 * per brand: outcomes.ts `cachedCampaignReach`). Unreadable → null after answering 502.
 */
async function campaignReachOr502(req: AuthenticatedRequest, res: Response, brandId: string, steps: readonly OutcomeStep[]): Promise<CampaignReach[] | null> {
  try {
    const all = await cachedCampaignReach({ orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId });
    return all.filter((c) => steps.includes(c.step));
  } catch (err) {
    campaignOutcomesUnavailable(res, err as Error);
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
      // Cached per brand (DASH-LATENCY-1014): recomputed only when its inputs moved.
      const steps = await cachedOutcomeCounts({ orgId: req.orgId!, userId: req.userId!, runId: req.runId!, brandId: parsed.data.brandId });
      res.json({ brandId: parsed.data.brandId, scope, steps });
    } catch (err) {
      if (err instanceof CampaignReachUnavailable) return campaignOutcomesUnavailable(res, err);
      next(err);
    }
  },
);

// ─── GET /orgs/people/organizations?brandId= (PERSON-ORGANIZATIONS-1017) ─────

router.get(
  "/orgs/people/organizations",
  apiKeyAuth,
  requireOrgAndUser("people.organizations"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z
      .object({
        brandId: brandIdSchema,
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required; limit 1..1000, offset >= 0" });
    }
    try {
      const { brandId } = parsed.data;
      const limit = parsed.data.limit ?? 100;
      const offset = parsed.data.offset ?? 0;
      const scope = await openScope(req, brandId);
      const links = (await db.execute(sql`
        SELECT o->>'companyId' AS company_id, o->>'domain' AS domain,
               COALESCE((SELECT jsonb_agg(t->>'tag') FROM jsonb_array_elements(o->'tags') t), '[]'::jsonb) AS tags
        FROM people p, jsonb_array_elements(p.organizations) o
        WHERE p.org_id = ${req.orgId!} AND p.brand_id = ${brandId}
      `)) as unknown as { company_id: string; domain: string; tags: string[] }[];
      res.json({ brandId, scope, ...organizationsView(links, limit, offset) });
    } catch (err) {
      next(err);
    }
  },
);

/** PURE: one row per organization, its people and the tags its links carry (an org's tags = the union of its links'). */
export function organizationsView(links: { company_id: string; domain: string; tags: string[] }[], limit: number, offset: number) {
  const byCompany = new Map<string, { companyId: string; domains: Set<string>; people: number; tags: Map<string, number> }>();
  for (const l of links) {
    const o = byCompany.get(l.company_id) ?? { companyId: l.company_id, domains: new Set<string>(), people: 0, tags: new Map<string, number>() };
    o.domains.add(l.domain);
    o.people++;
    for (const t of new Set(l.tags)) o.tags.set(t, (o.tags.get(t) ?? 0) + 1);
    byCompany.set(l.company_id, o);
  }
  const all = [...byCompany.values()]
    .map((o) => ({
      companyId: o.companyId,
      domains: [...o.domains].sort(),
      people: o.people,
      tags: [...o.tags.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, people]) => ({ tag, people })),
    }))
    .sort((a, b) => b.people - a.people || (a.companyId < b.companyId ? -1 : 1));
  return { total: all.length, links: links.length, organizations: all.slice(offset, offset + limit) };
}

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
  // A statement made while a build runs must not wait for the next cron: one more build follows it.
  setImmediate(() => {
    runScopeBuild(scope, { followUp: true }).catch((e) => console.error("[crm-service] people build crashed:", e));
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

// ─── corrections (PEOPLE-CORRECTIONS-1017) ───────────────────────────────────

const correctionBodySchema = z.object({
  brandId: brandIdSchema,
  kind: z.enum(CORRECTION_KINDS),
  personId: z.string().uuid().optional(),
  tag: z.enum(CONNECTION_TAGS).optional(),
  domain: z.string().min(1).max(500).optional(),
  companyId: z.string().uuid().optional(),
  domainKind: z.enum(DOMAIN_KINDS).optional(),
  tags: z.array(z.enum(CONNECTION_TAGS)).max(4).optional(),
  contactPoint: z.string().min(3).max(500).optional(),
  reason: z.string().max(2000).optional(),
});

/**
 * A user corrects what the registry worked out (a tag, a person's company, a domain verdict). Recorded at
 * once, honoured by every rebuild until undone (a human statement wins over Jev); a rebuild starts now.
 */
router.post(
  "/orgs/people/corrections",
  apiKeyAuth,
  requireOrgAndUser("people.correct"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = correctionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: `invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    }
    const { brandId, ...rest } = parsed.data;
    try {
      const outcome = await stateCorrection({ orgId: req.orgId!, brandId, userId: req.userId!, runId: req.runId ?? null, ...rest });
      if (!outcome.ok) {
        const { status, ...body } = outcome.refusal;
        return res.status(status).json({ type: "refused", ...body });
      }
      if (!outcome.duplicate) await kickRebuild(req, brandId);
      res.status(outcome.duplicate ? 200 : 201).json({
        correction: correctionView(outcome.correction),
        duplicate: outcome.duplicate,
        rebuild: outcome.duplicate ? "not_needed" : "started",
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Every correction of the brand, newest first, undone ones included. */
router.get(
  "/orgs/people/corrections",
  apiKeyAuth,
  requireOrgAndUser("people.corrections.list"),
  async (req: AuthenticatedRequest, res, next) => {
    const parsed = z.object({ brandId: brandIdSchema }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ type: "validation", error: "brandId (uuid) query is required" });
    try {
      res.json({ brandId: parsed.data.brandId, corrections: (await listCorrections(req.orgId!, parsed.data.brandId)).map(correctionView) });
    } catch (err) {
      next(err);
    }
  },
);

/** Take a correction back: the automatic answer applies again from the rebuild that starts now. */
router.post(
  "/orgs/people/corrections/:correctionId/undo",
  apiKeyAuth,
  requireOrgAndUser("people.correct.undo"),
  async (req: AuthenticatedRequest, res, next) => {
    const id = z.string().uuid().safeParse(req.params.correctionId);
    const body = z.object({ brandId: brandIdSchema }).safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      return res.status(400).json({ type: "validation", error: "correctionId (uuid) path param and brandId (uuid) body are required" });
    }
    try {
      const outcome = await undoCorrection({ orgId: req.orgId!, brandId: body.data.brandId, correctionId: id.data, userId: req.userId! });
      if (!outcome.ok) {
        const { status, ...rest } = outcome.refusal;
        return res.status(status).json({ type: "refused", ...rest });
      }
      if (!outcome.duplicate) await kickRebuild(req, body.data.brandId);
      res.json({ correction: correctionView(outcome.correction), duplicate: outcome.duplicate, rebuild: outcome.duplicate ? "not_needed" : "started" });
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

// ─── POST /internal/people/relations/latest-messages (lead-service: the Unibox row preview) ──

/**
 * The latest message of each relation's thread, many relations in one read (people/latest-messages.ts).
 * DB-only: no sibling call, no model, no cost. UNIBOX-LAST-MESSAGE-PREVIEW-1021.
 */
router.post("/internal/people/relations/latest-messages", apiKeyAuth, async (req, res) => {
  const parsed = LatestMessagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  await withPlatformRun(res, "people.latest-messages.read", async () => {
    const { orgId, brandId, relationKeys } = parsed.data;
    const out = await readLatestMessages(orgId, brandId, relationKeys);
    res.json({ orgId, brandId, ...out });
  });
});

export default router;
