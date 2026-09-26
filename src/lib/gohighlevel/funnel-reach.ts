/**
 * How many of a brand's CRM contacts EVER reached each funnel step, over the
 * brand's whole GoHighLevel history — the denominator and numerator a consumer
 * divides to price a leg the customer's own sales team runs (booked → attended,
 * attended → won).
 *
 * Counting rules (served in the response so a consumer can explain the basis):
 *
 *  - PER CONTACT, not per opportunity or per appointment. A person with three
 *    booked appointments is one booked contact. A conversion rate is a rate over
 *    people, and the per-lead pairing lead-service does is per contact too.
 *  - The evidence is EXACTLY the dated funnel events `/orgs/gohighlevel/funnel-
 *    events` serves (same query): calendar appointments, pipeline stage entries
 *    whose recorded meaning is a step, won / lost statuses, form submissions and
 *    form-origin contacts. Dates play no part here — an undated event still
 *    proves the step was reached.
 *  - EVERY pipeline counts. What makes a stage a step is its recorded meaning,
 *    not which pipeline it sits in; pipeline names are the customer's free text
 *    and are never matched in code.
 *  - A stage whose meaning was decided below STAGE_MEANING_MIN_CONFIDENCE is
 *    left out (counted in `hesitantStages`), as in every other read.
 *  - `contacts` counts DIRECT evidence of the step. `contactsAtOrBeyond` adds the
 *    contacts evidenced at a LATER step of the progression, per the fixed
 *    `implies` table below: GoHighLevel keeps no stage history, so a contact
 *    first observed in "Closed Client" carries no record of the booking or the
 *    meeting it went through. Without it, attended → won would divide 28 sales
 *    by the 42 attended contacts that happen to be parked in an attended stage.
 *
 * Not available (a distinct answer from zeros): no GoHighLevel connection, a
 * connection that has never completed a sync, or stage names observed but not
 * decided yet (the next sync decides them).
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { GHL_SOURCE } from "./records.js";
import { eventsQuery, FUNNEL_EVENT_SOURCES, type FunnelEventSource } from "./funnel-events.js";
import { STAGE_MEANING_MIN_CONFIDENCE } from "./stage-meanings.js";

export const REACH_STEPS = [
  "form_submitted",
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "sale",
  "deal_lost",
] as const;
export type ReachStep = (typeof REACH_STEPS)[number];

/**
 * Which LATER steps prove a step was reached. A meeting that was attended or
 * not held was booked; a sale went through a meeting that was booked and
 * attended. `form_submitted` and `deal_lost` are implied by nothing: a booking
 * does not prove a form, and a sale does not prove a loss.
 */
export const REACH_IMPLIED_BY: Record<ReachStep, ReachStep[]> = {
  form_submitted: [],
  meeting_booked: ["meeting_attended", "meeting_not_held", "sale"],
  meeting_attended: ["sale"],
  meeting_not_held: [],
  sale: [],
  deal_lost: [],
};

export type ReachUnavailableReason = "no_connection" | "not_synced" | "stage_meanings_pending";

export interface ReachStepCount {
  step: ReachStep;
  /** Distinct contacts with direct evidence of this step. */
  contacts: number;
  /** Distinct contacts with evidence of this step OR a step that implies it. */
  contactsAtOrBeyond: number;
  /** Distinct contacts per evidence source (one contact can appear under several). */
  bySource: Partial<Record<FunnelEventSource, number>>;
}

export interface FunnelReachCoverage {
  connectionStatus: string;
  lastSyncedAt: string | null;
  /** GoHighLevel contacts mirrored for the brand — the whole population. */
  totalContacts: number;
  /** Contacts carrying at least one funnel event. */
  contactsWithEvidence: number;
  /** Earliest appointment booking GoHighLevel holds (appointments reach back years). */
  appointmentsSince: string | null;
  /** When crm-service first observed the pipeline; stages before that are known only as the stage an opportunity sat in then. */
  stageHistorySince: string | null;
  undecidedStages: number;
  hesitantStages: number;
}

export type FunnelReachResult =
  | {
      brandId: string;
      available: true;
      steps: ReachStepCount[];
      coverage: FunnelReachCoverage;
    }
  | {
      brandId: string;
      available: false;
      reason: ReachUnavailableReason;
      coverage: FunnelReachCoverage | null;
    };

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Contacts of each step, for direct evidence and for evidence at-or-beyond. */
export function tallyReach(
  rows: { contact_id: string; step: string; source: FunnelEventSource }[],
): ReachStepCount[] {
  const direct = new Map<ReachStep, Set<string>>(REACH_STEPS.map((s) => [s, new Set()]));
  const bySource = new Map<ReachStep, Map<FunnelEventSource, Set<string>>>(
    REACH_STEPS.map((s) => [s, new Map()]),
  );
  for (const row of rows) {
    const step = row.step as ReachStep;
    const set = direct.get(step);
    if (!set) throw new Error(`funnel reach: unknown step "${row.step}"`);
    set.add(row.contact_id);
    const sources = bySource.get(step)!;
    if (!sources.has(row.source)) sources.set(row.source, new Set());
    sources.get(row.source)!.add(row.contact_id);
  }
  return REACH_STEPS.map((step) => {
    const beyond = new Set(direct.get(step));
    for (const later of REACH_IMPLIED_BY[step]) {
      for (const id of direct.get(later)!) beyond.add(id);
    }
    const counts: Partial<Record<FunnelEventSource, number>> = {};
    for (const source of FUNNEL_EVENT_SOURCES) {
      const ids = bySource.get(step)!.get(source);
      if (ids) counts[source] = ids.size;
    }
    return {
      step,
      contacts: direct.get(step)!.size,
      contactsAtOrBeyond: beyond.size,
      bySource: counts,
    };
  });
}

export async function readFunnelReach(args: {
  orgId: string;
  brandId: string;
}): Promise<FunnelReachResult> {
  const { orgId, brandId } = args;

  const [connection] = (await db.execute(sql`
    SELECT status, last_synced_at FROM ghl_connections
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `)) as unknown as { status: string; last_synced_at: string | Date | null }[];
  if (!connection) {
    return { brandId, available: false, reason: "no_connection", coverage: null };
  }

  const rows = (await db.execute(sql`
    SELECT DISTINCT e.contact_id, e.step, e.source FROM (${eventsQuery(orgId, brandId, null)}) e
  `)) as unknown as { contact_id: string; step: string; source: FunnelEventSource }[];

  const [facts] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM contacts
        WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${GHL_SOURCE}) AS total_contacts,
      (SELECT min(booked_at) FROM ghl_appointments
        WHERE org_id = ${orgId} AND brand_id = ${brandId}) AS appointments_since,
      (SELECT min(observed_at) FROM ghl_opportunity_history
        WHERE org_id = ${orgId} AND brand_id = ${brandId}) AS stage_history_since,
      (SELECT count(*)::int FROM (
        SELECT DISTINCT h.connection_id, h.value, h.stage_name
        FROM ghl_opportunity_history h
        WHERE h.org_id = ${orgId} AND h.brand_id = ${brandId}
          AND h.kind = 'stage' AND h.value IS NOT NULL AND h.stage_name IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ghl_stage_meanings m
            WHERE m.connection_id = h.connection_id
              AND m.stage_external_id = h.value AND m.stage_name = h.stage_name
          )
      ) u) AS undecided,
      (SELECT count(*)::int FROM ghl_stage_meanings
        WHERE org_id = ${orgId} AND brand_id = ${brandId}
          AND confidence < ${STAGE_MEANING_MIN_CONFIDENCE}) AS hesitant
  `)) as unknown as {
    total_contacts: number;
    appointments_since: string | Date | null;
    stage_history_since: string | Date | null;
    undecided: number;
    hesitant: number;
  }[];

  const coverage: FunnelReachCoverage = {
    connectionStatus: connection.status,
    lastSyncedAt: iso(connection.last_synced_at),
    totalContacts: facts.total_contacts,
    contactsWithEvidence: new Set(rows.map((r) => r.contact_id)).size,
    appointmentsSince: iso(facts.appointments_since),
    stageHistorySince: iso(facts.stage_history_since),
    undecidedStages: facts.undecided,
    hesitantStages: facts.hesitant,
  };

  if (connection.last_synced_at === null) {
    return { brandId, available: false, reason: "not_synced", coverage };
  }
  if (facts.undecided > 0) {
    return { brandId, available: false, reason: "stage_meanings_pending", coverage };
  }
  return { brandId, available: true, steps: tallyReach(rows), coverage };
}
