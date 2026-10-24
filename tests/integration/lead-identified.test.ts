import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversationVerdicts, leadIdentifiedDeclarations, people, peopleScopes } from "../../src/db/schema.js";
import { runLeadIdentifiedPass } from "../../src/lib/people/lead-identified.js";

/**
 * COST-ACCOUNTING-1024 against a real database: a crm relation (human x company) tagged professional_to_brand by a
 * judged conversation is declared ONCE at runs-service as `lead_identified` (subject crm-service, the relation key)
 * on the run whose Jev call judged it, as of the judgment time. runs-service stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "1d1d1d1d-2222-4222-8222-000000000001";
const BRAND = "1d1d1d1d-2222-4222-8222-000000000002";
const RUN_A = "1d1d1d1d-2222-4222-8222-0000000000a1";
const RUN_B = "1d1d1d1d-2222-4222-8222-0000000000b1";
const REL_ACME = "rel:1d1d1d1d-2222-4222-8222-0000000000c1:org:acme";
const REL_FRIEND = "rel:1d1d1d1d-2222-4222-8222-0000000000c2:personal";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: { headers: Headers; body: { runs: Array<Record<string, unknown>> } }[] = [];
let answer: (body: { runs: Array<{ runId: string }> }) => Response = (b) =>
  json({ allocationVersion: 1, recordedCount: b.runs.length, alreadyRecordedCount: 0, runs: [] }, 201);

const tag = (t: string, conversationKey: string) => ({ tag: t, userIds: [], brandId: BRAND, basis: [{ kind: "conversation", ref: conversationKey, probability: 0.9 }] });

async function seed() {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "u1", status: "built" }).returning();
  await db.insert(people).values({
    scopeId: scope.id, orgId: ORG, brandId: BRAND, personKey: "email:ann@acme.example", identityKeys: ["email:ann@acme.example"],
    displayName: "Ann", emails: ["ann@acme.example"], phones: [], sources: ["gmail", "matrix"], presences: [], mergeEvidence: [],
    state: "in_conversation", stateSource: "gmail",
    relations: [
      { relationKey: REL_ACME, capacity: "professional", companyId: "acme", tags: [tag("professional_to_brand", "gmail:ann@acme.example"), tag("professional_to_brand", "matrix:conv-ann")] },
      { relationKey: REL_FRIEND, capacity: "personal", companyId: null, tags: [tag("personal_to_user", "matrix:conv-friend")] },
    ],
  });
  const verdict = (conversationKey: string, runId: string, judgedAt: Date) => ({
    orgId: ORG, brandId: BRAND, conversationKey, source: conversationKey.split(":")[0], offerIds: [], contextHash: "h", judgedThrough: "t",
    input: {}, runId, judgedAt, tags: ["professional_to_brand"],
  });
  await db.insert(conversationVerdicts).values([
    verdict("gmail:ann@acme.example", RUN_A, new Date("2026-10-18T10:00:00Z")),
    verdict("matrix:conv-ann", RUN_B, new Date("2026-10-19T10:00:00Z")),
    verdict("matrix:conv-friend", RUN_B, new Date("2026-10-19T10:00:00Z")),
  ]);
}

async function cleanup() {
  await db.delete(leadIdentifiedDeclarations).where(eq(leadIdentifiedDeclarations.brandId, BRAND));
  await db.delete(conversationVerdicts).where(eq(conversationVerdicts.brandId, BRAND));
  await db.delete(people).where(eq(people.brandId, BRAND));
  await db.delete(peopleScopes).where(eq(peopleScopes.brandId, BRAND));
}

describe.skipIf(!RUN)("lead_identified declared on the run that judged it (COST-ACCOUNTING-1024)", () => {
  beforeEach(async () => {
    await cleanup();
    calls = [];
    answer = (b) => json({ allocationVersion: 1, recordedCount: b.runs.length, alreadyRecordedCount: 0, runs: [] }, 201);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/platform-runs/outcomes/batch") {
        const body = JSON.parse(String(init?.body));
        calls.push({ headers: new Headers(init?.headers), body });
        return answer(body);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("one occurrence per relation, on the run of its FIRST judged conversation, as of that judgment; a re-run declares nothing", async () => {
    const pass = await runLeadIdentifiedPass();
    expect(pass).toMatchObject({ recorded: 1, duplicates: 1, due: 1, refused: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("x-service-name")).toBe("crm-service");
    expect(calls[0].body.runs).toEqual([
      {
        runId: RUN_A,
        produced: [{ outcomeKey: "lead_identified", subjectService: "crm-service", subjectId: REL_ACME }],
        occurredAt: "2026-10-18T10:00:00.000Z",
      },
    ]);
    const rows = await db.select().from(leadIdentifiedDeclarations).where(eq(leadIdentifiedDeclarations.brandId, BRAND));
    expect(rows.map((r) => [r.conversationKey, r.status]).sort()).toEqual([
      ["gmail:ann@acme.example", "declared"],
      ["matrix:conv-ann", "duplicate_subject"],
    ]);

    const again = await runLeadIdentifiedPass();
    expect(again).toMatchObject({ recorded: 0, duplicates: 0, due: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a run runs-service refuses is kept refused, the others of the batch are declared", async () => {
    // Make the second conversation its own relation so two runs are due.
    await db.execute(sql`UPDATE people SET relations = jsonb_set(relations, '{0,tags,1,basis,0,ref}', '"matrix:conv-other"') WHERE brand_id = ${BRAND}`);
    await db.execute(sql`UPDATE people SET relations = relations || ${JSON.stringify([{ relationKey: "rel:x:pro", capacity: "professional", tags: [tag("professional_to_brand", "matrix:conv-ann")] }])}::jsonb WHERE brand_id = ${BRAND}`);
    answer = (b) =>
      b.runs.some((r) => r.runId === RUN_B)
        ? json({ error: "invalid_runs", details: { invalid: [{ runId: RUN_B, reason: "run_not_found" }] } }, 422)
        : json({ allocationVersion: 1, recordedCount: b.runs.length, alreadyRecordedCount: 0, runs: [] }, 201);
    const pass = await runLeadIdentifiedPass();
    expect(pass).toMatchObject({ recorded: 2, refused: 1, failed: 0 });
    expect(calls.at(-1)!.body.runs.map((r) => r.runId)).toEqual([RUN_A]);
    const rows = await db.select().from(leadIdentifiedDeclarations).where(eq(leadIdentifiedDeclarations.brandId, BRAND));
    expect(Object.fromEntries(rows.map((r) => [r.runId + "|" + r.conversationKey, r.status]))).toEqual({
      [`${RUN_A}|gmail:ann@acme.example`]: "declared",
      [`${RUN_B}|matrix:conv-ann`]: "refused",
    });
  });
});
