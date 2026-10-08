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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let gmailConnected = false;
let leadServiceDown = false;
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
              ],
            },
          ],
        });
      }
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
              { direction: "outbound", from: "kevin@send.com", to: "alice@x.com", at: "2026-09-02T08:00:00.000Z", subject: "Cold", text: "Cold email", campaignId: "camp-1", instantlyCampaignId: "self:1" },
              { direction: "inbound", from: "alice@x.com", to: "kevin@send.com", at: "2026-09-02T10:00:00.000Z", subject: "Re: Cold", text: "Interested", campaignId: "camp-1", instantlyCampaignId: "self:1" },
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
              { id: "lc-0", leadId: "l-0", email: "jimbob@y.com", campaignId: "camp-9", standing: { state: "customer" } },
              { id: "lc-2", leadId: "l-2", email: "bob@y.com", campaignId: "camp-2", standing: { state: "engaged", signal: "click" } },
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
    automatedEmails = new Map();
    jevDown = false;
    extraCorrespondents = [];
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

  it("rebuilding replaces the gold rows; a cached standing is reused", async () => {
    await seedLocalSources();
    const first = await buildNow();
    expect(first.standing.asked).toBe(2);
    const second = await buildNow();
    expect(second.standing.reused).toBe(2);
    expect(await db.select().from(people)).toHaveLength(2);
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
});
