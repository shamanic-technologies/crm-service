import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  ghlConnections,
  ghlOpportunities,
  leadStandingObservations,
  matrixConnections,
  matrixRawEvents,
  people,
  peopleScopes,
  senderVerdicts,
} from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { clearFamiliesCache } from "../../src/lib/people/families.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * DB-backed person-layer tests. Gated on CRM_TEST_DB (CI provisions a throwaway
 * Postgres). google-service, instantly-service, lead-service and runs-service
 * are stubbed at `fetch`; crm-service's own Matrix / GoHighLevel silver is real.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "dddddddd-1111-4111-8111-000000000001";
const BRAND = "dddddddd-1111-4111-8111-000000000002";
const USER = "user-people-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "b";
process.env.FEATURES_SERVICE_URL = "http://features.test";
process.env.FEATURES_SERVICE_API_KEY = "f";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let gmailConnected = false;
/** features-service's lead families (won / hot / lost / cold) for the brand. */
let leadFamilies: { leadId: string; email: string; family: string; lostReason: string | null }[] = [];
let featuresDown = false;
const featuresRequests: Record<string, string>[] = [];
let leadServiceDown = false;
let gmailConversationDown = false;
let aliceNewMessage = false;
const calls: string[] = [];

/** Jev's stub: these addresses are automated, at this confidence; every other address is human. */
let automatedEmails = new Map<string, number>();
let jevDown = false;
const jevRequests: { headers: Record<string, string>; body: { state: { senders: Record<string, { email: string; recentMessages: { subject: string | null }[] }> }; questions: Record<string, unknown> } }[] = [];

/** Extra Gmail correspondents a test adds (an automated digest, a role address). */
let extraCorrespondents: { email: string; name: string | null }[] = [];

const DIGEST = "messaging-digest-noreply@linkedin.com";

const ENGAGED = [
  {
    campaignId: "camp-1",
    instantlyCampaignId: "self:1",
    leadEmail: "Alice@X.com",
    brandIds: [BRAND],
    engagedAt: "2026-09-02T10:00:00.000Z",
    replied: true,
    clicked: false,
    firstRepliedAt: "2026-09-02T10:00:00.000Z",
    firstClickedAt: null,
    replyClassification: "positive",
    replyKind: "lead_interested",
    disqualified: false,
  },
  {
    campaignId: "camp-2",
    instantlyCampaignId: "self:2",
    leadEmail: "bob@y.com",
    brandIds: [BRAND],
    engagedAt: "2026-09-05T08:00:00.000Z",
    replied: false,
    clicked: true,
    firstRepliedAt: null,
    firstClickedAt: "2026-09-05T08:00:00.000Z",
    replyClassification: null,
    replyKind: null,
    disqualified: false,
  },
];

function installFetchStub() {
  calls.length = 0;
  jevRequests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    if (url.host === "localhost:9998" && url.pathname === "/orgs/judgments") {
      if (jevDown) return json({ error: "jev down" }, 503);
      const body = JSON.parse(String(init!.body));
      jevRequests.push({ headers: init!.headers as Record<string, string>, body });
      const answers: Record<string, unknown> = {};
      for (const [key, sender] of Object.entries(body.state.senders as Record<string, { email: string }>)) {
        const confidence = automatedEmails.get(sender.email);
        answers[key] =
          confidence === undefined
            ? { type: "choice", choice: "human", confidence: 0.95, probabilities: { human: 0.97, automated: 0.03 } }
            : { type: "choice", choice: "automated", confidence, probabilities: { human: 1 - confidence, automated: confidence } };
      }
      return json({ model: "jev-test", answers });
    }
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "google.test") {
      if (url.pathname === "/orgs/google/correspondents") {
        if (!gmailConnected) return json({ error: "none", reason: "no_google_account_connected" }, 404);
        return json({
          ownerAddresses: ["me@brand.com"],
          total: 4 + extraCorrespondents.length,
          twoWayTotal: 1,
          limit: 1000,
          offset: 0,
          correspondents: [
            { email: "Alice@x.com", name: "Alice M.", nameSource: "message", outboundMessages: 1, inboundMessages: 1, twoWay: true, firstMessageAt: "2026-09-01T09:00:00.000Z", lastMessageAt: "2026-09-03T09:00:00.000Z", lastOutboundAt: null, lastInboundAt: null },
            // Our own sending mailbox and a colleague on the brand's domain: the brand itself, not people.
            { email: "kevin@send.com", name: "Kevin", nameSource: "message", outboundMessages: 3, inboundMessages: 0, twoWay: false, firstMessageAt: "2026-08-01T09:00:00.000Z", lastMessageAt: "2026-08-02T09:00:00.000Z", lastOutboundAt: null, lastInboundAt: null },
            { email: "colleague@brand.com", name: null, nameSource: null, outboundMessages: 1, inboundMessages: 1, twoWay: true, firstMessageAt: "2026-08-01T09:00:00.000Z", lastMessageAt: "2026-08-02T09:00:00.000Z", lastOutboundAt: null, lastInboundAt: null },
            { email: "carol@z.com", name: null, nameSource: null, outboundMessages: 1, inboundMessages: 0, twoWay: false, firstMessageAt: "2026-08-01T09:00:00.000Z", lastMessageAt: "2026-08-01T09:00:00.000Z", lastOutboundAt: null, lastInboundAt: null },
            ...extraCorrespondents.map((c) => ({ ...c, nameSource: null, outboundMessages: 1, inboundMessages: 3, twoWay: true, firstMessageAt: "2026-07-01T09:00:00.000Z", lastMessageAt: "2026-07-10T09:00:00.000Z", lastOutboundAt: null, lastInboundAt: null })),
          ],
        });
      }
      if (url.pathname === "/orgs/google/contacts") {
        return json({ items: [], nextCursor: null });
      }
      if (url.pathname === "/orgs/google/conversation") {
        if (gmailConversationDown) return json({ error: "boom" }, 500);
        if (!gmailConnected) return json({ reason: "no_google_account_connected" }, 404);
        if (url.searchParams.get("email") === DIGEST) {
          return json({
            address: DIGEST,
            status: "ok",
            threads: [
              {
                threadId: "td",
                messages: [
                  { gmailMessageId: "d1", threadId: "td", direction: "inbound", fromEmail: DIGEST, to: ["me@brand.com"], subject: "Marwene just messaged you", snippet: "You have 1 new message", sentAt: "2026-07-10T09:00:00.000Z", bodyText: null, bodyTextOriginal: null, bodyStatus: "ok", bodyCleanStatus: "not_applicable" },
                ],
              },
            ],
          });
        }
        if (url.searchParams.get("email") !== "alice@x.com") return json({ reason: "no_messages" }, 404);
        return json({
          address: "alice@x.com",
          status: "ok",
          threadCount: 1,
          messageCount: 2,
          truncated: false,
          threads: [
            {
              threadId: "t1",
              messages: [
                {
                  gmailMessageId: "g1",
                  threadId: "t1",
                  direction: "outbound",
                  fromEmail: "me@brand.com",
                  to: ["alice@x.com"],
                  subject: "Intro",
                  snippet: "hi",
                  sentAt: "2026-09-01T09:00:00.000Z",
                  bodyText: "Hi Alice",
                  bodyTextOriginal: "Hi Alice\n\n--\nKevin, Brand\nUnsubscribe: https://brand.com/u",
                  bodyStatus: "ok",
                  bodyCleanStatus: "cleaned",
                },
                {
                  gmailMessageId: "g2",
                  threadId: "t1",
                  direction: "inbound",
                  fromEmail: "alice@x.com",
                  to: ["me@brand.com"],
                  subject: "Re: Intro",
                  snippet: "sure",
                  sentAt: "2026-09-03T09:00:00.000Z",
                  bodyText: "Sure, call me",
                  bodyTextOriginal: "Sure, call me",
                  bodyStatus: "ok",
                  bodyCleanStatus: "nothing_kept",
                },
                ...(aliceNewMessage
                  ? [{ gmailMessageId: "g3", threadId: "t1", direction: "inbound", fromEmail: "alice@x.com", to: ["me@brand.com"], subject: "Re: Intro", snippet: "deck", sentAt: "2026-09-10T09:00:00.000Z", bodyText: "Send me the deck", bodyTextOriginal: "Send me the deck", bodyStatus: "ok", bodyCleanStatus: "cleaned" }]
                  : []),
              ],
            },
          ],
        });
      }
    }
    if (url.host === "features.test" && url.pathname === `/brands/${BRAND}/lead-families`) {
      featuresRequests.push(init!.headers as Record<string, string>);
      if (featuresDown) return json({ error: "Failed to compute brand lead families" }, 502);
      const counts = { won: 0, hot: 0, lost: 0, cold: 0 } as Record<string, number>;
      for (const p of leadFamilies) counts[p.family] += 1;
      return json({ brandId: BRAND, counts, lostBreakdown: { wentCold: 0, ruledOut: 0 }, offers: [], people: leadFamilies.map((p) => ({ ...p, campaignLeadIds: [], offerId: "o1" })) });
    }
    if (url.host === "brand.test") {
      return json({ brand: { id: BRAND, domain: "brand.com" } });
    }
    if (url.host === "instantly.test") {
      if (url.pathname === "/internal/accounts") {
        return json({ accounts: [{ email: "Kevin@send.com", mailboxLogin: "kevin@send.com" }] });
      }
      if (url.pathname === "/orgs/engaged-leads") return json({ success: true, count: ENGAGED.length, leads: ENGAGED });
      if (url.pathname === "/orgs/conversations") {
        const email = url.searchParams.get("email");
        if (url.searchParams.get("campaign_id") !== "camp-1" || email !== "alice@x.com") {
          return json({ error: "campaign_not_found" }, 404);
        }
        return json({
          success: true,
          conversation: {
            campaignId: "camp-1",
            messages: [
              { direction: "outbound", from: "kevin@send.com", to: "alice@x.com", at: "2026-09-02T08:00:00.000Z", subject: "Cold", text: "Cold email", campaignId: "camp-1", instantlyCampaignId: "self:1", outreachFact: { subjectKey: "ievt:evt-1", step: 1, position: "first" } },
              { direction: "inbound", from: "alice@x.com", to: "kevin@send.com", at: "2026-09-02T10:00:00.000Z", subject: "Re: Cold", text: "Interested", campaignId: "camp-1", instantlyCampaignId: "self:1", outreachFact: null },
            ],
          },
        });
      }
    }
    if (url.host === "lead.test") {
      if (leadServiceDown) return json({ error: "down" }, 503);
      if (url.pathname === "/orgs/leads") {
        const q = url.searchParams.get("q");
        if (q === "bob@y.com") {
          return json({
            leads: [
              // A substring hit that is NOT bob, first in lead-service's order: must be ignored.
              { id: "lc-0", leadId: "l-0", email: "jimbob@y.com", campaignId: "camp-9", standing: { state: "customer", tag: "customer" } },
              { id: "lc-2", leadId: "l-2", email: "bob@y.com", campaignId: "camp-2", standing: { state: "engaged", tag: "engaged", signal: "click" } },
            ],
          });
        }
        return json({ leads: [] });
      }
      if (url.pathname === "/orgs/leads/crm-pairings") {
        return json({ crmConnected: true, connection: null, pairings: [], nextOffset: null });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function wipe() {
  await db.execute(sql`TRUNCATE sender_verdicts, people_scopes, people, lead_standing_observations, matrix_raw_events, conversations, matrix_leads, matrix_connections, ghl_opportunities, ghl_connections, contacts CASCADE`);
}

/** Alice in GoHighLevel (email + phone, a won deal) and on WhatsApp (phone only). */
async function seedLocalSources() {
  const [ghl] = await db
    .insert(ghlConnections)
    .values({ orgId: ORG, brandId: BRAND, locationId: "loc", createdByUserId: USER })
    .returning();
  const [aliceGhl] = await db
    .insert(contacts)
    .values({
      orgId: ORG,
      brandId: BRAND,
      source: "gohighlevel",
      externalId: "ghl-alice",
      primaryEmail: "alice@x.com",
      phoneE164: "+33612345678",
      fullName: "Alice Martin",
      companyName: "Acme",
      rawAttributes: {},
      sourceConnectionId: ghl.id,
      sourceUpdatedAt: new Date("2026-08-20T00:00:00Z"),
    })
    .returning();
  await db.insert(ghlOpportunities).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: ghl.id,
    externalId: "opp-1",
    name: "Acme deal",
    status: "won",
    stageName: "Closed",
    pipelineName: "Sales",
    contactId: aliceGhl.id,
  });

  const [mx] = await db
    .insert(matrixConnections)
    .values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: "@me:hs", counterpartPrefix: "@whatsapp_", createdByUserId: USER })
    .returning();
  const [aliceWa] = await db
    .insert(contacts)
    .values({
      orgId: ORG,
      brandId: BRAND,
      source: "matrix",
      channel: "whatsapp",
      channelHandle: "@whatsapp_33612345678:hs",
      phoneE164: "+33612345678",
      fullName: "Alice",
      rawAttributes: {},
      sourceConnectionId: mx.id,
    })
    .returning();
  await db.insert(conversations).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId: mx.id,
    contactId: aliceWa.id,
    channel: "whatsapp",
    roomId: "!room",
    firstMessageAt: new Date("2026-09-04T12:00:00Z"),
    lastMessageAt: new Date("2026-09-04T12:05:00Z"),
    messageCount: 2,
    inboundCount: 1,
    outboundCount: 1,
    lastEventId: "$e2",
  });
  await db.insert(matrixRawEvents).values([
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$e1", roomId: "!room", sender: "@whatsapp_33612345678:hs", eventType: "m.room.message", originServerTs: new Date("2026-09-04T12:00:00Z"), payload: { content: { body: "Hello on WhatsApp" } } },
    { orgId: ORG, brandId: BRAND, connectionId: mx.id, eventId: "$e2", roomId: "!room", sender: "@me:hs", eventType: "m.room.message", originServerTs: new Date("2026-09-04T12:05:00Z"), payload: { content: { body: "Hi Alice" } } },
  ]);
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(peopleRoutes);
  return a;
}

async function buildNow() {
  const { scope } = await ensureScope(ORG, BRAND, USER);
  const result = await runScopeBuild(scope);
  expect(result.ok).toBe(true);
  return result.summary!;
}

describe.skipIf(!RUN)("person layer", () => {
  beforeEach(async () => {
    gmailConnected = false;
    leadServiceDown = false;
    gmailConversationDown = false;
    aliceNewMessage = false;
    automatedEmails = new Map();
    jevDown = false;
    extraCorrespondents = [];
    leadFamilies = [];
    featuresDown = false;
    featuresRequests.length = 0;
    clearFamiliesCache();
    installFetchStub();
    await wipe();
  });

  it("merges one person across GoHighLevel, WhatsApp and cold email, and keeps others apart", async () => {
    await seedLocalSources();
    const summary = await buildNow();

    const rows = await db.select().from(people).orderBy(people.personKey);
    expect(rows.map((r) => r.personKey)).toEqual(["email:alice@x.com", "email:bob@y.com"]);

    const alice = rows[0];
    expect(alice.sources).toEqual(["instantly", "matrix", "gohighlevel"]);
    expect(alice.identityKeys).toEqual(["email:alice@x.com", "phone:+33612345678"]);
    expect(alice.displayName).toBe("Alice Martin");
    expect(alice.company).toBe("Acme");
    // Not one of our leads → the CRM's deal states it.
    expect(alice).toMatchObject({ state: "deal_won", stateSource: "gohighlevel" });

    // bob is a lead: lead-service's standing, of the EXACT address only.
    expect(rows[1]).toMatchObject({ state: "engaged", stateSource: "lead_service" });
    expect((rows[1].stateDetail as { leadCampaignId: string }).leadCampaignId).toBe("lc-2");

    const bySource = Object.fromEntries(summary.sources.map((s) => [s.source, s]));
    expect(bySource.gmail).toMatchObject({ status: "not_connected", presences: 0 });
    expect(bySource.instantly).toMatchObject({ status: "ok", presences: 2, sourceCount: 2 });
    expect(bySource.matrix).toMatchObject({ status: "ok", presences: 1, sourceCount: 1 });
    expect(bySource.gohighlevel).toMatchObject({ status: "ok", presences: 1, sourceCount: 1 });
  });

  it("a person on Gmail and Instantly appears once, their thread interleaved by time", async () => {
    gmailConnected = true;
    await seedLocalSources();
    await buildNow();

    const res = await request(app())
      .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("phone:+33612345678")}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(200);
    expect(res.body.person.personKey).toBe("email:alice@x.com");
    expect(res.body.person.sources).toEqual(["gmail", "instantly", "matrix", "gohighlevel"]);
    // Gmail-only carol is a person of her own; alice is not duplicated; the brand's own addresses are nobody.
    expect((await db.select().from(people)).map((p) => p.personKey).sort()).toEqual([
      "email:alice@x.com",
      "email:bob@y.com",
      "email:carol@z.com",
    ]);
    expect(res.body.items.map((i: { source: string; text: string | null; at: string }) => [i.source, i.text ?? i.at])).toEqual([
      ["gmail", "Hi Alice"],
      ["instantly", "Cold email"],
      ["instantly", "Interested"],
      ["gmail", "Sure, call me"],
      ["matrix", "Hello on WhatsApp"],
      ["matrix", "Hi Alice"],
    ]);
    // google-service's clean flag and the full original reach the reader per Gmail message;
    // an uncleaned fallback (nothing_kept) is never silent. Other sources carry null.
    const textClean = (s: string, text: string) =>
      res.body.items.find((i: { source: string; text: string }) => i.source === s && i.text === text).textClean;
    expect(textClean("gmail", "Hi Alice")).toEqual({
      status: "cleaned",
      cleaned: true,
      original: "Hi Alice\n\n--\nKevin, Brand\nUnsubscribe: https://brand.com/u",
    });
    expect(textClean("gmail", "Sure, call me")).toEqual({ status: "nothing_kept", cleaned: false, original: "Sure, call me" });
    expect(textClean("instantly", "Interested")).toBeNull();
    expect(textClean("matrix", "Hello on WhatsApp")).toBeNull();
    // A sent cold email names its email_sent outreach fact verbatim, so the Unibox pairs it with
    // lead-service's label by identity, not by clock. Inbound mail and other sources carry null.
    const outreachFact = (src: string, text: string) =>
      res.body.items.find((i: { source: string; text: string }) => i.source === src && i.text === text).outreachFact;
    expect(outreachFact("instantly", "Cold email")).toEqual({ subjectKey: "ievt:evt-1", step: 1, position: "first" });
    expect(outreachFact("instantly", "Interested")).toBeNull();
    expect(outreachFact("gmail", "Hi Alice")).toBeNull();
    expect(outreachFact("matrix", "Hello on WhatsApp")).toBeNull();
    const sources = Object.fromEntries(res.body.sources.map((s: { source: string }) => [s.source, s]));
    expect(sources.gmail.status).toBe("ok");
    expect(sources.instantly.status).toBe("ok");
    const [scope] = await db.select().from(peopleScopes);
    const gmailRead = (scope.sourceReads as { sources: { source: string; presences: number; excludedOwn: number; sourceCount: number }[] }).sources.find((s) => s.source === "gmail")!;
    expect(gmailRead).toMatchObject({ presences: 2, excludedOwn: 2, sourceCount: 4 });
    expect(sources.matrix.status).toBe("ok");
    // The won deal carries no dated history row here, so GoHighLevel has nothing to put in the thread.
    expect(sources.gohighlevel.status).toBe("empty");
  });

  it("an unconnected source says so; a failed read says failed, not empty", async () => {
    await buildNow();
    const res = await request(app())
      .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:alice@x.com")}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(200);
    const sources = Object.fromEntries(res.body.sources.map((s: { source: string }) => [s.source, s]));
    expect(sources.gmail.status).toBe("not_connected");
    expect(sources.matrix.status).toBe("not_connected");
    expect(sources.gohighlevel.status).toBe("not_connected");

    leadServiceDown = true;
    await db.delete(leadStandingObservations);
    await buildNow();
    const [bob] = await db.select().from(people).where(eq(people.personKey, "email:bob@y.com"));
    expect(bob).toMatchObject({ state: "unavailable", stateSource: "lead_service" });
  });

  it("the first list read opens the scope and answers 'building', then serves people with per-source counts", async () => {
    await seedLocalSources();
    const first = await request(app())
      .get(`/orgs/people?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(first.status).toBe(200);
    expect(first.body.scope.status).toBe("building");

    // Let the background build finish.
    for (let i = 0; i < 50; i++) {
      const [s] = await db.select().from(peopleScopes);
      if (s?.status === "built") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const res = await request(app())
      .get(`/orgs/people?brandId=${BRAND}&limit=1`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(200);
    expect(res.body.scope.status).toBe("built");
    expect(res.body.total).toBe(2);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.nextOffset).toBe(1);
    // Most recent activity first: bob clicked on Sept 5, after Alice's Sept 4 WhatsApp.
    expect(res.body.people[0].personKey).toBe("email:bob@y.com");
    const instantly = res.body.sources.find((s: { source: string }) => s.source === "instantly");
    expect(instantly).toMatchObject({ status: "ok", people: 2, presences: 2, sourceCount: 2 });
    const gmail = res.body.sources.find((s: { source: string }) => s.source === "gmail");
    expect(gmail).toMatchObject({ status: "not_connected", scope: "org", people: 0 });

    const filtered = await request(app())
      .get(`/orgs/people?brandId=${BRAND}&source=matrix`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.people[0].personKey).toBe("email:alice@x.com");
  });

  describe("family filters (Won / Hot / Lost / Cold)", () => {
    const listPeople = (query = "") =>
      request(app())
        .get(`/orgs/people?brandId=${BRAND}${query}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);

    beforeEach(() => {
      gmailConnected = true;
      leadFamilies = [
        { leadId: "l-a", email: "alice@x.com", family: "won", lostReason: null },
        { leadId: "l-b", email: "bob@y.com", family: "hot", lostReason: null },
        // A lead who is not in the Unibox: counted by features, not by the list.
        { leadId: "l-z", email: "zed@q.com", family: "hot", lostReason: null },
        { leadId: "l-y", email: "yan@q.com", family: "cold", lostReason: null },
      ];
    });

    it("each person carries features-service's family; counts cover the list; carol has none", async () => {
      await seedLocalSources();
      await buildNow();
      const res = await listPeople();
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      const byKey = Object.fromEntries(res.body.people.map((p: { personKey: string; family: string | null }) => [p.personKey, p.family]));
      expect(byKey).toEqual({ "email:alice@x.com": "won", "email:bob@y.com": "hot", "email:carol@z.com": null });
      expect(res.body.families).toMatchObject({
        status: "ok",
        error: null,
        filter: null,
        counts: { won: 1, hot: 1, lost: 0, cold: 0 },
        withFamily: 2,
        withoutFamily: 1,
        producerCounts: { won: 1, hot: 2, lost: 0, cold: 1 },
      });
      // Org-attributed read on this request's run.
      expect(featuresRequests[0]).toMatchObject({ "x-api-key": "f", "x-org-id": ORG, "x-user-id": USER });
      expect(featuresRequests[0]["x-run-id"]).toMatch(/^run-/);
    });

    it("family=hot returns only the hot people, pages them, and combines with search", async () => {
      await seedLocalSources();
      await buildNow();
      const hot = await listPeople("&family=hot");
      expect(hot.status).toBe(200);
      expect(hot.body.total).toBe(1);
      expect(hot.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:bob@y.com"]);
      expect(hot.body.families.filter).toBe("hot");
      // Counts stay the buttons' numbers, not the filtered page's.
      expect(hot.body.families.counts).toEqual({ won: 1, hot: 1, lost: 0, cold: 0 });

      const won = await listPeople("&family=won&limit=1");
      expect(won.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:alice@x.com"]);

      const none = await listPeople("&family=hot&q=alice");
      expect(none.body.total).toBe(0);
      expect(none.body.families.counts).toEqual({ won: 1, hot: 0, lost: 0, cold: 0 });
      const both = await listPeople("&family=won&q=alice");
      expect(both.body.total).toBe(1);
      expect(both.body.people[0].matches.length).toBeGreaterThan(0);

      // One shared read serves every list call.
      expect(featuresRequests).toHaveLength(1);
    });

    it("a failed features read is stated: All still lists, a family filter is a 502", async () => {
      featuresDown = true;
      await seedLocalSources();
      await buildNow();
      const all = await listPeople();
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(3);
      expect(all.body.families).toMatchObject({ status: "failed", counts: null, withFamily: null });
      expect(all.body.families.error).toContain("returned 502");
      expect(all.body.people.every((p: { family: string | null }) => p.family === null)).toBe(true);

      const hot = await listPeople("&family=hot");
      expect(hot.status).toBe(502);
      expect(hot.body.reason).toBe("lead_families_unavailable");

      // A failure is not cached: the next read asks again.
      featuresDown = false;
      const again = await listPeople("&family=hot");
      expect(again.status).toBe(200);
      expect(again.body.total).toBe(1);
    });
  });

  it("rebuilding replaces the gold rows; a cached standing is reused", async () => {
    await seedLocalSources();
    const first = await buildNow();
    expect(first.standing.asked).toBe(2);
    const second = await buildNow();
    expect(second.standing.reused).toBe(2);
    expect(await db.select().from(people)).toHaveLength(2);
  });

  it("a cached standing from before lead-service served a tag is re-asked, never served tagless", async () => {
    await seedLocalSources();
    await buildNow();
    const cached = await db.select().from(leadStandingObservations);
    for (const c of cached.filter((x) => x.found)) {
      const payload = c.payload as { standing: Record<string, unknown> };
      const { tag: _tag, ...standing } = payload.standing;
      await db
        .update(leadStandingObservations)
        .set({ payload: { ...payload, standing } })
        .where(eq(leadStandingObservations.id, c.id));
    }
    const again = await buildNow();
    expect(again.standing.asked).toBe(1);
    expect(again.standing.reused).toBe(1);
  });

  it("an unknown person key is a 404 with a reason", async () => {
    await buildNow();
    const res = await request(app())
      .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:nobody@x.com")}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("person_not_found");
  });

  describe("automated senders", () => {
    const listPeople = (query = "") =>
      request(app())
        .get(`/orgs/people?brandId=${BRAND}${query}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);

    beforeEach(() => {
      gmailConnected = true;
      extraCorrespondents = [
        { email: DIGEST, name: "Marwene Amor via LinkedIn" },
        // A prospect writing from a role address: human unless Jev says otherwise.
        { email: "sales@prospect.com", name: "Prospect Sales" },
      ];
      automatedEmails = new Map([[DIGEST, 0.98]]);
    });

    it("hides a sender Jev judged automated, keeps the role address, and records each verdict once", async () => {
      const summary = await buildNow();
      expect(summary.senderVerdicts).toMatchObject({ status: "ok", reused: 0, pending: 0, automatedPeople: 1, model: "jev-test" });
      // Only Gmail-only people who WROTE are asked: the digest and sales@. Never carol
      // (the owner only wrote to her), never alice / bob (cold-email leads).
      expect(summary.senderVerdicts.judged).toBe(2);

      // One judgments call, org-billed on the build's run, the digest's own mail as input.
      expect(jevRequests).toHaveLength(1);
      expect(jevRequests[0].headers["x-org-id"]).toBe(ORG);
      expect(jevRequests[0].headers["x-user-id"]).toBe(USER);
      expect(jevRequests[0].headers["x-run-id"]).toMatch(/^run-/);
      const digestInput = Object.values(jevRequests[0].body.state.senders).find((s) => s.email === DIGEST)!;
      expect(digestInput.recentMessages[0].subject).toBe("Marwene just messaged you");
      // What the owner wrote to it is shown apart (here: nothing).
      expect((digestInput as unknown as { messagesOwnerSent: unknown[] }).messagesOwnerSent).toEqual([]);

      const list = await listPeople();
      const keys = list.body.people.map((p: { personKey: string }) => p.personKey);
      expect(keys).not.toContain(`email:${DIGEST}`);
      expect(keys).toContain("email:sales@prospect.com");
      expect(list.body.automatedHidden).toBe(1);
      expect(list.body.total).toBe(keys.length);
      expect(list.body.people.every((p: { automated: boolean }) => p.automated === false)).toBe(true);

      const all = await listPeople("&includeAutomated=true");
      expect(all.body.total).toBe(list.body.total + 1);
      const digest = all.body.people.find((p: { personKey: string }) => p.personKey === `email:${DIGEST}`);
      expect(digest).toMatchObject({ automated: true, automatedVerdict: [{ email: DIGEST, verdict: "automated", confidence: 0.98 }] });

      // The source data stays whole: the digest is still counted as read from Gmail.
      const gmail = list.body.sources.find((s: { source: string }) => s.source === "gmail");
      expect(gmail.presences).toBe(4);

      // A rebuild reads the record: no new judgment.
      jevRequests.length = 0;
      const again = await buildNow();
      expect(jevRequests).toHaveLength(0);
      expect(again.senderVerdicts).toMatchObject({ judged: 0, pending: 0, automatedPeople: 1 });
      expect(await db.select().from(senderVerdicts).where(eq(senderVerdicts.email, DIGEST))).toHaveLength(1);
    });

    it("a person known from another source than Gmail is never asked about, nor hidden", async () => {
      // Jev would call them automated if asked: bob replied to our cold email, carol never wrote.
      automatedEmails = new Map([[DIGEST, 0.98], ["bob@y.com", 0.99], ["carol@z.com", 0.99]]);
      await buildNow();
      const asked = jevRequests.flatMap((r) => Object.values(r.body.state.senders).map((s) => s.email)).sort();
      expect(asked).toEqual([DIGEST, "sales@prospect.com"]);
      const keys = (await listPeople()).body.people.map((p: { personKey: string }) => p.personKey);
      expect(keys).toEqual(expect.arrayContaining(["email:bob@y.com", "email:carol@z.com", "email:sales@prospect.com"]));

      // Even a recorded 'automated' verdict does not hide a cold-email lead.
      await db.insert(senderVerdicts).values({
        orgId: ORG, email: "bob@y.com", verdict: "automated", confidence: 0.99, probabilities: {}, input: {}, model: "jev-test", runId: "r",
      });
      await buildNow();
      const [bob] = await db.select().from(people).where(eq(people.personKey, "email:bob@y.com"));
      expect(bob.automated).toBe(false);
    });

    it("a hesitant 'automated' verdict does not hide the person", async () => {
      automatedEmails = new Map([[DIGEST, 0.72]]);
      const summary = await buildNow();
      expect(summary.senderVerdicts.automatedPeople).toBe(0);
      const list = await listPeople();
      expect(list.body.people.map((p: { personKey: string }) => p.personKey)).toContain(`email:${DIGEST}`);
    });

    it("Jev down: nobody is hidden, the failure is reported, and the next build judges", async () => {
      jevDown = true;
      const down = await buildNow();
      expect(down.senderVerdicts.status).toBe("failed");
      expect(down.senderVerdicts.error).toMatch(/judgments/);
      expect(down.senderVerdicts.pending).toBeGreaterThan(0);
      expect(down.senderVerdicts.automatedPeople).toBe(0);
      expect((await listPeople()).body.automatedHidden).toBe(0);

      jevDown = false;
      const up = await buildNow();
      expect(up.senderVerdicts).toMatchObject({ status: "ok", pending: 0, automatedPeople: 1 });
      expect((await listPeople()).body.automatedHidden).toBe(1);
    });
  });

  describe("search", () => {
    const search = (q: string, extra = "") =>
      request(app())
        .get(`/orgs/people?brandId=${BRAND}&q=${encodeURIComponent(q)}${extra}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);
    const keysOf = (res: { body: { people: { personKey: string }[] } }) => res.body.people.map((p) => p.personKey);

    beforeEach(async () => {
      gmailConnected = true;
      await seedLocalSources();
      await buildNow();
    });

    it("finds a person by first name, email domain, company and phone, saying which field matched", async () => {
      const name = await search("alice");
      expect(name.status).toBe(200);
      expect(keysOf(name)).toEqual(["email:alice@x.com"]);
      expect(name.body.people[0].matches).toEqual(
        expect.arrayContaining([
          { field: "name", value: "Alice Martin" },
          { field: "email", value: "alice@x.com" },
        ]),
      );

      const domain = await search("Y.COM");
      expect(keysOf(domain)).toEqual(["email:bob@y.com"]);
      expect(domain.body.people[0].matches).toEqual([{ field: "email", value: "bob@y.com" }]);

      const company = await search("acme");
      expect(keysOf(company)).toEqual(["email:alice@x.com"]);
      expect(company.body.people[0].matches[0]).toEqual({ field: "company", value: "Acme" });

      const phone = await search("612 345");
      expect(keysOf(phone)).toEqual(["email:alice@x.com"]);
      expect(phone.body.people[0].matches[0]).toEqual({ field: "phone", value: "+33612345678" });
    });

    it("finds a person by a word only present in one of their messages, on every channel, with an excerpt", async () => {
      const gmail = await search("call me");
      expect(keysOf(gmail)).toEqual(["email:alice@x.com"]);
      expect(gmail.body.people[0].matches).toEqual([
        {
          field: "message",
          source: "gmail",
          at: "2026-09-03T09:00:00.000Z",
          direction: "inbound",
          subject: "Re: Intro",
          excerpt: "Sure, call me",
          ref: { gmailMessageId: "g2" },
        },
      ]);
      expect(gmail.body.people[0].messageMatches).toBe(1);

      const cold = await search("interested");
      expect(keysOf(cold)).toEqual(["email:alice@x.com"]);
      expect(cold.body.people[0].matches[0]).toMatchObject({ field: "message", source: "instantly", excerpt: "Interested", ref: { campaignId: "camp-1" } });

      const wa = await search("on whatsapp");
      expect(keysOf(wa)).toEqual(["email:alice@x.com"]);
      expect(wa.body.people[0].matches[0]).toMatchObject({ field: "message", source: "matrix", direction: "inbound", excerpt: "Hello on WhatsApp" });

      expect(wa.body.search).toMatchObject({ q: "on whatsapp", messageIndex: { failed: 0 } });
      expect(wa.body.search.messageIndex.messages).toBeGreaterThan(0);
    });

    it("a search that matches nobody is an empty page, and LIKE wildcards are literal", async () => {
      for (const q of ["pricing", "%", "_"]) {
        const res = await search(q);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 0, nextOffset: null, people: [] });
      }
    });

    it("an empty search is today's list, byte for byte", async () => {
      const plain = await request(app()).get(`/orgs/people?brandId=${BRAND}`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
      for (const q of ["", "   "]) {
        const res = await search(q);
        expect(res.body).toEqual(plain.body);
      }
      expect(plain.body.search).toBeUndefined();
      expect(plain.body.people[0].matches).toBeUndefined();
    });

    it("pages and counts the matches like the list", async () => {
      const page1 = await search("@", "&limit=2");
      expect(page1.body.total).toBe(3);
      expect(page1.body.nextOffset).toBe(2);
      const page2 = await search("@", "&limit=2&offset=2");
      expect([...keysOf(page1), ...keysOf(page2)].sort()).toEqual(["email:alice@x.com", "email:bob@y.com", "email:carol@z.com"]);
    });

    it("automated senders stay hidden from a search unless asked for", async () => {
      extraCorrespondents = [{ email: DIGEST, name: "LinkedIn" }];
      automatedEmails = new Map([[DIGEST, 0.9]]);
      await buildNow();
      const hidden = await search("just messaged you");
      expect(hidden.body).toMatchObject({ total: 0, automatedHidden: 1, people: [] });
      const shown = await search("just messaged you", "&includeAutomated=true");
      expect(keysOf(shown)).toEqual([`email:${DIGEST}`]);
    });

    it("a rebuild with no new activity re-reads no conversation; the index survives the rebuild", async () => {
      calls.length = 0;
      await buildNow();
      expect(calls.filter((c) => c.endsWith("/orgs/google/conversation") || c.endsWith("/orgs/conversations"))).toEqual([]);
      expect(keysOf(await search("call me"))).toEqual(["email:alice@x.com"]);
    });

    it("a failed conversation read is recorded and reported, its old text kept, and retried next build", async () => {
      const [scope] = await db.select().from(peopleScopes);
      // Force a re-read of every unit.
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '2 days' WHERE scope_id = ${scope.id}`);
      gmailConversationDown = true;
      const s1 = await buildNow();
      expect(s1.messageIndex).toMatchObject({ status: "ok", failed: 3 }); // the Gmail read of alice, bob and carol
      const during = await search("call me");
      expect(keysOf(during)).toEqual(["email:alice@x.com"]); // the last good read still answers
      expect(during.body.search.messageIndex.failed).toBeGreaterThan(0);
      gmailConversationDown = false;
      const s2 = await buildNow();
      expect(s2.messageIndex).toMatchObject({ status: "ok", failed: 0 });
      expect((await search("call me")).body.search.messageIndex.failed).toBe(0);
    });
  });

  describe("timeline from the store", () => {
    const timeline = () =>
      request(app())
        .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:alice@x.com")}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);
    const siblingReads = () =>
      calls.filter((c) => c.endsWith("/orgs/google/conversation") || c.endsWith("/orgs/conversations") || c.endsWith("/orgs/leads"));
    const texts = (res: { body: { items: { text: string | null }[] } }) => res.body.items.map((i) => i.text);

    beforeEach(async () => {
      gmailConnected = true;
      await seedLocalSources();
      await buildNow();
    });

    it("a fresh store answers with no sibling call, the same items every time, and says where each source came from", async () => {
      calls.length = 0;
      const first = await timeline();
      expect(first.status).toBe(200);
      expect(texts(first)).toEqual(["Hi Alice", "Cold email", "Interested", "Sure, call me", "Hello on WhatsApp", "Hi Alice"]);
      for (let i = 0; i < 9; i++) expect((await timeline()).body.items).toEqual(first.body.items);
      expect(siblingReads()).toEqual([]);
      const sources = Object.fromEntries(first.body.sources.map((x: { source: string }) => [x.source, x]));
      expect(sources.gmail).toMatchObject({ status: "ok", servedFrom: "store", items: 2 });
      expect(sources.gmail.readAt).toEqual(expect.any(String));
      expect(sources.instantly).toMatchObject({ status: "ok", servedFrom: "store", items: 2 });
      expect(sources.matrix).toMatchObject({ status: "ok", servedFrom: "mirror", readAt: null });
    });

    it("a stale store is served as is and re-read in the background: the next read shows the new message", async () => {
      aliceNewMessage = true;
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '5 minutes'`);
      const stale = await timeline();
      expect(texts(stale)).not.toContain("Send me the deck");
      await vi.waitFor(
        async () => {
          const [row] = (await db.execute(
            sql`SELECT count(*)::int AS n FROM people_message_units WHERE source = 'gmail' AND unit = 'alice@x.com' AND indexed_at > now() - interval '1 minute'`,
          )) as unknown as { n: number }[];
          expect(row.n).toBe(1);
        },
        { timeout: 5000, interval: 50 },
      );
      const fresh = await timeline();
      expect(texts(fresh)).toContain("Send me the deck");
      // and the search sees it too
      const found = await request(app()).get(`/orgs/people?brandId=${BRAND}&q=deck`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
      expect(found.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:alice@x.com"]);
    });

    it("a never-read address is read once, on the spot; a source that could never be read says failed", async () => {
      await db.execute(sql`DELETE FROM people_message_texts`);
      await db.execute(sql`DELETE FROM people_message_units`);
      const res = await timeline();
      expect(texts(res)).toContain("Sure, call me");

      await db.execute(sql`DELETE FROM people_message_texts`);
      await db.execute(sql`DELETE FROM people_message_units`);
      gmailConversationDown = true;
      const down = await timeline();
      const gmail = down.body.sources.find((x: { source: string }) => x.source === "gmail");
      expect(gmail).toMatchObject({ status: "failed", items: 0, readAt: null });
      expect(gmail.error).toContain("returned 500");

      // Once failed, the next read does not wait on the source again: it answers and retries in the background.
      calls.length = 0;
      await timeline();
      expect(calls.filter((c) => c.endsWith("/orgs/google/conversation")).length).toBeLessThanOrEqual(1);
      gmailConversationDown = false;
      await vi.waitFor(
        async () => {
          await timeline(); // each read retries the failed unit in the background
          const [row] = (await db.execute(sql`SELECT status FROM people_message_units WHERE source = 'gmail' AND unit = 'alice@x.com'`)) as unknown as { status: string }[];
          expect(row.status).toBe("ok");
        },
        { timeout: 5000, interval: 50 },
      );
      expect(texts(await timeline())).toContain("Sure, call me");
    });
  });
});
