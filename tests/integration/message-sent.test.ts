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
    leadOf = (p) => (p.email === "ann@acme.example" ? LEAD_ANN : null);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
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
      { runs: [{ runId: RUN_A, produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD_ANN }], occurredAt: "2026-10-12T14:00:00.000Z" }] },
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

  it("a person still not a lead 7 days after the send was first recorded is given up (no_lead)", async () => {
    await runMessageSentPass(Date.now());
    const later = Date.now() + 8 * 24 * 3_600_000;
    const pass = await runMessageSentPass(later);
    expect(pass).toMatchObject({ due: 1, noLead: 1, declared: 0 });
    const [bob] = await db.select().from(messageSentDeclarations).where(eq(messageSentDeclarations.runId, RUN_B));
    expect(bob.status).toBe("no_lead");
  });
});
