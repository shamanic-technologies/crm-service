/**
 * What each of a customer's free-text pipeline stages MEANS in our funnel
 * vocabulary.
 *
 * Stage names are the customer's own words ("Appointment Booked", "Showed Up -
 * Interested", "No-Show for Appointment", "Closed Client"...), different for
 * every customer. Nothing in code maps them — no string matching, no keyword
 * list. An LLM decides, through chat-service `POST /complete` (which declares
 * the LLM cost against the run id we forward), and the decision is RECORDED in
 * `ghl_stage_meanings` with the model that produced it. Reads only ever consult
 * the record, so the same stage resolves the same way every time, and a stage is
 * sent to the model again only when a NEW name appears for it.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  ghlOpportunityHistory,
  ghlPipelines,
  ghlStageMeanings,
  type GhlConnection,
} from "../../db/schema.js";
import { chatComplete, type ChatTrackingHeaders } from "../chat-client.js";
import { stageMeaningChatConfig } from "../chat-config.js";
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

/** Stages sent per call — keeps one answer well inside the output budget. */
const STAGES_PER_CALL = 60;

const SYSTEM_PROMPT = [
  "You classify the stages of a business's sales pipelines, as named by the business itself in its CRM.",
  "For each stage, say which single funnel fact an opportunity ENTERING that stage establishes about the person:",
  "- meeting_booked: a meeting / call / appointment with the person has been scheduled.",
  "- meeting_attended: the person showed up to the meeting.",
  "- meeting_not_held: a scheduled meeting did not take place (no-show, cancelled, needs rescheduling).",
  "- sale: the person became a paying customer (deal won, signed, closed, active client).",
  "- deal_lost: the deal is over without a sale (lost, disqualified, not interested).",
  "- none: the stage establishes none of these (a lead not yet contacted, a form fill, nurturing, onboarding steps, anything else).",
  "Judge from the stage name, read in the context of its pipeline and the order of the stages. When a stage does not clearly establish one of the facts, answer none.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    stages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          meaning: { type: "string", enum: [...STAGE_MEANINGS] },
        },
        required: ["key", "meaning"],
      },
    },
  },
  required: ["stages"],
};

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
 * One chat-service call for a batch of stages. Fails loud: every stage asked
 * about must come back exactly once with a meaning from the vocabulary, or
 * nothing is recorded.
 */
export async function classifyStages(
  stages: StageToDecide[],
  tracking: ChatTrackingHeaders,
): Promise<{ meanings: StageMeaning[]; model: string }> {
  const config = stageMeaningChatConfig();

  // Each pipeline listed in full, in its own order, so a stage is read in context.
  const lines: string[] = [];
  stages.forEach((stage, index) => {
    lines.push(
      `key=${index} | pipeline: "${stage.pipelineName ?? "(unnamed pipeline)"}" | stage: "${stage.stageName}"`,
    );
  });

  const result = await chatComplete(
    {
      message: `Classify each stage. Answer one entry per key.\n\n${lines.join("\n")}`,
      systemPrompt: SYSTEM_PROMPT,
      provider: config.provider,
      model: config.model,
      responseFormat: "json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      maxTokens: 4096,
      disableThinking: true,
    },
    tracking,
  );

  const json = result.json as { stages?: unknown } | undefined;
  if (!json || !Array.isArray(json.stages)) {
    throw new Error("[crm-service][ghl] stage meanings: chat-service returned no stages array");
  }

  const meanings: (StageMeaning | undefined)[] = new Array(stages.length);
  for (const entry of json.stages as { key?: unknown; meaning?: unknown }[]) {
    const index = Number(entry?.key);
    if (!Number.isInteger(index) || index < 0 || index >= stages.length) {
      throw new Error(`[crm-service][ghl] stage meanings: unknown key "${String(entry?.key)}"`);
    }
    const meaning = String(entry.meaning ?? "");
    if (!(STAGE_MEANINGS as readonly string[]).includes(meaning)) {
      throw new Error(`[crm-service][ghl] stage meanings: unknown meaning "${meaning}"`);
    }
    if (meanings[index] !== undefined) {
      throw new Error(`[crm-service][ghl] stage meanings: key ${index} answered twice`);
    }
    meanings[index] = meaning as StageMeaning;
  }
  const missing = meanings.findIndex((m) => m === undefined);
  if (missing !== -1 || meanings.length !== stages.length) {
    throw new Error(`[crm-service][ghl] stage meanings: no answer for key ${missing}`);
  }

  return { meanings: meanings as StageMeaning[], model: result.model };
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

  let recorded = 0;
  for (let i = 0; i < undecided.length; i += STAGES_PER_CALL) {
    const batch = undecided.slice(i, i + STAGES_PER_CALL);
    const { meanings, model } = await classifyStages(batch, tracking);
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
          meaning: meanings[index],
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
