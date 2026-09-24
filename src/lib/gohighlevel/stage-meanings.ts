/**
 * What each of a customer's free-text pipeline stages MEANS in our funnel
 * vocabulary.
 *
 * Stage names are the customer's own words ("Appointment Booked", "Showed Up -
 * Interested", "No-Show for Appointment", "Closed Client"...), different for
 * every customer. Nothing in code maps them — no string matching, no keyword
 * list. A judgment model decides: TypeSafe's Jev through chat-service
 * `POST /orgs/judgments` (which declares the cost against the run id we
 * forward), one `choice` question per stage. It answers with the model's own
 * CONFIDENCE, which is recorded beside the meaning with the full distribution
 * and the model. Reads only ever consult the record, so the same stage resolves
 * the same way every time, and a stage is sent again only when a NEW name
 * appears for it. A stage decided with low confidence is recorded but not
 * served as evidence (see STAGE_MEANING_MIN_CONFIDENCE).
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  ghlOpportunityHistory,
  ghlPipelines,
  ghlStageMeanings,
  type GhlConnection,
} from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import type { DerivedStage } from "./records.js";

/**
 * The funnel vocabulary a stage can mean. The step names are the consumer's own
 * (lead-service: `meeting_booked`, `meeting_attended`, `sale`).
 */
export const STAGE_MEANINGS = [
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "sale",
  "deal_lost",
  "none",
] as const;
export type StageMeaning = (typeof STAGE_MEANINGS)[number];

/** A stage awaiting a decision. */
export interface StageToDecide {
  pipelineExternalId: string | null;
  pipelineName: string | null;
  stageExternalId: string;
  stageName: string;
}

/** Stages sent per judgments call — keeps one request well inside Jev's token budget. */
const STAGES_PER_CALL = 40;

/**
 * Below this confidence a recorded meaning is NOT served as funnel evidence.
 * Jev's confidence measures how concentrated its distribution is: a stage it
 * hesitates on ("Showed?", "Onboarding Call") is one whose name does not say.
 * Measured on the first customer: unambiguous stages answer at 1.0, ambiguous
 * ones at 0.33-0.42.
 */
export const STAGE_MEANING_MIN_CONFIDENCE = 0.5;

/** The options every stage is judged against. */
const MEANING_CRITERIA: Record<StageMeaning, string> = {
  meeting_booked: "a meeting, call or appointment with the person has been scheduled",
  meeting_attended: "the person showed up to the meeting",
  meeting_not_held:
    "a scheduled meeting did not take place: no-show, cancelled, or needs rescheduling",
  sale: "the person became a paying customer: deal won, signed, closed, active client",
  deal_lost: "the deal is over without a sale: lost, disqualified, not interested",
  none:
    "none of these: a lead not yet contacted, a form fill, nurturing, onboarding steps, anything else",
};

export interface StageDecision {
  meaning: StageMeaning;
  confidence: number;
  probabilities: Record<string, number>;
}

/**
 * Every (stage id, stage name) the connection has — in its pipelines today, and
 * in the history of what its opportunities were observed in — that has no
 * recorded decision yet.
 */
export async function findUndecidedStages(conn: GhlConnection): Promise<StageToDecide[]> {
  const pipelines = await db
    .select()
    .from(ghlPipelines)
    .where(eq(ghlPipelines.connectionId, conn.id));

  const candidates = new Map<string, StageToDecide>();
  const keyOf = (id: string, name: string) => `${id}\u0000${name}`;

  for (const pipeline of pipelines) {
    for (const stage of (pipeline.stages as DerivedStage[]) ?? []) {
      if (!stage.id || !stage.name) continue;
      candidates.set(keyOf(stage.id, stage.name), {
        pipelineExternalId: pipeline.externalId,
        pipelineName: pipeline.name,
        stageExternalId: stage.id,
        stageName: stage.name,
      });
    }
  }

  // A stage renamed or deleted since an opportunity sat in it still needs a
  // meaning for that history row to be read.
  const historical = await db
    .selectDistinct({
      pipelineExternalId: ghlOpportunityHistory.pipelineExternalId,
      pipelineName: ghlOpportunityHistory.pipelineName,
      stageExternalId: ghlOpportunityHistory.value,
      stageName: ghlOpportunityHistory.stageName,
    })
    .from(ghlOpportunityHistory)
    .where(
      and(
        eq(ghlOpportunityHistory.connectionId, conn.id),
        eq(ghlOpportunityHistory.kind, "stage"),
        sql`${ghlOpportunityHistory.value} IS NOT NULL`,
        sql`${ghlOpportunityHistory.stageName} IS NOT NULL`,
      ),
    );
  for (const row of historical) {
    const key = keyOf(row.stageExternalId!, row.stageName!);
    if (!candidates.has(key)) {
      candidates.set(key, {
        pipelineExternalId: row.pipelineExternalId,
        pipelineName: row.pipelineName,
        stageExternalId: row.stageExternalId!,
        stageName: row.stageName!,
      });
    }
  }

  if (candidates.size === 0) return [];

  const decided = await db
    .select({
      stageExternalId: ghlStageMeanings.stageExternalId,
      stageName: ghlStageMeanings.stageName,
    })
    .from(ghlStageMeanings)
    .where(eq(ghlStageMeanings.connectionId, conn.id));
  for (const row of decided) candidates.delete(keyOf(row.stageExternalId, row.stageName));

  return [...candidates.values()];
}

/**
 * One judgments call for a batch of stages: one `choice` question per stage,
 * all read against the same state — every pipeline of the connection with its
 * stages in order, so each stage is judged in context. Fails loud: every stage
 * asked about must come back with a meaning from the vocabulary and its
 * confidence, or nothing is recorded.
 */
export async function classifyStages(
  stages: StageToDecide[],
  pipelines: Record<string, string[]>,
  tracking: ChatTrackingHeaders,
): Promise<{ decisions: StageDecision[]; model: string }> {
  const questions: Record<string, ChoiceQuestion> = {};
  stages.forEach((stage, index) => {
    questions[`s${index}`] = {
      type: "choice",
      instructions:
        `An opportunity enters the stage "${stage.stageName}" of the pipeline ` +
        `"${stage.pipelineName ?? "(unnamed pipeline)"}". Which single funnel fact does ` +
        "entering this stage establish about the person?",
      criteria: MEANING_CRITERIA,
    };
  });

  const result = await judgeChoices({ pipelines }, questions, tracking);

  const decisions = stages.map((_, index): StageDecision => {
    const answer = result.answers?.[`s${index}`];
    if (!answer) {
      throw new Error(`[crm-service][ghl] stage meanings: no answer for stage s${index}`);
    }
    if (!(STAGE_MEANINGS as readonly string[]).includes(answer.choice)) {
      throw new Error(`[crm-service][ghl] stage meanings: unknown meaning "${answer.choice}"`);
    }
    if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
      throw new Error(`[crm-service][ghl] stage meanings: s${index} came back without a confidence`);
    }
    return {
      meaning: answer.choice as StageMeaning,
      confidence: answer.confidence,
      probabilities: answer.probabilities ?? {},
    };
  });

  return { decisions, model: result.model };
}

/**
 * Decide and record a meaning for every stage of the connection that has none
 * yet. A no-op — no model call at all — when every stage is already decided,
 * which is every sync after the first unless the customer adds or renames one.
 */
export async function decideStageMeanings(
  conn: GhlConnection,
  runId: string,
): Promise<number> {
  const undecided = await findUndecidedStages(conn);
  if (undecided.length === 0) return 0;

  const tracking: ChatTrackingHeaders = {
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    runId,
    brandIds: [conn.brandId],
  };

  // The state every question is read against: each pipeline, stages in order.
  const pipelineRows = await db
    .select({ name: ghlPipelines.name, stages: ghlPipelines.stages })
    .from(ghlPipelines)
    .where(eq(ghlPipelines.connectionId, conn.id));
  const pipelines: Record<string, string[]> = {};
  for (const row of pipelineRows) {
    pipelines[row.name] = ((row.stages as DerivedStage[]) ?? [])
      .map((stage) => stage.name)
      .filter((name): name is string => !!name);
  }

  let recorded = 0;
  for (let i = 0; i < undecided.length; i += STAGES_PER_CALL) {
    const batch = undecided.slice(i, i + STAGES_PER_CALL);
    const { decisions, model } = await classifyStages(batch, pipelines, tracking);
    const rows = await db
      .insert(ghlStageMeanings)
      .values(
        batch.map((stage, index) => ({
          orgId: conn.orgId,
          brandId: conn.brandId,
          connectionId: conn.id,
          pipelineExternalId: stage.pipelineExternalId,
          pipelineName: stage.pipelineName,
          stageExternalId: stage.stageExternalId,
          stageName: stage.stageName,
          meaning: decisions[index].meaning,
          confidence: decisions[index].confidence,
          probabilities: decisions[index].probabilities,
          model,
          runId,
        })),
      )
      // Recorded once: a concurrent pass that decided first wins, and nothing is
      // ever re-decided over an existing record.
      .onConflictDoNothing({
        target: [
          ghlStageMeanings.connectionId,
          ghlStageMeanings.stageExternalId,
          ghlStageMeanings.stageName,
        ],
      })
      .returning({ id: ghlStageMeanings.id });
    recorded += rows.length;
  }
  return recorded;
}
