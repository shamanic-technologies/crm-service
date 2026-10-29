import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { people, peopleMessageTexts, peopleScopes, replyTriggerReports, type PeopleScope } from "../../src/db/schema.js";
import { detectGmailReplies } from "../../src/lib/reply-trigger/gmail.js";
import { declareDuePositiveReplies, OUTCOME_GIVE_UP_MS } from "../../src/lib/reply-trigger/outcome.js";
import { backfillPositiveReplies } from "../../src/lib/reply-trigger/outcome-backfill.js";

/**
 * COST-ACCOUNTING-1023-P1 end to end against a real database: a person answers the brand's mailbox, Jev judges
 * it positive on the pass's `reply-trigger.judge` child run, and the reply is declared ONCE at runs-service as
 * `conversation` (Positive reply) produced, `message_sent` consumed, both on the person's lead in lead-service.
 * runs-service, chat-service (Jev), lead-service, instantly-service, brand-service, client-service stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;
const PASS_RUN = "e9f0a1b2-5555-4555-8555-0000000000f0";
const JUDGE_RUN = "e9f0a1b2-5555-4555-8555-0000000000f1";
const run1 = async () => PASS_RUN;

const ORG = "e9f0a1b2-5555-4555-8555-000000000001";
const BRAND = "e9f0a1b2-5555-4555-8555-000000000002";
const LEAD = "e9f0a1b2-5555-4555-8555-0000000000d1";
const USER = "user-reply-outcome-1";
const PERSON = "qa+reply-outcome@distribute.you";
const OWNER_MAILBOX = "owner@brand-outcome.example";

process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "instantly-key";
process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "google-key";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let runCreates: { headers: Headers; body: Record<string, unknown> }[] = [];
let declarations: { runId: string; headers: Headers; body: Record<string, unknown> }[] = [];
let resolveAsks: Record<string, unknown>[] = [];
let leadId: string | null = LEAD;
let declareAnswer: { status: number; body: unknown } = { status: 201, body: { runId: JUDGE_RUN, recordedCount: 2, alreadyRecordedCount: 0 } };
let jevChoice = "interested";
let listedRuns: Array<Record<string, unknown>> = [];
let runListAsks: URL[] = [];

function installFetchStub() {
  runCreates = [];
  declarations = [];
  resolveAsks = [];
  runListAsks = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const outcomes = url.pathname.match(/^\/v1\/runs\/([^/]+)\/outcomes$/);
    if (outcomes) {
      declarations.push({ runId: outcomes[1], headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json(declareAnswer.body, declareAnswer.status);
    }
    if (url.pathname === "/v1/runs" && init?.method === "POST") {
      const body = JSON.parse(String(init?.body));
      runCreates.push({ headers: new Headers(init?.headers), body });
      return json({ id: body.taskName === "reply-trigger.judge" ? JUDGE_RUN : "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.pathname === "/v1/runs" && (init?.method ?? "GET") === "GET") {
      runListAsks.push(url);
      return json({ runs: listedRuns, offset: 0 });
    }
    if (url.pathname.startsWith("/v1/runs")) return json({ id: "patched" });
    if (url.host === "instantly.test" && url.pathname === "/internal/accounts") return json({ accounts: [] });
    if (url.host === "instantly.test" && url.pathname === "/orgs/reply-ownership") {
      const body = JSON.parse(String(init?.body)) as { messages: { from: string }[] };
      return json({ messages: body.messages.map((m) => ({ from: m.from, owner: "none", reason: "no_sequence" })) });
    }
    if (url.host === "brand.test" && /^\/internal\/brands\/[^/]+$/.test(url.pathname)) return json({ brand: { domain: "brand-outcome.example" } });
    if (url.host === "google.test" && url.pathname === "/orgs/google/accounts") return json({ accounts: [{ email: OWNER_MAILBOX }] });
    if (url.pathname === "/orgs/judgments") {
      return json({ model: "jev", answers: { reply: { type: "choice", choice: jevChoice, confidence: 0.93, probabilities: { [jevChoice]: 0.93 } } } });
    }
    if (url.host === "lead.test" && url.pathname === "/internal/leads/ids/resolve") {
      const body = JSON.parse(String(init?.body));
      resolveAsks.push(...body.people);
      return json({ people: body.people.map(() => ({ leadId, matchedBy: leadId ? "email" : null })) });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const T0 = Date.now() - 30 * 60_000;
const min = (n: number) => new Date(T0 + n * 60_000);
let scope: PeopleScope;

async function mail(key: string, at: Date, text: string, outbound = false) {
  const direction = outbound ? "outbound" : "inbound";
  const to = outbound ? [PERSON] : [OWNER_MAILBOX];
  await db.insert(peopleMessageTexts).values({
    scopeId: scope.id, source: "gmail", unit: PERSON, address: PERSON, messageKey: key, at, direction, subject: "Your offer", body: text,
    searchText: `Your offer\n${text}`,
    item: { at: at.toISOString(), source: "gmail", channel: "email", kind: "message", direction, subject: "Your offer", text, from: outbound ? OWNER_MAILBOX : PERSON, to, ref: { gmailMessageId: key, threadId: "thread-1" } },
  });
}

async function seed(sources: string[]) {
  const [s] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();
  await db.insert(people).values({
    scopeId: s.id, orgId: ORG, brandId: BRAND, personKey: `email:${PERSON}`, identityKeys: [`email:${PERSON}`],
    displayName: "QA Outcome", emails: [PERSON], phones: [], sources, mergeEvidence: [],
    presences: sources.map((source) => ({ source, sourceRef: PERSON, displayName: "QA Outcome", company: null, emails: [PERSON], phones: [],
      firstActivityAt: null, lastActivityAt: null, messageCount: 1, inboundCount: 1, outboundCount: 1, detail: {} })),
    state: "in_conversation", stateSource: sources[0],
  });
  expect((await detectGmailReplies(s, run1)).baseline).toBe(true);
  await db.update(peopleScopes).set({ gmailReplyWatchSince: new Date(T0) }).where(eq(peopleScopes.id, s.id));
  [scope] = await db.select().from(peopleScopes).where(eq(peopleScopes.id, s.id));
}

async function report() {
  const rows = await db.select().from(replyTriggerReports).where(eq(replyTriggerReports.brandId, BRAND));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function cleanup() {
  await db.delete(replyTriggerReports).where(eq(replyTriggerReports.brandId, BRAND));
  await db.delete(people).where(eq(people.brandId, BRAND));
  const scopes = await db.select({ id: peopleScopes.id }).from(peopleScopes).where(eq(peopleScopes.brandId, BRAND));
  for (const s of scopes) await db.delete(peopleMessageTexts).where(eq(peopleMessageTexts.scopeId, s.id));
  await db.delete(peopleScopes).where(eq(peopleScopes.brandId, BRAND));
}

describe.skipIf(!RUN)("Positive reply declared on its judge run (COST-ACCOUNTING-1023-P1)", () => {
  beforeEach(async () => {
    await cleanup();
    leadId = LEAD;
    jevChoice = "interested";
    declareAnswer = { status: 201, body: { runId: JUDGE_RUN, recordedCount: 2, alreadyRecordedCount: 0 } };
    installFetchStub();
  });
  afterAll(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });

  it("a positive answer to our mail: conversation produced, message_sent consumed, on the lead; a replay records nothing twice", async () => {
    await seed(["gmail"]);
    await mail("out-1", min(1), "Hi, would you like a demo?", true);
    await mail("in-1", min(2), "Yes please, how much is it?");
    expect((await detectGmailReplies(scope, run1)).detected).toBe(1);

    // Jev ran on ONE child run of the pass, task reply-trigger.judge.
    const judge = runCreates.filter((c) => c.body.taskName === "reply-trigger.judge");
    expect(judge).toHaveLength(1);
    expect(judge[0].headers.get("x-run-id")).toBe(PASS_RUN);
    let r = await report();
    expect(r).toMatchObject({ judgeRunId: JUDGE_RUN, wroteBefore: true, outcomeStatus: "pending" });

    const pass = await declareDuePositiveReplies();
    expect(pass.declared).toBe(1);
    expect(resolveAsks).toEqual([{ orgId: ORG, brandIds: [BRAND], email: PERSON }]);
    expect(declarations).toHaveLength(1);
    expect(declarations[0].runId).toBe(JUDGE_RUN);
    expect(declarations[0].headers.get("x-org-id")).toBe(ORG);
    expect(declarations[0].body).toEqual({
      produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: LEAD }],
      consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD }],
    });
    r = await report();
    expect(r).toMatchObject({ outcomeStatus: "declared", outcomeReason: "recorded", outcomeLeadId: LEAD });

    // Nothing left to declare.
    expect((await declareDuePositiveReplies()).due).toBe(0);

    // A replay of the same declaration (row re-armed): runs-service answers already_recorded, same body.
    declareAnswer = { status: 200, body: { runId: JUDGE_RUN, recordedCount: 0, alreadyRecordedCount: 2 } };
    await db.update(replyTriggerReports).set({ outcomeStatus: "pending", outcomeNextAt: new Date(0) }).where(eq(replyTriggerReports.id, r.id));
    await declareDuePositiveReplies();
    expect(declarations[1].body).toEqual(declarations[0].body);
    expect(await report()).toMatchObject({ outcomeStatus: "declared", outcomeReason: "already_recorded" });
  });

  it("a person who wrote first consumes nothing; a non-positive answer declares nothing", async () => {
    await seed(["gmail"]);
    await mail("in-1", min(1), "Hello, how much is your service?");
    await detectGmailReplies(scope, run1);
    expect(await report()).toMatchObject({ wroteBefore: false, outcomeStatus: "pending" });
    await declareDuePositiveReplies();
    expect(declarations[0].body).toEqual({
      produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: LEAD }],
      consumed: [],
    });

    await cleanup();
    installFetchStub();
    jevChoice = "not_interested";
    await seed(["gmail"]);
    await mail("in-2", min(1), "No thanks.");
    await detectGmailReplies(scope, run1);
    // A Lead event (message_received, ONE-AI-CONVERSES-1029), never a Positive reply: no outcome.
    expect(await report()).toMatchObject({ status: "pending", outcomeStatus: null });
    expect((await declareDuePositiveReplies()).due).toBe(0);
    expect(declarations).toHaveLength(0);
  });

  it("a person our cold email wrote to is instantly-service's: not declared here", async () => {
    await seed(["gmail", "instantly"]);
    await mail("in-1", min(1), "Sounds great, let's talk");
    await detectGmailReplies(scope, run1);
    await declareDuePositiveReplies();
    expect(declarations).toHaveLength(0);
    expect(await report()).toMatchObject({ outcomeStatus: "not_ours", outcomeReason: "cold_email_sequence" });
  });

  it("not a lead yet = asked again later; still none after 7 days = no_lead", async () => {
    leadId = null;
    await seed(["gmail"]);
    await mail("in-1", min(1), "Interested, send details");
    await detectGmailReplies(scope, run1);
    await declareDuePositiveReplies();
    let r = await report();
    expect(r).toMatchObject({ outcomeStatus: "pending", outcomeReason: "not_a_lead_yet", outcomeAttempts: 1 });
    expect(r.outcomeNextAt!.getTime()).toBeGreaterThan(Date.now());
    expect(declarations).toHaveLength(0);

    await db
      .update(replyTriggerReports)
      .set({ outcomeNextAt: new Date(0), detectedAt: new Date(Date.now() - OUTCOME_GIVE_UP_MS - 60_000) })
      .where(eq(replyTriggerReports.id, r.id));
    await declareDuePositiveReplies();
    r = await report();
    expect(r).toMatchObject({ outcomeStatus: "no_lead", outcomeReason: "not_a_lead_yet" });
  });

  it("runs-service down = retried; runs-service refusing = refused, kept, never retried", async () => {
    await seed(["gmail"]);
    await mail("in-1", min(1), "Yes, book a call");
    await detectGmailReplies(scope, run1);
    declareAnswer = { status: 503, body: { error: "down" } };
    await declareDuePositiveReplies();
    let r = await report();
    expect(r).toMatchObject({ outcomeStatus: "pending", outcomeReason: "runs_unreachable", outcomeAttempts: 1 });

    declareAnswer = { status: 400, body: { error: "unknown_outcome_key" } };
    await db.update(replyTriggerReports).set({ outcomeNextAt: new Date(0) }).where(eq(replyTriggerReports.id, r.id));
    await declareDuePositiveReplies();
    r = await report();
    expect(r).toMatchObject({ outcomeStatus: "refused", outcomeLeadId: LEAD });
    expect(r.outcomeLastError).toContain("unknown_outcome_key");
    expect((await declareDuePositiveReplies()).due).toBe(0);
  });

  it("COST-BACKFILL-1023-CRM: a positive reply judged before the forward path is declared on the run that judged it, as of its start; a re-run does nothing", async () => {
    await seed(["gmail"]);
    await mail("out-1", min(1), "Hi, would you like a demo?", true);
    await mail("in-1", min(2), "Yes please, how much is it?");
    await detectGmailReplies(scope, run1);
    // What the row looked like before the forward declaration shipped: judged, reported, no outcome state.
    const detectedAt = min(3);
    await db
      .update(replyTriggerReports)
      .set({ judgeRunId: null, wroteBefore: null, outcomeStatus: null, outcomeNextAt: null, detectedAt })
      .where(eq(replyTriggerReports.brandId, BRAND));
    const PAST_RUN = "e9f0a1b2-5555-4555-8555-0000000000f9";
    const at = (ms: number) => new Date(detectedAt.getTime() + ms).toISOString();
    listedRuns = [
      { id: PAST_RUN, serviceName: "crm-service", taskName: "reply-trigger.detect-gmail", startedAt: at(700), totalCostInUsdCents: "0.0103" },
      // A pass that judged nothing (no spend) and another task: never the judge.
      { id: "e9f0a1b2-5555-4555-8555-0000000000fa", serviceName: "crm-service", taskName: "reply-trigger.detect-gmail", startedAt: at(900), totalCostInUsdCents: "0" },
      { id: "e9f0a1b2-5555-4555-8555-0000000000fb", serviceName: "crm-service", taskName: "people.build", startedAt: at(100), totalCostInUsdCents: "5" },
    ];

    const dry = await backfillPositiveReplies({ dryRun: true });
    expect(dry).toMatchObject({ candidates: 1, matched: 1 });
    expect((await report()).outcomeStatus).toBeNull();
    expect(runListAsks[0].searchParams.get("include")).toBe("subtreeCost");

    const pass = await backfillPositiveReplies();
    expect(pass.rows).toEqual([expect.objectContaining({ judgeRunId: PAST_RUN, wroteBefore: true })]);
    expect(await report()).toMatchObject({ judgeRunId: PAST_RUN, wroteBefore: true, outcomeStatus: "pending", outcomeOccurredAt: "run_started_at" });

    await declareDuePositiveReplies();
    expect(declarations).toHaveLength(1);
    expect(declarations[0].runId).toBe(PAST_RUN);
    expect(declarations[0].body).toEqual({
      produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: LEAD }],
      consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD }],
      occurredAt: "run_started_at",
    });
    expect((await backfillPositiveReplies()).candidates).toBe(0);
  });

  it("COST-BACKFILL-1023-CRM: no judging run, or two, = unmatched, never declared", async () => {
    await seed(["gmail"]);
    await mail("in-1", min(1), "Interested, send details");
    await detectGmailReplies(scope, run1);
    await db.update(replyTriggerReports).set({ judgeRunId: null, outcomeStatus: null, outcomeNextAt: null }).where(eq(replyTriggerReports.brandId, BRAND));
    listedRuns = [];
    expect((await backfillPositiveReplies()).unmatched).toEqual({ no_judging_run: 1 });
    expect(await report()).toMatchObject({ outcomeStatus: "unmatched", outcomeReason: "no_judging_run", judgeRunId: null });
    expect((await declareDuePositiveReplies()).due).toBe(0);
    expect((await backfillPositiveReplies()).candidates).toBe(0);
  });
});
