/**
 * The DATED funnel events a customer's GoHighLevel CRM evidences, per contact.
 *
 * Three kinds of evidence, each dated by what GoHighLevel itself recorded:
 *
 *  - `appointment` — a calendar appointment. Booking it is `meeting_booked`,
 *    dated by when it was created (`booked_at`). GoHighLevel's own appointment
 *    status (a fixed vocabulary, not the customer's words) adds the outcome:
 *    `showed` is `meeting_attended`; `noshow` and `cancelled` are
 *    `meeting_not_held`; both dated by the meeting's scheduled start.
 *    `invalid` appointments evidence nothing.
 *  - `stage_entry` — the opportunity was observed entering a pipeline stage whose
 *    RECORDED meaning (see stage-meanings.ts) is a funnel step, decided with at
 *    least STAGE_MEANING_MIN_CONFIDENCE. Dated by GoHighLevel's
 *    `lastStageChangeAt`, or null when it gave none. Two entries date NOTHING
 *    (DIGEST-SALES-ATTRIB-1105, see `stageEntriesSql`): a card CREATED already
 *    sitting in a stage past the booking (served undated: its creation is when
 *    someone typed the card, not when the step happened), and an entry into a
 *    stage meaning the SAME step as the stage the card left (not served: the
 *    step was reached at the earlier entry).
 *  - `won_status` / `lost_status` — the opportunity's status became `won` /
 *    `lost`, GoHighLevel's fixed vocabulary: `sale` / `deal_lost`, dated by
 *    `lastStatusChangeAt`, or null when it gave none.
 *  - `form_submission` — GoHighLevel recorded a submission of one of the
 *    customer's forms (a funnel opt-in, a Meta Ads lead form relayed into
 *    GoHighLevel, a booking form): `form_submitted`, dated by the submission's
 *    own `createdAt`. One event per submission — a person who submitted twice
 *    has two.
 *  - `form_origin` — GoHighLevel's first-touch attribution says the contact
 *    CAME IN through a form (`medium` `form` or `survey`, GoHighLevel's fixed
 *    attribution vocabulary): `form_submitted`, dated by when GoHighLevel
 *    created the contact. That is the submission moment — the form is what
 *    created the contact (measured on the first customer: 289 of 289 such
 *    contacts were created 0.1–4 s after their first submission). It covers the
 *    contacts whose submission record GoHighLevel no longer serves; when both
 *    exist, both are served, like any fact evidenced twice.
 *
 * What evidences a form fill is read from GoHighLevel's STRUCTURED records only.
 * The customer's free text (tags such as "funnel form submitted", the contact
 * `source` "Meta Ads", a stage named "Form Filled") is never string-matched: on
 * the first customer it added no contact the structured records did not
 * already cover (0 of 151 tagged contacts), so there was nothing to judge.
 *
 * Nothing here infers a date. An opportunity sitting in "Closed Client" says when
 * it entered that stage and nothing about when it was booked; the history table
 * only knows stages observed from the first sync onwards. A null `occurredAt`
 * means GoHighLevel did not say, and is served as null.
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { GHL_SOURCE } from "./records.js";
import { STAGE_MEANING_MIN_CONFIDENCE } from "./stage-meanings.js";

/**
 * A card's creation and its first stage are the same instant in GoHighLevel
 * (`lastStageChangeAt` = `createdAt`, measured 0-1 ms apart in prod); 5 s of
 * slack covers a vendor write split across two clocks.
 */
export const ENTERED_AT_CREATION_SLACK_SECONDS = 5;

/**
 * The steps a card's CREATION dates (DIGEST-SALES-ATTRIB-1105). Creating the
 * card IS how a booking is recorded (the calendar / booking automation creates
 * it): measured 2026-11-05, 133 of 140 cards created in a meeting_booked stage
 * sat within an hour of a calendar booking of the same contact. A card created
 * already in a later step (a client, a meeting held, a lost deal) is
 * bookkeeping: 4 of 22 created in a sale stage were near any booking, and Doc
 * Dinners created 17 cards straight into "Off Boarding" in one evening while
 * tidying its CRM (each read as a sale "yesterday" in the client's daily email).
 * Such an entry still states the step was reached, served UNDATED: never a
 * guessed purchase date.
 */
export const STEPS_DATED_BY_CARD_CREATION: readonly string[] = ["meeting_booked"];

/**
 * Every STAGE row of the brand's opportunity history with what the card did
 * before it: the previous observed stage of the SAME opportunity (`prev_value`
 * + `prev_stage_name`, null for its first) and whether this entry IS the card's
 * creation (`entered_at_creation`: no earlier stage observed AND GoHighLevel's
 * stage date equals the card's own creation date). Shared by the funnel events
 * and the CRM label events (label-verdicts.ts), so both date a stage entry by
 * the same rule.
 */
export function stageEntriesSql(orgId: string, brandId: string): SQL {
  return sql`
    SELECT h.*, o.ghl_created_at AS opportunity_created_at,
           lag(h.value) OVER w AS prev_value,
           lag(h.stage_name) OVER w AS prev_stage_name,
           (lag(h.id) OVER w IS NULL
             AND o.ghl_created_at IS NOT NULL AND h.changed_at IS NOT NULL
             AND abs(extract(epoch FROM (h.changed_at - o.ghl_created_at)))
                 <= ${ENTERED_AT_CREATION_SLACK_SECONDS}) AS entered_at_creation
    FROM ghl_opportunity_history h
    LEFT JOIN ghl_opportunities o
      ON o.connection_id = h.connection_id AND o.external_id = h.opportunity_external_id
    WHERE h.org_id = ${orgId} AND h.brand_id = ${brandId} AND h.kind = 'stage'
    WINDOW w AS (
      PARTITION BY h.connection_id, h.opportunity_external_id
      ORDER BY h.observed_at, h.changed_at NULLS FIRST, h.id
    )
  `;
}

export const FUNNEL_EVENT_SOURCES = [
  "appointment",
  "stage_entry",
  "won_status",
  "lost_status",
  "form_submission",
  "form_origin",
] as const;
export type FunnelEventSource = (typeof FUNNEL_EVENT_SOURCES)[number];

/** Which GoHighLevel date `occurredAt` is. */
export type FunnelEventDateBasis =
  | "booked_at"
  | "scheduled_start"
  | "stage_entered_at"
  | "status_changed_at"
  | "submitted_at"
  | "contact_created_at";

/**
 * GoHighLevel's first-touch attribution mediums that ARE a form fill. Its fixed
 * vocabulary, not the customer's words (`order_form` is a checkout, not a lead
 * form, and is left out).
 */
export const FORM_ORIGIN_MEDIUMS = ["form", "survey"] as const;

export interface FunnelEvent {
  step: string;
  occurredAt: string | null;
  dateBasis: FunnelEventDateBasis;
  source: FunnelEventSource;
  /** GoHighLevel's id of the appointment, opportunity, form submission or contact the evidence is. */
  sourceId: string;
  detail: {
    calendarName: string | null;
    appointmentStatus: string | null;
    scheduledStart: string | null;
    pipelineName: string | null;
    stageName: string | null;
    /** When we observed the stage / status (history rows only). */
    observedAt: string | null;
    /** The judgment model's confidence in the stage's meaning (stage entries only). */
    meaningConfidence: number | null;
    /** GoHighLevel's id of the form submitted (form submissions only). */
    formId: string | null;
    /** The customer's own name for that form, verbatim (form submissions only). */
    formName: string | null;
    /** GoHighLevel's first-touch attribution medium (form origins only). */
    attributionMedium: string | null;
    /**
     * Stage entries only: the card was CREATED in this stage. A step past the
     * booking is then served undated (`occurredAt` null): the card's creation
     * date is only the latest it can have happened (`opportunityCreatedAt`).
     */
    enteredAtCreation: boolean | null;
    /** When GoHighLevel created the card (stage entries at creation only). */
    opportunityCreatedAt: string | null;
  };
}

export interface ContactFunnelEvents {
  contactId: string;
  externalContactId: string;
  primaryEmail: string | null;
  fullName: string | null;
  events: FunnelEvent[];
}

export interface FunnelEventsResult {
  brandId: string;
  contacts: ContactFunnelEvents[];
  /** Contacts of the brand carrying at least one event. */
  totalContacts: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  /** Stage names seen but not yet given a meaning — their entries are not served yet. */
  undecidedStages: number;
  /** Stages whose recorded meaning is below the confidence floor — never served as evidence. */
  hesitantStages: number;
}

/**
 * Every event row of the brand, joined to its silver contact. Shared with the
 * whole-CRM reach counts (funnel-reach.ts), so both reads stand on the SAME
 * evidence.
 */
export function eventsQuery(orgId: string, brandId: string, contactId: string | null): SQL {
  const contactFilter = contactId ? sql`AND c.id = ${contactId}` : sql``;
  const datedByCreation = sql`ARRAY[${sql.join(
    STEPS_DATED_BY_CARD_CREATION.map((step) => sql`${step}`),
    sql`, `,
  )}]::text[]`;
  return sql`
    WITH ev AS (
      SELECT a.external_contact_id AS ext, 'meeting_booked' AS step,
             a.booked_at AS occurred_at, 'booked_at' AS date_basis,
             'appointment' AS source, a.external_id AS source_id,
             a.calendar_name, a.status AS appointment_status, a.starts_at,
             NULL::text AS pipeline_name, NULL::text AS stage_name,
             NULL::timestamptz AS observed_at, NULL::float8 AS meaning_confidence,
             NULL::text AS form_id, NULL::text AS form_name, NULL::text AS attribution_medium,
             NULL::boolean AS entered_at_creation, NULL::timestamptz AS opportunity_created_at
      FROM ghl_appointments a
      WHERE a.org_id = ${orgId} AND a.brand_id = ${brandId}
        AND a.status IS DISTINCT FROM 'invalid'
      UNION ALL
      SELECT a.external_contact_id,
             CASE a.status WHEN 'showed' THEN 'meeting_attended' ELSE 'meeting_not_held' END,
             a.starts_at, 'scheduled_start',
             'appointment', a.external_id,
             a.calendar_name, a.status, a.starts_at,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM ghl_appointments a
      WHERE a.org_id = ${orgId} AND a.brand_id = ${brandId}
        AND a.status IN ('showed', 'noshow', 'cancelled')
      UNION ALL
      SELECT h.external_contact_id, m.meaning,
             CASE WHEN h.entered_at_creation AND NOT (m.meaning = ANY(${datedByCreation}))
                  THEN NULL ELSE h.changed_at END,
             'stage_entered_at',
             'stage_entry', h.opportunity_external_id,
             NULL, NULL, NULL,
             h.pipeline_name, h.stage_name, h.observed_at, m.confidence,
             NULL, NULL, NULL,
             h.entered_at_creation, h.opportunity_created_at
      FROM (${stageEntriesSql(orgId, brandId)}) h
      JOIN ghl_stage_meanings m
        ON m.connection_id = h.connection_id
       AND m.stage_external_id = h.value
       AND m.stage_name = h.stage_name
      LEFT JOIN ghl_stage_meanings pm
        ON pm.connection_id = h.connection_id
       AND pm.stage_external_id = h.prev_value
       AND pm.stage_name = h.prev_stage_name
       AND pm.confidence >= ${STAGE_MEANING_MIN_CONFIDENCE}
      WHERE m.meaning <> 'none'
        AND m.confidence >= ${STAGE_MEANING_MIN_CONFIDENCE}
        AND pm.meaning IS DISTINCT FROM m.meaning
      UNION ALL
      SELECT h.external_contact_id,
             CASE h.value WHEN 'won' THEN 'sale' ELSE 'deal_lost' END,
             h.changed_at, 'status_changed_at',
             CASE h.value WHEN 'won' THEN 'won_status' ELSE 'lost_status' END,
             h.opportunity_external_id,
             NULL, NULL, NULL,
             h.pipeline_name, h.stage_name, h.observed_at, NULL,
             NULL, NULL, NULL, NULL, NULL
      FROM ghl_opportunity_history h
      WHERE h.org_id = ${orgId} AND h.brand_id = ${brandId}
        AND h.kind = 'status' AND h.value IN ('won', 'lost')
      UNION ALL
      SELECT f.external_contact_id, 'form_submitted',
             f.submitted_at, 'submitted_at',
             'form_submission', f.external_id,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             f.form_external_id, f.form_name, NULL, NULL, NULL
      FROM ghl_form_submissions f
      WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      UNION ALL
      SELECT o.external_id, 'form_submitted',
             o.source_created_at, 'contact_created_at',
             'form_origin', o.external_id,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, o.origin_medium, NULL, NULL
      FROM contacts o
      WHERE o.org_id = ${orgId} AND o.brand_id = ${brandId}
        AND o.source = ${GHL_SOURCE}
        AND o.origin_medium IN (${sql.join(
          FORM_ORIGIN_MEDIUMS.map((m) => sql`${m}`),
          sql`, `,
        )})
    )
    SELECT c.id AS contact_id, c.external_id AS external_contact_id,
           c.primary_email, c.full_name, ev.*
    FROM ev
    JOIN contacts c
      ON c.org_id = ${orgId} AND c.brand_id = ${brandId}
     AND c.source = ${GHL_SOURCE} AND c.external_id = ev.ext
    WHERE true ${contactFilter}
  `;
}

interface EventRow {
  contact_id: string;
  external_contact_id: string;
  primary_email: string | null;
  full_name: string | null;
  step: string;
  occurred_at: string | Date | null;
  date_basis: FunnelEventDateBasis;
  source: FunnelEventSource;
  source_id: string;
  calendar_name: string | null;
  appointment_status: string | null;
  starts_at: string | Date | null;
  pipeline_name: string | null;
  stage_name: string | null;
  observed_at: string | Date | null;
  meaning_confidence: number | null;
  form_id: string | null;
  form_name: string | null;
  attribution_medium: string | null;
  entered_at_creation: boolean | null;
  opportunity_created_at: string | Date | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

/**
 * The brand's contacts that carry at least one event, a page at a time.
 *
 * Paged over CONTACTS (not events), in a total order on the contact id, so a
 * walk with limit/offset visits each contact exactly once and a contact's events
 * are never split across two pages.
 */
export async function readFunnelEvents(args: {
  orgId: string;
  brandId: string;
  contactId?: string | null;
  limit: number;
  offset: number;
}): Promise<FunnelEventsResult> {
  const { orgId, brandId, limit, offset } = args;
  const contactId = args.contactId ?? null;
  const events = eventsQuery(orgId, brandId, contactId);

  const [{ total }] = (await db.execute(sql`
    SELECT count(DISTINCT contact_id)::int AS total FROM (${events}) e
  `)) as unknown as { total: number }[];

  const rows = (await db.execute(sql`
    WITH e AS (${events}),
    page AS (
      SELECT DISTINCT contact_id FROM e ORDER BY contact_id LIMIT ${limit} OFFSET ${offset}
    )
    SELECT e.* FROM e JOIN page USING (contact_id)
    ORDER BY e.contact_id, e.occurred_at ASC NULLS LAST, e.step, e.source, e.source_id
  `)) as unknown as EventRow[];

  const byContact = new Map<string, ContactFunnelEvents>();
  for (const row of rows) {
    let entry = byContact.get(row.contact_id);
    if (!entry) {
      entry = {
        contactId: row.contact_id,
        externalContactId: row.external_contact_id,
        primaryEmail: row.primary_email,
        fullName: row.full_name,
        events: [],
      };
      byContact.set(row.contact_id, entry);
    }
    entry.events.push({
      step: row.step,
      occurredAt: iso(row.occurred_at),
      dateBasis: row.date_basis,
      source: row.source,
      sourceId: row.source_id,
      detail: {
        calendarName: row.calendar_name,
        appointmentStatus: row.appointment_status,
        scheduledStart: iso(row.starts_at),
        pipelineName: row.pipeline_name,
        stageName: row.stage_name,
        observedAt: iso(row.observed_at),
        meaningConfidence: row.meaning_confidence === null ? null : Number(row.meaning_confidence),
        formId: row.form_id,
        formName: row.form_name,
        attributionMedium: row.attribution_medium,
        enteredAtCreation: row.entered_at_creation,
        opportunityCreatedAt: row.entered_at_creation ? iso(row.opportunity_created_at) : null,
      },
    });
  }

  const [{ undecided }] = (await db.execute(sql`
    SELECT count(*)::int AS undecided FROM (
      SELECT DISTINCT h.connection_id, h.value, h.stage_name
      FROM ghl_opportunity_history h
      WHERE h.org_id = ${orgId} AND h.brand_id = ${brandId}
        AND h.kind = 'stage' AND h.value IS NOT NULL AND h.stage_name IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ghl_stage_meanings m
          WHERE m.connection_id = h.connection_id
            AND m.stage_external_id = h.value AND m.stage_name = h.stage_name
        )
    ) u
  `)) as unknown as { undecided: number }[];

  const [{ hesitant }] = (await db.execute(sql`
    SELECT count(*)::int AS hesitant FROM ghl_stage_meanings
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
      AND confidence < ${STAGE_MEANING_MIN_CONFIDENCE}
  `)) as unknown as { hesitant: number }[];

  const served = byContact.size;
  return {
    brandId,
    contacts: [...byContact.values()],
    totalContacts: total,
    limit,
    offset,
    nextOffset: offset + served < total ? offset + served : null,
    undecidedStages: undecided,
    hesitantStages: hesitant,
  };
}
