import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  crmLabelVerdicts,
  ghlConnections,
  ghlOpportunities,
  ghlOpportunityHistory,
  ghlStageMeanings,
} from "../../src/db/schema.js";
import { eventsQuery } from "../../src/lib/gohighlevel/funnel-events.js";
import { labelEventsQuery, type LabelEventRow } from "../../src/lib/gohighlevel/label-verdicts.js";

/**
 * DIGEST-SALES-ATTRIB-1105: a CRM card CREATED already sitting in a client stage
 * says the person was a client, never WHEN they bought (Doc Dinners created 17
 * cards straight into "Off Boarding" while tidying its CRM on 2026-11-03; each
 * read as a sale that day). A real stage MOVE into a sale stage keeps its date.
 * Real Postgres (gated on CRM_TEST_DB).
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "c3c3c3c3-1111-4111-8111-000000000001";
const BRAND = "c3c3c3c3-1111-4111-8111-000000000002";

let connectionId = "";

const D = (s: string) => new Date(s);

async function wipe() {
  await db.delete(contacts).where(eq(contacts.brandId, BRAND));
  await db.delete(ghlConnections).where(eq(ghlConnections.brandId, BRAND)); // cascades the rest
}

async function seed() {
  const [conn] = await db
    .insert(ghlConnections)
    .values({ orgId: ORG, brandId: BRAND, locationId: "loc-dates", createdByUserId: "u" })
    .returning();
  connectionId = conn.id;
  const base = { orgId: ORG, brandId: BRAND, connectionId };

  for (const name of ["created", "moved", "booked", "relabel"]) {
    await db.insert(contacts).values({
      orgId: ORG,
      brandId: BRAND,
      source: "gohighlevel",
      externalId: `ext-${name}`,
      primaryEmail: `${name}@dates.test`,
      rawAttributes: {},
      sourceConnectionId: connectionId,
    });
  }

  const meaning = (stageId: string, stageName: string, m: string) => ({
    ...base,
    pipelineName: "P",
    stageExternalId: stageId,
    stageName,
    meaning: m,
    confidence: 1,
    probabilities: { [m]: 1 },
    model: "jev-test",
    runId: "run-test",
    criteriaVersion: 2,
  });
  await db.insert(ghlStageMeanings).values([
    meaning("st-booked", "Appointment Booked", "meeting_booked"),
    meaning("st-held", "Past Event Held", "sale"),
    meaning("st-off", "Off Boarding", "sale"),
  ]);
  const verdict = (stageId: string, label: string, v: string) => ({
    ...base,
    kind: "stage",
    labelRef: stageId,
    label,
    pipelineName: "P",
    verdict: v,
    confidence: 1,
    probabilities: { [v]: 1 },
    model: "jev-test",
    runId: "run-test",
  });
  await db.insert(crmLabelVerdicts).values([
    verdict("st-held", "Past Event Held", "client"),
    verdict("st-off", "Off Boarding", "former_client"),
  ]);

  const opp = (id: string, contact: string, createdAt: Date) => ({
    ...base,
    externalId: id,
    name: id,
    externalContactId: `ext-${contact}`,
    ghlCreatedAt: createdAt,
  });
  await db.insert(ghlOpportunities).values([
    // Created directly in Off Boarding during a CRM cleanup.
    opp("opp-created", "created", D("2026-11-03T19:08:40.732Z")),
    // Booked in August, moved to a sale stage on 2026-09-15: a real move.
    opp("opp-moved", "moved", D("2026-08-10T18:46:00.000Z")),
    // Created by the booking itself: creation IS the booking.
    opp("opp-booked", "booked", D("2026-10-01T10:00:00.000Z")),
    // A client since May, moved from one client stage to another on 2026-11-03.
    opp("opp-relabel", "relabel", D("2026-05-12T16:00:00.000Z")),
  ]);

  const stage = (oppId: string, contact: string, stageId: string, stageName: string, changedAt: Date, observedAt: Date) => ({
    ...base,
    opportunityExternalId: oppId,
    externalContactId: `ext-${contact}`,
    kind: "stage",
    value: stageId,
    pipelineName: "P",
    stageName,
    changedAt,
    observedAt,
  });
  await db.insert(ghlOpportunityHistory).values([
    stage("opp-created", "created", "st-off", "Off Boarding", D("2026-11-03T19:08:40.732Z"), D("2026-11-03T19:17:41Z")),
    stage("opp-moved", "moved", "st-booked", "Appointment Booked", D("2026-08-10T18:46:00.000Z"), D("2026-08-10T19:00:00Z")),
    stage("opp-moved", "moved", "st-held", "Past Event Held", D("2026-09-15T12:00:00.000Z"), D("2026-09-15T12:10:00Z")),
    stage("opp-booked", "booked", "st-booked", "Appointment Booked", D("2026-10-01T10:00:00.000Z"), D("2026-10-01T10:10:00Z")),
    stage("opp-relabel", "relabel", "st-held", "Past Event Held", D("2026-05-14T15:41:42Z"), D("2026-09-24T10:51:11Z")),
    stage("opp-relabel", "relabel", "st-off", "Off Boarding", D("2026-11-03T17:36:29Z"), D("2026-11-03T17:47:04Z")),
  ]);
}

const at = (v: string | Date | null) => (v === null ? "undated" : new Date(v).toISOString());

describe.skipIf(!RUN)("what date a CRM stage entry may claim (DIGEST-SALES-ATTRIB-1105)", () => {
  beforeAll(async () => {
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it("dates a real move into a sale stage, never a card created in one, never a sale stage re-entered", async () => {
    const rows = (await db.execute(eventsQuery(ORG, BRAND, null))) as unknown as {
      external_contact_id: string;
      step: string;
      source: string;
      stage_name: string | null;
      occurred_at: string | Date | null;
      entered_at_creation: boolean | null;
      opportunity_created_at: string | Date | null;
    }[];
    const seen = rows
      .filter((r) => r.source === "stage_entry")
      .map((r) => `${r.external_contact_id}|${r.step}|${r.stage_name}|${at(r.occurred_at)}`)
      .sort();
    expect(seen).toEqual([
      // Booked by creating the card: the creation dates the booking.
      "ext-booked|meeting_booked|Appointment Booked|2026-10-01T10:00:00.000Z",
      // Created straight into Off Boarding: a client, date unknown.
      "ext-created|sale|Off Boarding|undated",
      "ext-moved|meeting_booked|Appointment Booked|2026-08-10T18:46:00.000Z",
      // Appointment Booked -> Past Event Held on 2026-09-15: a sale on 2026-09-15.
      "ext-moved|sale|Past Event Held|2026-09-15T12:00:00.000Z",
      // Past Event Held -> Off Boarding is no second sale: only the May entry.
      "ext-relabel|sale|Past Event Held|2026-05-14T15:41:42.000Z",
    ]);
    const created = rows.find((r) => r.external_contact_id === "ext-created")!;
    expect(created.entered_at_creation).toBe(true);
    expect(at(created.opportunity_created_at)).toBe("2026-11-03T19:08:40.732Z");
    const moved = rows.find((r) => r.external_contact_id === "ext-moved" && r.step === "sale")!;
    expect(moved.entered_at_creation).toBe(false);
  });

  it("states a client label the same way: undated at creation, not re-stated, former_client dated on a real move", async () => {
    const rows = (await db.execute(labelEventsQuery(ORG, BRAND))) as unknown as LabelEventRow[];
    const seen = rows.map((r) => `${r.external_contact_id}|${r.step}|${r.stage_name}|${at(r.occurred_at)}`).sort();
    expect(seen).toEqual([
      "ext-created|client|Off Boarding|undated",
      "ext-created|former_client|Off Boarding|undated",
      "ext-moved|client|Past Event Held|2026-09-15T12:00:00.000Z",
      "ext-relabel|client|Past Event Held|2026-05-14T15:41:42.000Z",
      // They stopped when the card moved to Off Boarding.
      "ext-relabel|former_client|Off Boarding|2026-11-03T17:36:29.000Z",
    ]);
  });
});
