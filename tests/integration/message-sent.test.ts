import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { messageSentDeclarations, whatsappSends } from "../../src/db/schema.js";
import { runMessageSentPass } from "../../src/lib/whatsapp/message-sent.js";

/**
 * LEDGER-HISTORY-1024 against a real database: a WhatsApp message a CAMPAIGN sent is declared ONCE at runs-service as
 * `message_sent` (subject lead-service, the lead) on the run that sent it, as of the send time. A send with no campaign
 * (the Copilot, a probe) states nothing. lead-service + runs-service stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "3e3e3e3e-2222-4222-8222-000000000001";
const BRAND = "3e3e3e3e-2222-4222-8222-000000000002";
const CAMPAIGN = "3e3e3e3e-2222-4222-8222-000000000003";
const RUN_A = "3e3e3e3e-2222-4222-8222-0000000000a1";
const RUN_B = "3e3e3e3e-2222-4222-8222-0000000000b1";
const RUN_COPILOT = "3e3e3e3e-2222-4222-8222-0000000000c1";
const LEAD_ANN = "3e3e3e3e-2222-4222-8222-0000000000d1";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let batches: Array<{ runs: Array<Record<string, unknown>> }> = [];
let resolves: Array<{ people: Array<Record<string, unknown>> }> = [];
// The written messages the ledger holds (runs-service `GET /internal/outcome-occurrences`), and whether it answers.
const writtenUnit = (declaredAt: string, over: Record<string, unknown> = {}) => ({
  id: "w", runId: "w-run", direction: "produced", outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD_ANN, declaredAt, reversal: null, ...over,
});
let written: Array<Record<string, unknown>> = [];
let ledgerDown = false;
let ledgerReads: string[] = [];
let leadOf: (p: Record<string, unknown>) => string | null = (p) => (p.email === "ann@acme.example" ? LEAD_ANN : null);

async function seed() {
  const send = (key: string, runId: string, campaignId: string | null, email: string | null, phone: string, sentAt: string) => ({
    orgId: ORG, brandId: BRAND, idempotencyKey: key, email, phone, text: "hi", status: "sent", runId, campaignId, sentAt: new Date(sentAt),
  });
  await db.insert(whatsappSends).values([
    send("cold:ann:1", RUN_A, CAMPAIGN, "Ann@acme.example", "+33600000001", "2026-10-12T14:00:00Z"),
    send("cold:ann:1#bubble-2", RUN_A, CAMPAIGN, "Ann@acme.example", "+33600000001", "2026-10-12T14:00:05Z"),
    send("cold:bob:1", RUN_B, CAMPAIGN, null, "+33600000002", "2026-10-12T15:00:00Z"),
    send("copilot:m1", RUN_COPILOT, null, null, "+33600000003", "2026-10-18T10:00:00Z"),
  ]);
  await db.insert(whatsappSends).values({ orgId: ORG, brandId: BRAND, idempotencyKey: "cold:carl:1", phone: "+33600000004", text: "hi", status: "refused", runId: RUN_B, campaignId: CAMPAIGN });
}

async function cleanup() {
  await db.delete(messageSentDeclarations).where(eq(messageSentDeclarations.brandId, BRAND));
  await db.delete(whatsappSends).where(eq(whatsappSends.brandId, BRAND));
}

describe.skipIf(!RUN)("message_sent declared on the run that sent a campaign's WhatsApp message (LEDGER-HISTORY-1024)", () => {
  beforeEach(async () => {
    process.env.LEAD_SERVICE_URL ??= "http://lead.test";
    process.env.LEAD_SERVICE_API_KEY ??= "test-lead-key";
    await cleanup();
    batches = [];
    resolves = [];
    written = [writtenUnit("2026-10-12T13:59:00.000Z")];
    ledgerDown = false;
    ledgerReads = [];
    leadOf = (p) => (p.email === "ann@acme.example" ? LEAD_ANN : null);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/outcome-occurrences") {
        ledgerReads.push(url.search);
        if (ledgerDown) return json({ error: "down" }, 503);
        return json({ occurrences: written, nextCursor: null });
      }
      const body = JSON.parse(String(init?.body));
      if (url.pathname === "/internal/leads/ids/resolve") {
        resolves.push(body);
        return json({ people: body.people.map((p: Record<string, unknown>) => ({ leadId: leadOf(p) })) });
      }
      if (url.pathname === "/v1/platform-runs/outcomes/batch") {
        batches.push(body);
        return json({ allocationVersion: 1, recordedCount: body.runs.length, alreadyRecordedCount: 0, runs: [] }, 201);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("one occurrence per campaign send run, on its lead, as of the send; the Copilot's send and a refusal state nothing; a re-run declares nothing", async () => {
    const pass = await runMessageSentPass(Date.now());
    expect(pass).toMatchObject({ recorded: 2, due: 2, declared: 1, waiting: 1, refused: 0, failed: 0 });
    expect(resolves[0].people).toEqual([
      { orgId: ORG, brandIds: [BRAND], email: "ann@acme.example", phone: "+33600000001" },
      { orgId: ORG, brandIds: [BRAND], phone: "+33600000002" },
    ]);
    expect(batches).toEqual([
      // UNIT-LINK-COVERAGE-1117: the send consumes the message written for the same lead (the ledger links written -> sent).
      { runs: [{ runId: RUN_A, produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD_ANN }], consumed: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD_ANN }], occurredAt: "2026-10-12T14:00:00.000Z" }] },
    ]);
    const rows = await db.select().from(messageSentDeclarations).where(eq(messageSentDeclarations.brandId, BRAND));
    expect(Object.fromEntries(rows.map((r) => [r.runId, [r.status, r.reason]]))).toEqual({
      [RUN_A]: ["declared", null],
      [RUN_B]: ["pending", "not_a_lead_yet"],
    });

    const again = await runMessageSentPass(Date.now());
    expect(again).toMatchObject({ recorded: 0, due: 0 });
    expect(batches).toHaveLength(1);
  });

  const consumedOf = () => batches.flatMap((b) => b.runs.map((r) => (r.consumed as Array<{ outcomeKey: string }>).map((c) => c.outcomeKey)));
  const rowA = async () => (await db.select().from(messageSentDeclarations).where(eq(messageSentDeclarations.runId, RUN_A)))[0];

  it("WHATSAPP-SEND-STANDING-1118: asks the ledger for the lead's written messages, produced only", async () => {
    await runMessageSentPass(Date.now());
    const q = new URLSearchParams(ledgerReads[0]);
    expect(Object.fromEntries(q)).toMatchObject({ subjectService: "lead-service", subjectIds: LEAD_ANN, outcomeKey: "message_written", direction: "produced" });
  });

  it("WHATSAPP-SEND-STANDING-1118: no written message standing = the send is declared consuming NOTHING, never a Unit nobody produced", async () => {
    written = [];
    const pass = await runMessageSentPass(Date.now());
    expect(pass).toMatchObject({ declared: 1, failed: 0 });
    expect(batches[0].runs[0]).toMatchObject({ runId: RUN_A, produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD_ANN }], consumed: [] });
    expect((await rowA()).status).toBe("declared");
  });

  it("WHATSAPP-SEND-STANDING-1118: a reversed written message, another lead's, or one dated after the send's day does not stand", async () => {
    written = [
      writtenUnit("2026-10-12T13:59:00.000Z", { reversal: { reversedAt: "2026-10-13T00:00:00.000Z" } }),
      writtenUnit("2026-10-12T13:59:00.000Z", { subjectId: "3e3e3e3e-2222-4222-8222-0000000000ff" }),
      writtenUnit("2026-10-16T06:37:05.342Z"),
    ];
    await runMessageSentPass(Date.now());
    expect(consumedOf()).toEqual([[]]);
  });

  it("WHATSAPP-SEND-STANDING-1118: a written message declared later the same UTC day stands (runs-service's date rule)", async () => {
    written = [writtenUnit("2026-10-12T23:59:59.999Z")];
    await runMessageSentPass(Date.now());
    expect(consumedOf()).toEqual([["message_written"]]);
  });

  it("WHATSAPP-SEND-STANDING-1118: an unreadable ledger declares nothing that pass, then the send is declared once it answers", async () => {
    ledgerDown = true;
    const now = Date.now();
    const pass = await runMessageSentPass(now);
    expect(pass).toMatchObject({ declared: 0, failed: 1 });
    expect(batches).toEqual([]);
    expect(await rowA()).toMatchObject({ status: "pending", reason: "ledger_unreadable" });

    ledgerDown = false;
    const later = await runMessageSentPass(now + 2 * 3_600_000);
    expect(later).toMatchObject({ declared: 1 });
    expect(consumedOf()).toEqual([["message_written"]]);
  });

  it("WHATSAPP-SEND-STANDING-1118: within the hour of the send, a written message not on the ledger yet is waited for", async () => {
    written = [];
    const sentAt = Date.parse("2026-10-12T14:00:00Z");
    const pass = await runMessageSentPass(sentAt + 5 * 60_000);
    expect(pass).toMatchObject({ due: 1, declared: 0, waiting: 1, failed: 0 });
    expect(batches).toEqual([]);
    expect(await rowA()).toMatchObject({ status: "pending", reason: "written_message_not_on_ledger_yet" });

    // The writer's declaration lands: the next pass links the send to it.
    written = [writtenUnit("2026-10-12T13:59:00.000Z")];
    await runMessageSentPass(sentAt + 50 * 60_000);
    expect(consumedOf()).toEqual([["message_written"]]);
  });

  it("a person still not a lead 7 days after the send was first recorded is given up (no_lead)", async () => {
    await runMessageSentPass(Date.now());
    const later = Date.now() + 8 * 24 * 3_600_000;
    const pass = await runMessageSentPass(later);
    expect(pass).toMatchObject({ due: 1, noLead: 1, declared: 0 });
    const [bob] = await db.select().from(messageSentDeclarations).where(eq(messageSentDeclarations.runId, RUN_B));
    expect(bob.status).toBe("no_lead");
  });
});
