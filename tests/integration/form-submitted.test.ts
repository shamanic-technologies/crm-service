import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, formSubmittedDeclarations, ghlConnections, ghlFormSubmissions, ghlRawRecords } from "../../src/db/schema.js";
import { runFormSubmittedPass } from "../../src/lib/gohighlevel/form-submitted.js";

/**
 * CRM-FORM-SUBMITTED-LEDGER-1025 against a real database: every CRM form submission crm-service holds is declared ONCE
 * at runs-service as `form_submitted` (subject lead-service, the lead) on a spend-free run of its own, as of the
 * submission. A calendar's booking form is skipped; a person who is no lead waits and is asked again. lead-service +
 * runs-service stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "f0f0f0f0-3333-4333-8333-000000000001";
const BRAND = "f0f0f0f0-3333-4333-8333-000000000002";
const USER = "f0f0f0f0-3333-4333-8333-000000000003";
const LEAD_ANN = "f0f0f0f0-3333-4333-8333-0000000000a1";
const LEAD_BOB = "f0f0f0f0-3333-4333-8333-0000000000b1";
const LEAD_CAT = "f0f0f0f0-3333-4333-8333-0000000000c1";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let batches: Array<{ runs: Array<Record<string, unknown>> }> = [];
let resolves: Array<{ people: Array<Record<string, unknown>> }> = [];
let runsOpened: string[] = [];
let runsClosed: string[] = [];
let bobIsLead = false;

async function seed() {
  const [conn] = await db.insert(ghlConnections).values({ orgId: ORG, brandId: BRAND, locationId: "loc", createdByUserId: USER, lastSyncedAt: new Date() }).returning();
  const [cat] = await db
    .insert(contacts)
    .values({ orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-cat", phoneE164: "+33600000003", fullName: "Cat", rawAttributes: {}, sourceConnectionId: conn.id })
    .returning();
  const raw = (kind: string, externalId: string, payload: Record<string, unknown>) => ({
    orgId: ORG, brandId: BRAND, connectionId: conn.id, kind, externalId, contentHash: externalId, payload,
  });
  await db.insert(ghlRawRecords).values([
    raw("calendar", "cal-1", { id: "cal-1", formId: "form-booking" }),
    raw("form_submission", "sub-ann", { id: "sub-ann", formId: "form-1", email: "Ann@Acme.example", others: {} }),
    raw("form_submission", "sub-booking", { id: "sub-booking", formId: "form-booking", email: "dan@acme.example", others: {} }),
    raw("form_submission", "sub-bob", { id: "sub-bob", formId: "form-1", email: "bob@acme.example", others: {} }),
    raw("form_submission", "sub-cat", { id: "sub-cat", formId: "form-1", contactId: "ghl-cat", others: {} }),
  ]);
  const sub = (externalId: string, formExternalId: string, submittedAt: string, contactId: string | null = null) => ({
    orgId: ORG, brandId: BRAND, connectionId: conn.id, externalId, formExternalId, contactId, submittedAt: new Date(submittedAt),
  });
  await db.insert(ghlFormSubmissions).values([
    sub("sub-ann", "form-1", "2026-10-15T11:00:00Z"),
    sub("sub-booking", "form-booking", "2026-10-15T12:00:00Z"),
    sub("sub-bob", "form-1", "2026-10-16T20:00:00Z"),
    sub("sub-cat", "form-1", "2026-10-18T22:00:00Z", cat.id),
    { ...sub("sub-undated", "form-1", "2026-10-18T22:00:00Z"), submittedAt: null },
  ]);
}

async function cleanup() {
  await db.delete(formSubmittedDeclarations).where(eq(formSubmittedDeclarations.brandId, BRAND));
  await db.delete(ghlFormSubmissions).where(eq(ghlFormSubmissions.brandId, BRAND));
  await db.delete(ghlRawRecords).where(eq(ghlRawRecords.brandId, BRAND));
  await db.delete(contacts).where(eq(contacts.brandId, BRAND));
  await db.delete(ghlConnections).where(eq(ghlConnections.brandId, BRAND));
}

const due = () => db.update(formSubmittedDeclarations).set({ nextAt: new Date(0) }).where(eq(formSubmittedDeclarations.brandId, BRAND));

describe.skipIf(!RUN)("form_submitted declared for every CRM form submission crm-service holds (CRM-FORM-SUBMITTED-LEDGER-1025)", () => {
  beforeEach(async () => {
    process.env.LEAD_SERVICE_URL ??= "http://lead.test";
    process.env.LEAD_SERVICE_API_KEY ??= "test-lead-key";
    await cleanup();
    batches = [];
    resolves = [];
    runsOpened = [];
    runsClosed = [];
    bobIsLead = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.pathname === "/internal/leads/ids/resolve") {
        resolves.push(body);
        return json({
          people: body.people.map((p: Record<string, unknown>) => ({
            leadId: p.email === "ann@acme.example" ? LEAD_ANN : p.email === "bob@acme.example" && bobIsLead ? LEAD_BOB : p.phone === "+33600000003" ? LEAD_CAT : null,
          })),
        });
      }
      if (url.pathname === "/v1/runs" && init?.method === "POST") {
        const id = `f0f0f0f0-3333-4333-8333-${String(100000000000 + runsOpened.length + 1)}`;
        runsOpened.push(id);
        return json({ id, status: "running" }, 201);
      }
      if (url.pathname.startsWith("/v1/runs/") && init?.method === "PATCH") {
        runsClosed.push(url.pathname.split("/")[3]);
        return json({ id: url.pathname.split("/")[3], status: body.status });
      }
      if (url.pathname === "/v1/platform-runs/outcomes/batch") {
        batches.push(body);
        return json({ allocationVersion: 1, recordedCount: body.runs.length, alreadyRecordedCount: 0, runs: [] }, 201);
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    });
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("one occurrence per submission on its lead, as of the submission, on a run of its own; a booking form is skipped; a non-lead waits", async () => {
    const pass = await runFormSubmittedPass(Date.now());
    expect(pass).toMatchObject({ recorded: 4, due: 4, declared: 2, skipped: 1, waiting: 1, refused: 0, failed: 0 });
    expect(resolves).toHaveLength(1);
    expect(resolves[0].people).toEqual([
      { orgId: ORG, brandIds: [BRAND], email: "ann@acme.example" },
      { orgId: ORG, brandIds: [BRAND], email: "bob@acme.example" },
      { orgId: ORG, brandIds: [BRAND], phone: "+33600000003" },
    ]);
    expect(runsOpened).toHaveLength(2);
    expect(runsClosed).toEqual(runsOpened);
    expect(batches).toEqual([
      {
        runs: [
          { runId: runsOpened[0], produced: [{ outcomeKey: "form_submitted", subjectService: "lead-service", subjectId: LEAD_ANN }], occurredAt: "2026-10-15T11:00:00.000Z" },
          { runId: runsOpened[1], produced: [{ outcomeKey: "form_submitted", subjectService: "lead-service", subjectId: LEAD_CAT }], occurredAt: "2026-10-18T22:00:00.000Z" },
        ],
      },
    ]);
    const rows = await db.select().from(formSubmittedDeclarations).where(eq(formSubmittedDeclarations.brandId, BRAND));
    const by = new Map(rows.map((r) => [r.submissionExternalId, r]));
    expect(by.get("sub-booking")).toMatchObject({ status: "skipped", reason: "calendar_booking_form" });
    expect(by.get("sub-bob")).toMatchObject({ status: "pending", reason: "not_a_lead_yet", runId: null });
    expect(by.has("sub-undated")).toBe(false);
  });

  it("a re-run records and declares nothing; the person who becomes a lead later is declared then, still as of the form", async () => {
    await runFormSubmittedPass(Date.now());
    batches = [];
    await due();
    const again = await runFormSubmittedPass(Date.now());
    expect(again).toMatchObject({ recorded: 0, due: 1, declared: 0, waiting: 1 });
    expect(batches).toEqual([]);

    bobIsLead = true;
    await due();
    const later = await runFormSubmittedPass(Date.now());
    expect(later).toMatchObject({ recorded: 0, due: 1, declared: 1 });
    expect(batches[0].runs).toEqual([
      { runId: runsOpened[2], produced: [{ outcomeKey: "form_submitted", subjectService: "lead-service", subjectId: LEAD_BOB }], occurredAt: "2026-10-16T20:00:00.000Z" },
    ]);
  });

  it("a declaration retried after its run was opened names the SAME run (a replay at runs-service records nothing new)", async () => {
    await runFormSubmittedPass(Date.now());
    const [ann] = await db.select().from(formSubmittedDeclarations).where(eq(formSubmittedDeclarations.submissionExternalId, "sub-ann"));
    await db.update(formSubmittedDeclarations).set({ status: "pending", nextAt: new Date(0) }).where(eq(formSubmittedDeclarations.id, ann.id));
    batches = [];
    const opened = runsOpened.length;
    await runFormSubmittedPass(Date.now());
    expect(runsOpened).toHaveLength(opened);
    expect(batches[0].runs[0]).toMatchObject({ runId: ann.runId, occurredAt: "2026-10-15T11:00:00.000Z" });
  });
});
