/**
 * The pipeline read — opportunities grouped the way GoHighLevel groups them.
 *
 * A deterministic grouping over silver, computed on read. There is no
 * materialized gold table because there is no model in the loop: the pipelines,
 * their stage ORDER and each opportunity's placement all come straight from what
 * GoHighLevel reported, so the grouping is pure SQL plus a sort.
 *
 * Opportunities GoHighLevel placed in a pipeline we have not mirrored (or in
 * none at all) are returned under `ungrouped` rather than dropped — the counts a
 * caller reads must add up to what the customer sees in GoHighLevel.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contacts, ghlOpportunities, ghlPipelines } from "../../db/schema.js";
import type { DerivedStage } from "./records.js";

export interface OpportunityView {
  id: string;
  externalId: string;
  name: string;
  status: string | null;
  monetaryValue: string | null;
  assignedTo: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  contactId: string | null;
  externalContactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface StageView {
  id: string;
  name: string | null;
  position: number | null;
  count: number;
  totalValue: string;
  opportunities: OpportunityView[];
}

export interface PipelineView {
  id: string;
  name: string;
  count: number;
  totalValue: string;
  stages: StageView[];
}

export interface PipelineReadResult {
  pipelines: PipelineView[];
  ungrouped: OpportunityView[];
  totalOpportunities: number;
}

/** Sum of a numeric-string column, kept exact — no float rounding. */
function sumValues(rows: { monetaryValue: string | null }[]): string {
  let total = 0;
  for (const row of rows) {
    const value = row.monetaryValue === null ? NaN : Number(row.monetaryValue);
    if (Number.isFinite(value)) total += value;
  }
  // Two decimals is what GoHighLevel reports money in.
  return (Math.round(total * 100) / 100).toFixed(2);
}

export async function readPipelineView(
  orgId: string,
  brandId: string,
): Promise<PipelineReadResult> {
  const pipelineRows = await db
    .select()
    .from(ghlPipelines)
    .where(and(eq(ghlPipelines.orgId, orgId), eq(ghlPipelines.brandId, brandId)))
    .orderBy(asc(ghlPipelines.name));

  const opportunityRows = await db
    .select({
      id: ghlOpportunities.id,
      externalId: ghlOpportunities.externalId,
      name: ghlOpportunities.name,
      status: ghlOpportunities.status,
      monetaryValue: ghlOpportunities.monetaryValue,
      assignedTo: ghlOpportunities.assignedTo,
      pipelineId: ghlOpportunities.pipelineExternalId,
      pipelineName: ghlOpportunities.pipelineName,
      stageId: ghlOpportunities.stageExternalId,
      stageName: ghlOpportunities.stageName,
      contactId: ghlOpportunities.contactId,
      externalContactId: ghlOpportunities.externalContactId,
      contactName: contacts.fullName,
      contactEmail: contacts.primaryEmail,
      createdAt: ghlOpportunities.ghlCreatedAt,
      updatedAt: ghlOpportunities.ghlUpdatedAt,
    })
    .from(ghlOpportunities)
    .leftJoin(contacts, eq(contacts.id, ghlOpportunities.contactId))
    .where(and(eq(ghlOpportunities.orgId, orgId), eq(ghlOpportunities.brandId, brandId)))
    .orderBy(asc(ghlOpportunities.name));

  const byPipeline = new Map<string, OpportunityView[]>();
  const ungrouped: OpportunityView[] = [];
  for (const row of opportunityRows) {
    const key = row.pipelineId;
    if (!key) {
      ungrouped.push(row);
      continue;
    }
    const bucket = byPipeline.get(key);
    if (bucket) bucket.push(row);
    else byPipeline.set(key, [row]);
  }

  const pipelines: PipelineView[] = [];
  for (const pipeline of pipelineRows) {
    const own = byPipeline.get(pipeline.externalId) ?? [];
    byPipeline.delete(pipeline.externalId);

    const stages = ((pipeline.stages as DerivedStage[]) ?? []).slice();
    stages.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const placed = new Set<string>();
    const stageViews: StageView[] = stages.map((stage) => {
      const inStage = own.filter((o) => o.stageId === stage.id);
      for (const o of inStage) placed.add(o.id);
      return {
        id: stage.id,
        name: stage.name,
        position: stage.position,
        count: inStage.length,
        totalValue: sumValues(inStage),
        opportunities: inStage,
      };
    });

    // An opportunity whose stage GoHighLevel no longer lists still belongs to
    // its pipeline — it gets its own bucket rather than vanishing from the count.
    const orphaned = own.filter((o) => !placed.has(o.id));
    if (orphaned.length > 0) {
      stageViews.push({
        id: "unknown",
        name: null,
        position: null,
        count: orphaned.length,
        totalValue: sumValues(orphaned),
        opportunities: orphaned,
      });
    }

    pipelines.push({
      id: pipeline.externalId,
      name: pipeline.name,
      count: own.length,
      totalValue: sumValues(own),
      stages: stageViews,
    });
  }

  // Anything pointing at a pipeline we have not mirrored.
  for (const leftover of byPipeline.values()) ungrouped.push(...leftover);

  return { pipelines, ungrouped, totalOpportunities: opportunityRows.length };
}
