import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { people, peopleMessageTexts, peopleScopes, replyTriggerReports, senderVerdicts, type PeopleScope } from "../../src/db/schema.js";
import { deliverDueGmailReplies, detectGmailReplies } from "../../src/lib/reply-trigger/gmail.js";

/**
 * The Gmail reply trigger end to end against a real database: a person writes to
 * the brand's connected mailbox (crm-service's Gmail store), the burst is recorded
 * once and reported once to campaign-service's trigger door. runs-service,
 * chat-service (Jev), instantly-service, brand-service and campaign-service are
 * stubbed at `fetch`: nothing leaves the test. Staff addresses only.
 */
const RUN = !!process.env.CRM_TEST_DB;
const run1 = async () => "run-1";

const ORG = "9a11e5e5-1111-4111-8111-000000000001";
const BRAND = "9a11e5e5-1111-4111-8111-000000000002";
const BRAND_B = "9a11e5e5-1111-4111-8111-000000000003";
const ONLY_OFFER = "9a11e5e5-1111-4111-8111-0000000000a1";
const USER = "user-gmail-reply-1";
const PERSON = "qa+gmail-reply@distribute.you";
const SENDING_MAILBOX = "kevin@send-distribute.example";
const OWNER_MAILBOX = "owner@brand-gmail.example";

process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "instantly-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let campaignCalls: { headers: Headers; body: Record<string, unknown> }[] = [];
let jevChoice = "interested";
let jevCalls = 0;

function installFetchStub() {
  campaignCalls = [];
  jevCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "instantly.test" && url.pathname === "/internal/accounts") {
      return json({ accounts: [{ email: SENDING_MAILBOX, mailboxLogin: null }] });
    }
    if (url.host === "brand.test" && /^\/internal\/brands\/[^/]+$/.test(url.pathname)) {
      return json({ brand: { domain: "brand-gmail.example" } });
    }
    if (url.host === "brand.test" && /^\/internal\/brands\/[^/]+\/offers$/.test(url.pathname)) {
      return json({ offers: [{ offerId: ONLY_OFFER, name: "Only", status: "active" }] });
    }
    if (url.pathname === "/orgs/judgments") {
      jevCalls += 1;
      return json({ model: "jev", answers: { reply: { type: "choice", choice: jevChoice, confidence: 0.93, probabilities: { [jevChoice]: 0.93 } } } });
    }
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      campaignCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json({ event: { id: `ev-${campaignCalls.length}`, status: "done", outcome: "ran" }, replayed: false }, 201);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// Relative to now: the delivery window is the last 24h of real time.
const T0 = Date.now() - 30 * 60_000;
const min = (n: number) => new Date(T0 + n * 60_000);

let scope: PeopleScope;

/** One stored Gmail mail; addressed to the person = ours (outbound), else the person's (inbound). */
async function mail(scopeId: string, key: string, at: Date, text: string, to: string[] = [OWNER_MAILBOX], address = PERSON) {
  const direction = to.includes(address) ? "outbound" : "inbound";
  await db.insert(peopleMessageTexts).values({
    scopeId, source: "gmail", unit: address, address, messageKey: key, at, direction, subject: "Your offer", body: text,
    searchText: `Your offer\n${text}`,
    item: { at: at.toISOString(), source: "gmail", channel: "email", kind: "message", direction, subject: "Your offer", text, from: direction === "inbound" ? address : OWNER_MAILBOX, to, ref: { gmailMessageId: key, threadId: "thread-1" } },
  });
}

async function newScope(brandId: string, sources: string[]): Promise<PeopleScope> {
  const [s] = await db.insert(peopleScopes).values({ orgId: ORG, brandId, createdByUserId: USER, status: "built" }).returning();
  await db.insert(people).values({
    scopeId: s.id, orgId: ORG, brandId, personKey: `email:${PERSON}`, identityKeys: [`email:${PERSON}`],
    displayName: "QA Gmail", emails: [PERSON], phones: [], sources, mergeEvidence: [],
    presences: sources.map((source) => ({ source, sourceRef: PERSON, displayName: "QA Gmail", company: null, emails: [PERSON], phones: [],
      firstActivityAt: null, lastActivityAt: null, messageCount: 1, inboundCount: 1, outboundCount: 1, detail: {} })),
    state: "in_conversation", stateSource: sources[0],
  });
  return s;
}

async function startWatch(s: PeopleScope): Promise<PeopleScope> {
  expect((await detectGmailReplies(s, run1)).baseline).toBe(true);
  await db.update(peopleScopes).set({ gmailReplyWatchSince: new Date(T0) }).where(eq(peopleScopes.id, s.id));
  const [fresh] = await db.select().from(peopleScopes).where(eq(peopleScopes.id, s.id));
  return fresh;
}

async function reports() {
  return db.select().from(replyTriggerReports).where(inArray(replyTriggerReports.brandId, [BRAND, BRAND_B]));
}

async function cleanup() {
  await db.delete(replyTriggerReports).where(inArray(replyTriggerReports.brandId, [BRAND, BRAND_B]));
  await db.delete(senderVerdicts).where(eq(senderVerdicts.orgId, ORG));
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG)); // cascades people + the Gmail store
}

describe.skipIf(!RUN)("Gmail reply trigger", () => {
  beforeEach(async () => {
    await cleanup();
    jevChoice = "interested";
    installFetchStub();
    scope = await newScope(BRAND, ["gmail", "instantly"]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  it("a new mail is ONE trigger event, once; a second mail of the same burst does not double it", async () => {
    await mail(scope.id, "m-history", min(-60), "an old mail, before the watch");
    scope = await startWatch(scope);
    await mail(scope.id, "m1", min(1), "Hi, I saw your email, how much is it?");
    await mail(scope.id, "m2", min(2), "Also, do you work with agencies?");

    const d = await detectGmailReplies(scope, run1);
    expect(d).toMatchObject({ detected: 1, threadsRead: 1 });
    expect(jevCalls).toBe(1);
    expect((await detectGmailReplies(scope, run1)).detected).toBe(0);

    await deliverDueGmailReplies();
    await deliverDueGmailReplies();
    expect(campaignCalls).toHaveLength(1);
    const call = campaignCalls[0];
    expect(call.headers.get("x-org-id")).toBe(ORG);
    expect(call.headers.get("x-brand-id")).toBe(BRAND);
    expect(call.body).toMatchObject({
      triggerId: "positive_reply_received",
      brandId: BRAND,
      offerId: ONLY_OFFER,
      idempotencyKey: `crm:gmail:reply:${BRAND}:m1`,
      occurredAt: min(1).toISOString(),
      person: { email: PERSON, name: "QA Gmail" },
      item: { kind: "reply", source: "gmail", channel: "email", campaignId: null, address: PERSON, threadId: "thread-1" },
    });
    const messages = (call.body.item as { messages: { messageId: string }[] }).messages.map((m) => m.messageId);
    expect(messages).toEqual(["m1", "m2"]); // never the history before the watch

    // A third mail in the same burst, after the report: still the same burst, nothing more.
    await mail(scope.id, "m3", min(3), "Hello?");
    expect((await detectGmailReplies(scope, run1)).detected).toBe(0);
    await deliverDueGmailReplies();
    expect(campaignCalls).toHaveLength(1);
    const [row] = await reports();
    expect(row).toMatchObject({ status: "reported", source: "gmail", channel: "email", address: PERSON, email: PERSON, offerBasis: "only_offer" });
  });

  it("an answer typed by us ends the burst: the person's next mail is a new report", async () => {
    scope = await startWatch(scope);
    await mail(scope.id, "m1", min(1), "Is this still available?");
    expect((await detectGmailReplies(scope, run1)).detected).toBe(1);
    await deliverDueGmailReplies();

    // The owner answers by hand in Gmail: nobody is waiting any more.
    await mail(scope.id, "o1", min(4), "Yes it is, here are the details", [PERSON]);
    expect((await detectGmailReplies(scope, run1)).detected).toBe(0);

    await mail(scope.id, "m2", min(6), "Great, let's book a call");
    expect((await detectGmailReplies(scope, run1)).detected).toBe(1);
    await deliverDueGmailReplies();
    expect(campaignCalls.map((c) => c.body.idempotencyKey)).toEqual([`crm:gmail:reply:${BRAND}:m1`, `crm:gmail:reply:${BRAND}:m2`]);
    const second = (campaignCalls[1].body.item as { messages: { messageId: string }[] }).messages.map((m) => m.messageId);
    expect(second).toEqual(["m2"]);
  });

  it("a cold-email reply (addressed to one of our sending mailboxes) is the email path's: never reported here", async () => {
    scope = await startWatch(scope);
    await mail(scope.id, "c1", min(1), "Thanks for reaching out, tell me more", [SENDING_MAILBOX]);
    const d = await detectGmailReplies(scope, run1);
    expect(d.detected).toBe(0);
    expect(d.skipped).toEqual([{ reason: "cold_email_path", address: PERSON }]);
    expect(jevCalls).toBe(0);
    await deliverDueGmailReplies();
    expect(campaignCalls).toHaveLength(0);
  });

  it("an automated sender is no answer", async () => {
    scope = await startWatch(scope);
    await db.insert(senderVerdicts).values({ orgId: ORG, email: PERSON, verdict: "automated", confidence: 0.9, probabilities: {}, input: {}, model: "jev", runId: "r" });
    await mail(scope.id, "m1", min(1), "Your receipt");
    const d = await detectGmailReplies(scope, run1);
    expect(d.skipped).toEqual([{ reason: "automated_reply", address: PERSON }]);
    await deliverDueGmailReplies();
    expect(campaignCalls).toHaveLength(0);
  });

  it("Gmail is per org: a mail is reported under the brand that knows the person outside the mailbox, not every brand", async () => {
    const other = await startWatch(await newScope(BRAND_B, ["gmail"]));
    scope = await startWatch(scope);
    for (const s of [scope, other]) await mail(s.id, "m1", min(1), "Hi, interested");
    expect((await detectGmailReplies(other, run1)).notOwner).toBe(1);
    expect((await detectGmailReplies(scope, run1)).detected).toBe(1);
    await deliverDueGmailReplies();
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0].body.brandId).toBe(BRAND);
    expect((await reports()).map((r) => r.brandId)).toEqual([BRAND]);
  });
});
