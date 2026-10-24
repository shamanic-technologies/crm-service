/**
 * What a customer's CRM LABELS say about the PERSON (CRM-WARM-NURTURE-1015).
 *
 * Owner 2026-10-15: a consumer must be able to leave out a brand's existing
 * clients and the people the brand marked unqualified WITHOUT knowing the
 * brand's words. A customer says it with pipeline stages ("Closed Client",
 * "Unqualified", "Past Event Held" in a "Client Lifecycle" pipeline) and with
 * contact tags ("client.", "unqualified", "blocked"), different for every
 * customer. Nothing in code maps them: TypeSafe's Jev (chat-service
 * `POST /orgs/judgments`, cost declared there against our run) answers one
 * `choice` question per label, `client | disqualified | none`, with every
 * pipeline and every tag of the connection as the shared state. The decision is
 * recorded once (`crm_label_verdicts`) with its confidence; a label is asked
 * again only when a NEW one appears. Below LABEL_VERDICT_MIN_CONFIDENCE it is
 * recorded but never served as evidence.
 *
 * Orthogonal to the stage MEANINGS (stage-meanings.ts: which funnel step a stage
 * is): "Showed Up - Interested" is a meeting attended AND says nothing about
 * being a client; "Past Event Held" in a client pipeline is both.
 *
 * Served as facts (people/facts.ts): a stage entry or a tag judged `client` is a
 * `client` fact, judged `disqualified` a `disqualified` fact. The serve's
 * `sale` step counts `client` facts (people/segment.ts).
 */

import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { crmLabelVerdicts, ghlPipelines, type GhlConnection } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import { GHL_SOURCE, type DerivedStage } from "./records.js";
import { findConnectionStages } from "./stage-meanings.js";

export const LABEL_VERDICTS = ["client", "former_client", "disqualified", "none"] as const;
/**
 * Bump when the options' wording changes: every label decided under an older version is re-decided
 * in place on the next sync (it serves until then). v2 (FORMER-CLIENT-1017, owner 2026-10-17): a
 * customer who STOPPED is `former_client`, no longer folded into `client`.
 */
export const LABEL_CRITERIA_VERSION = 2;
export type LabelVerdict = (typeof LABEL_VERDICTS)[number];
export type LabelKind = "stage" | "tag";

/** Below this confidence a verdict is recorded but never served as evidence (same floor as stage meanings). */
export const LABEL_VERDICT_MIN_CONFIDENCE = 0.5;

const LABELS_PER_CALL = 40;

const VERDICT_CRITERIA: Record<LabelVerdict, string> = {
  client:
    "the person IS a paying customer of the business now: closed, won, signed, paid, active client, onboarding, " +
    "renewed",
  former_client:
    "the person WAS a paying customer and stopped: inactive, churned, cancelled, lapsed, past, former or offboarded " +
    "client, did not renew",
  disqualified:
    "the business judged the person NOT a fit and stopped pursuing them: unqualified, disqualified, " +
    "bad fit, spam, blocked, do not contact",
  none:
    "neither: a new lead, a form fill, a booked, attended or missed meeting, in conversation, nurturing, " +
    "the person lost interest or the deal was lost, a free trial, or anything else",
};

export interface LabelToDecide {
  kind: LabelKind;
  /** Stage: GoHighLevel's stage id; tag: ''. */
  labelRef: string;
  /** Stage: name verbatim; tag: trimmed + lower-cased. */
  label: string;
  /** The words shown to Jev: stage name / tag as the customer spelled it. */
  shown: string;
  pipelineName: string | null;
}

/** A tag's matching key: tags are matched case-insensitive, trimmed. */
export const tagKey = (tag: string): string => tag.trim().toLowerCase();

/** Every stage and tag of the connection that has no recorded verdict yet. */
export async function findUndecidedLabels(conn: GhlConnection): Promise<LabelToDecide[]> {
  const candidates = new Map<string, LabelToDecide>();
  const keyOf = (kind: string, ref: string, label: string) => `${kind}\u0000${ref}\u0000${label}`;

  for (const stage of await findConnectionStages(conn)) {
    candidates.set(keyOf("stage", stage.stageExternalId, stage.stageName), {
      kind: "stage",
      labelRef: stage.stageExternalId,
      label: stage.stageName,
      shown: stage.stageName,
      pipelineName: stage.pipelineName,
    });
  }

  const tags = (await db.execute(sql`
    SELECT DISTINCT ON (lower(btrim(t.tag))) btrim(t.tag) AS tag
    FROM contacts c, jsonb_array_elements_text(c.tags) AS t(tag)
    WHERE c.source_connection_id = ${conn.id} AND c.source = ${GHL_SOURCE}
      AND jsonb_typeof(c.tags) = 'array' AND btrim(t.tag) <> ''
    ORDER BY lower(btrim(t.tag)), btrim(t.tag)
  `)) as unknown as { tag: string }[];
  for (const { tag } of tags) {
    candidates.set(keyOf("tag", "", tagKey(tag)), { kind: "tag", labelRef: "", label: tagKey(tag), shown: tag, pipelineName: null });
  }

  if (candidates.size === 0) return [];
  const decided = await db
    .select({ kind: crmLabelVerdicts.kind, labelRef: crmLabelVerdicts.labelRef, label: crmLabelVerdicts.label, criteriaVersion: crmLabelVerdicts.criteriaVersion })
    .from(crmLabelVerdicts)
    .where(eq(crmLabelVerdicts.connectionId, conn.id));
  // A label decided under older wording is asked again (re-decided in place).
  for (const row of decided) if (row.criteriaVersion >= LABEL_CRITERIA_VERSION) candidates.delete(keyOf(row.kind, row.labelRef, row.label));
  return [...candidates.values()];
}

export interface LabelDecision {
  verdict: LabelVerdict;
  confidence: number;
  probabilities: Record<string, number>;
}

/** The question asked about one label. */
export function labelQuestion(label: LabelToDecide): ChoiceQuestion {
  const where =
    label.kind === "stage"
      ? `A deal of the person sits in the stage "${label.shown}" of the pipeline "${label.pipelineName ?? "(unnamed pipeline)"}".`
      : `The person's contact carries the tag "${label.shown}".`;
  return {
    type: "choice",
    instructions: `In a business's CRM: ${where} What does this label say about the person's standing with the business?`,
    criteria: VERDICT_CRITERIA,
  };
}

/** One Jev call for a batch of labels. Fails loud: every label must come back with a known verdict and a confidence. */
export async function classifyLabels(
  labels: LabelToDecide[],
  state: { pipelines: Record<string, string[]>; tags: string[] },
  tracking: ChatTrackingHeaders,
): Promise<{ decisions: LabelDecision[]; model: string }> {
  const questions: Record<string, ChoiceQuestion> = {};
  labels.forEach((label, i) => {
    questions[`l${i}`] = labelQuestion(label);
  });
  const result = await judgeChoices(state, questions, tracking);
  const decisions = labels.map((_, i): LabelDecision => {
    const answer = result.answers?.[`l${i}`];
    if (!answer) throw new Error(`[crm-service][ghl] label verdicts: no answer for label l${i}`);
    if (!(LABEL_VERDICTS as readonly string[]).includes(answer.choice)) {
      throw new Error(`[crm-service][ghl] label verdicts: unknown verdict "${answer.choice}"`);
    }
    if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
      throw new Error(`[crm-service][ghl] label verdicts: l${i} came back without a confidence`);
    }
    return { verdict: answer.choice as LabelVerdict, confidence: answer.confidence, probabilities: answer.probabilities ?? {} };
  });
  return { decisions, model: result.model };
}

/**
 * Decide and record a verdict for every label of the connection that has none.
 * No model call at all when every label is decided (every sync after the first,
 * unless the customer adds a stage or a tag).
 */
export async function decideLabelVerdicts(conn: GhlConnection, runOf: () => Promise<string>): Promise<number> {
  const undecided = await findUndecidedLabels(conn);
  if (undecided.length === 0) return 0;
  // A support run (the brand's own CRM vocabulary, LEDGER-HISTORY-1024), opened only when a label is decided.
  const runId = await runOf();

  const tracking: ChatTrackingHeaders = { orgId: conn.orgId, userId: conn.createdByUserId, runId, brandIds: [conn.brandId] };
  const pipelineRows = await db
    .select({ name: ghlPipelines.name, stages: ghlPipelines.stages })
    .from(ghlPipelines)
    .where(eq(ghlPipelines.connectionId, conn.id));
  const pipelines: Record<string, string[]> = {};
  for (const row of pipelineRows) {
    pipelines[row.name] = ((row.stages as DerivedStage[]) ?? []).map((s) => s.name).filter((n): n is string => !!n);
  }
  const tags = undecided.filter((l) => l.kind === "tag").map((l) => l.shown);

  let recorded = 0;
  for (let i = 0; i < undecided.length; i += LABELS_PER_CALL) {
    const batch = undecided.slice(i, i + LABELS_PER_CALL);
    const { decisions, model } = await classifyLabels(batch, { pipelines, tags }, tracking);
    const rows = await db
      .insert(crmLabelVerdicts)
      .values(
        batch.map((label, j) => ({
          orgId: conn.orgId,
          brandId: conn.brandId,
          connectionId: conn.id,
          kind: label.kind,
          labelRef: label.labelRef,
          label: label.label,
          pipelineName: label.pipelineName,
          verdict: decisions[j].verdict,
          confidence: decisions[j].confidence,
          probabilities: decisions[j].probabilities,
          model,
          runId,
          criteriaVersion: LABEL_CRITERIA_VERSION,
          decidedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [crmLabelVerdicts.connectionId, crmLabelVerdicts.kind, crmLabelVerdicts.labelRef, crmLabelVerdicts.label],
        set: {
          verdict: sql`excluded.verdict`,
          confidence: sql`excluded.confidence`,
          probabilities: sql`excluded.probabilities`,
          model: sql`excluded.model`,
          runId: sql`excluded.run_id`,
          criteriaVersion: sql`excluded.criteria_version`,
          decidedAt: sql`excluded.decided_at`,
        },
      })
      .returning({ id: crmLabelVerdicts.id });
    recorded += rows.length;
  }
  return recorded;
}

/** The recorded verdicts of a brand (staff / agent read). */
export async function readLabelVerdicts(orgId: string, brandId: string) {
  return db
    .select({
      kind: crmLabelVerdicts.kind,
      label: crmLabelVerdicts.label,
      pipelineName: crmLabelVerdicts.pipelineName,
      verdict: crmLabelVerdicts.verdict,
      confidence: crmLabelVerdicts.confidence,
      model: crmLabelVerdicts.model,
      decidedAt: crmLabelVerdicts.decidedAt,
    })
    .from(crmLabelVerdicts)
    .where(and(eq(crmLabelVerdicts.orgId, orgId), eq(crmLabelVerdicts.brandId, brandId)))
    .orderBy(crmLabelVerdicts.kind, crmLabelVerdicts.pipelineName, crmLabelVerdicts.label);
}


/**
 * The CRM label EVENTS of a brand: one row per (contact, stage entry) and per
 * (contact, tag) whose label is judged `client` / `former_client` / `disqualified` at or above the
 * confidence floor. A `former_client` label yields TWO rows: `client` (they bought: every reader of
 * `client`, the serve's sale step included, is unchanged) and `former_client` (they stopped). A stage entry is dated by GoHighLevel's stage change date
 * (history, never withdrawn on absence like the other stage entries); a tag has
 * no date in GoHighLevel and is served undated while the contact carries it.
 */
/** The steps a verdict states: a former client was a client too. */
const STEPS_OF_VERDICT = sql`CASE v.verdict WHEN 'former_client' THEN ARRAY['client', 'former_client'] ELSE ARRAY[v.verdict] END`;

export function labelEventsQuery(orgId: string, brandId: string): SQL {
  return sql`
    SELECT c.id AS contact_id, c.external_id AS external_contact_id, c.full_name,
           st.step, h.changed_at AS occurred_at, 'stage_entered_at' AS date_basis,
           'stage_label' AS source, h.opportunity_external_id AS source_id,
           h.pipeline_name, h.stage_name, NULL::text AS tag, v.confidence, h.observed_at
    FROM ghl_opportunity_history h
    JOIN crm_label_verdicts v
      ON v.connection_id = h.connection_id AND v.kind = 'stage'
     AND v.label_ref = h.value AND v.label = h.stage_name
    JOIN contacts c
      ON c.org_id = h.org_id AND c.brand_id = h.brand_id
     AND c.source = ${GHL_SOURCE} AND c.external_id = h.external_contact_id
    CROSS JOIN LATERAL unnest(${STEPS_OF_VERDICT}) AS st(step)
    WHERE h.org_id = ${orgId} AND h.brand_id = ${brandId} AND h.kind = 'stage'
      AND v.verdict IN ('client', 'former_client', 'disqualified') AND v.confidence >= ${LABEL_VERDICT_MIN_CONFIDENCE}
    UNION ALL
    SELECT c.id, c.external_id, c.full_name,
           st.step, NULL::timestamptz, 'undated',
           'contact_tag', c.external_id,
           NULL, NULL, v.label, v.confidence, NULL::timestamptz
    FROM contacts c
    JOIN LATERAL (
      SELECT DISTINCT lower(btrim(t.tag)) AS key
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.tags) = 'array' THEN c.tags ELSE '[]'::jsonb END) AS t(tag)
    ) t ON true
    JOIN crm_label_verdicts v
      ON v.connection_id = c.source_connection_id AND v.kind = 'tag' AND v.label_ref = '' AND v.label = t.key
    CROSS JOIN LATERAL unnest(${STEPS_OF_VERDICT}) AS st(step)
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = ${GHL_SOURCE}
      AND v.verdict IN ('client', 'former_client', 'disqualified') AND v.confidence >= ${LABEL_VERDICT_MIN_CONFIDENCE}
  `;
}

export interface LabelEventRow {
  contact_id: string;
  external_contact_id: string;
  full_name: string | null;
  step: "client" | "former_client" | "disqualified";
  occurred_at: string | Date | null;
  date_basis: "stage_entered_at" | "undated";
  source: "stage_label" | "contact_tag";
  source_id: string;
  pipeline_name: string | null;
  stage_name: string | null;
  tag: string | null;
  confidence: number;
  observed_at: string | Date | null;
}
