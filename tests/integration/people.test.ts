import { createHash } from "node:crypto";
import { pgErrorOf } from "../../src/lib/pg-error.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  contactRowsRaw,
  contactUploads,
  conversations,
  ghlConnections,
  ghlOpportunities,
  leadStandingObservations,
  matrixConnections,
  matrixRawEvents,
  people,
  peopleScopes,
  personIdAliases,
  senderVerdicts,
} from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { clearFamiliesCache } from "../../src/lib/people/families.js";
import { runFreshnessPass } from "../../src/lib/people/freshness.js";
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
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "c";

/** The four connection-tag answers (CONNECTION-TAGS-1017), yes on the given ones. */
const tagAnswers = (...yes: string[]) =>
  Object.fromEntries(
    ["personal_to_user", "personal_not_to_user", "professional_to_brand", "professional_not_to_brand"].map((t) => [
      `t_${t}`,
      { type: "noul", noul: yes.includes(t) ? 0.9 : 0.05 },
    ]),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let gmailConnected = false;
/** PERSON-ORGANIZATIONS-1017: domains Jev was asked about, domains brand-service resolved. */
const domainQuestions: string[] = [];
const companyResolves: string[] = [];
/** features-service's lead families (won / hot / lost / cold) for the brand. */
let leadFamilies: { leadId: string; email: string; family: string; lostReason: string | null }[] = [];
let featuresDown = false;
/** How many next features reads are REFUSED at connect (a container swap on deploy). */
let featuresRefusals = 0;
const featuresRequests: Record<string, string>[] = [];
let leadServiceDown = false;
/** lead-service's CRM pairings for the brand (served on `?state=paired`, filtered like the real route). */
let leadPairings: { crmContact: { id: string; email: string | null; phone: string | null; fullName: string | null; company: string | null }; pairing: { state: string; toConfirm: boolean; lead: { leadId?: string; email: string | null; fullName: string | null; company: string | null } | null } }[] = [];
let gmailConversationDown = false;
/** google-service takes this long to answer a conversation read (0 = at once). */
let gmailConversationDelayMs = 0;
/** The query of every google-service conversation read. */
const gmailConversationQueries: URLSearchParams[] = [];
let aliceNewMessage = false;
/** Our own reply to Alice exists in instantly-service's thread (sent after the store read it). */
let aliceOurReply = false;
/** Alice is also a lead on camp-1b, a sibling campaign row of camp-1's family. */
let aliceTwinCampaign = false;
/** instantly-service's outreach fact feed (seq = position + 1). */
let outreachFacts: Record<string, unknown>[] = [];
const calls: string[] = [];

/** Jev's stub: these addresses are automated, at this confidence; every other address is human. */
let automatedEmails = new Map<string, number>();
let jevDown = false;
const jevRequests: { headers: Record<string, string>; body: { state: { senders: Record<string, { email: string; recentMessages: { subject: string | null }[] }> }; questions: Record<string, unknown> } }[] = [];

/** Jev's relevance stub: these counterpart addresses are personal; every other conversation is about the brand. */
let personalEmails = new Set<string>();
const OFFER = "dddddddd-1111-4111-8111-0000000000f1";
const relevanceRequests: { headers: Record<string, string>; body: { state: { conversation: { counterpart: { email: string | null } } } } }[] = [];

/** Extra Gmail correspondents a test adds (an automated digest, a role address). */
let extraCorrespondents: { email: string; name: string | null }[] = [];

const DIGEST = "messaging-digest-noreply@linkedin.com";

/** Extra written-to rows a test adds (people we wrote to who never engaged). */
let extraWritten: Record<string, unknown>[] = [];
/** How many written-to rows one page serves (the real route pages on a cursor). */
let writtenPageSize = 1000;
/** Rows of the brand's whole lead list, in lead-service's `sort=activity` order (the walk). */
let leadList: Record<string, unknown>[] = [];

/** instantly-service written-to-leads rows: alice replied, bob clicked (both engaged). */
const WRITTEN = [
  {
    campaignId: "camp-1",
    instantlyCampaignId: "self:1",
    leadEmail: "Alice@X.com",
    brandIds: [BRAND],
    firstSentAt: "2026-09-02T08:00:00.000Z",
    lastSentAt: "2026-09-02T08:00:00.000Z",
    engaged: true,
    unsubscribed: false,
    bounced: false,
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
    firstSentAt: "2026-09-04T08:00:00.000Z",
    lastSentAt: "2026-09-04T08:00:00.000Z",
    engaged: true,
    unsubscribed: false,
    bounced: false,
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
      if (body.state.conversation) {
        relevanceRequests.push({ headers: init!.headers as Record<string, string>, body });
        const personal = personalEmails.has(body.state.conversation.counterpart.email);
        const p = personal
          ? { personal: 0.92, other_business: 0.05, this_brand: 0.03 }
          : { personal: 0.02, other_business: 0.03, this_brand: 0.95 };
        return json({
          model: "jev-test",
          answers: {
            topic: { type: "choice", choice: personal ? "personal" : "this_brand", confidence: 0.9, probabilities: p },
            o0: { type: "noul", noul: personal ? 0.1 : 0.85 },
            ...tagAnswers(personal ? "personal_to_user" : "professional_to_brand"),
          },
        });
      }
      if (body.state.group) return json({ model: "jev-test", answers: tagAnswers("personal_not_to_user") });
      // PERSON-RELATIONS-1017: which known company a contact point without evidence speaks for.
      if (body.questions.point) return json({ model: "jev-test", answers: { point: { type: "choice", choice: "unknown", confidence: 0.9, probabilities: {} } } });
      if (Object.keys(body.questions).some((k) => /^d\d+$/.test(k))) {
        // PERSON-ORGANIZATIONS-1017: is each email domain a public mailbox or one organization's?
        const answers: Record<string, unknown> = {};
        for (const [k, q] of Object.entries(body.questions as Record<string, { instructions: string }>)) {
          const domain = /"([^"]+)"/.exec(q.instructions)![1];
          const mailbox = domain === "gmail.com";
          answers[k] = { type: "choice", choice: mailbox ? "mailbox_provider" : "organization", confidence: 0.95, probabilities: {} };
          domainQuestions.push(domain);
        }
        return json({ model: "jev-test", answers });
      }
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
    if (url.host === "client.test" && url.pathname === "/internal/users") {
      return json({ users: [{ id: "user-owner", email: "me@brand.com", phone: "+33600000001", firstName: "Owner", lastName: "Brand" }], total: 1 });
    }
    if (url.host === "google.test") {
      if (url.pathname === "/orgs/google/accounts") return json({ accounts: gmailConnected ? [{ email: "me@brand.com" }] : [] });
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
        gmailConversationQueries.push(url.searchParams);
        if (gmailConversationDelayMs) await new Promise((r) => setTimeout(r, gmailConversationDelayMs));
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
        if (url.searchParams.get("email") === "mom@family.com") {
          return json({
            address: "mom@family.com",
            status: "ok",
            threads: [
              {
                threadId: "tm",
                messages: [
                  { gmailMessageId: "m1", threadId: "tm", direction: "inbound", fromEmail: "mom@family.com", to: ["me@brand.com"], subject: "Sunday lunch", snippet: "Are you coming on Sunday?", sentAt: "2026-07-10T09:00:00.000Z", bodyText: "Are you coming on Sunday? Bring the kids.", bodyTextOriginal: null, bodyStatus: "ok", bodyCleanStatus: "cleaned" },
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
      if (featuresRefusals > 0) {
        featuresRefusals -= 1;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      }
      featuresRequests.push(init!.headers as Record<string, string>);
      if (featuresDown) return json({ error: "Failed to compute brand lead families" }, 502);
      const counts = { won: 0, hot: 0, lost: 0, cold: 0 } as Record<string, number>;
      for (const p of leadFamilies) counts[p.family] += 1;
      return json({ brandId: BRAND, counts, lostBreakdown: { wentCold: 0, ruledOut: 0 }, offers: [], people: leadFamilies.map((p) => ({ ...p, campaignLeadIds: [], offerId: "o1" })) });
    }
    if (url.host === "brand.test" && url.pathname === "/internal/companies/resolve") {
      const body = JSON.parse(String(init!.body)) as { companies: { ref: string; domain: string }[] };
      companyResolves.push(...body.companies.map((c) => c.domain));
      return json({
        companies: body.companies.map((c, index) => ({
          index,
          ref: c.ref,
          brandId: `cccccccc-2222-4222-8222-${createHash("sha256").update(c.domain).digest("hex").slice(0, 12)}`,
          domain: c.domain,
          matchedBy: "domain",
          created: true,
          unresolvedReason: null,
        })),
      });
    }
    if (url.host === "brand.test") {
      if (url.pathname.endsWith("/offers")) {
        return json({ offers: [{ offerId: OFFER, brandId: BRAND, name: "Pro plan", description: null, status: "active" }] });
      }
      if (url.pathname === "/orgs/brands") return json({ brands: [{ id: BRAND, name: "Brand", domain: "brand.com" }] });
      if (url.pathname.endsWith("/extracted-fields")) {
        return json({ brandId: BRAND, fields: [{ key: "companyOverview", value: "Brand sells a Pro plan to teams." }] });
      }
      return json({ brand: { id: BRAND, name: "Brand", domain: "brand.com", url: "https://brand.com" } });
    }
    if (url.host === "instantly.test") {
      if (url.pathname === "/internal/accounts") {
        return json({ accounts: [{ email: "Kevin@send.com", mailboxLogin: "kevin@send.com" }] });
      }
      if (url.pathname === "/orgs/written-to-leads") {
        expect(url.searchParams.get("brand_id")).toBe(BRAND);
        const all = [...WRITTEN, ...extraWritten];
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit")), writtenPageSize);
        const leads = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : null;
        return json({ success: true, count: leads.length, nextCursor: next, leads });
      }
      if (url.pathname === "/internal/outreach-facts") {
        expect(url.searchParams.get("orgId")).toBe(ORG);
        expect(url.searchParams.get("brandId")).toBe(BRAND);
        const since = Number(url.searchParams.get("since") ?? 0);
        const facts = outreachFacts.filter((f) => Number(f.seq) > since);
        return json({ facts, nextCursor: facts.length ? String(facts[facts.length - 1].seq) : String(since), hasMore: false });
      }
      if (url.pathname === "/orgs/conversations") {
        const email = url.searchParams.get("email");
        if (url.searchParams.get("campaign_id") === "camp-3" && email === "dave@w.com") {
          return json({
            success: true,
            conversation: {
              campaignId: "camp-3",
              messages: [
                { direction: "outbound", from: "kevin@send.com", to: "dave@w.com", at: "2026-09-06T08:00:00.000Z", subject: "Hello Dave", text: "Initial to Dave", campaignId: "camp-3", instantlyCampaignId: "self:3", outreachFact: { subjectKey: "ievt:evt-3", step: 1, position: "first" } },
                { direction: "outbound", from: "kevin@send.com", to: "dave@w.com", at: "2026-09-09T08:00:00.000Z", subject: "Re: Hello Dave", text: "Followup to Dave", campaignId: "camp-3", instantlyCampaignId: "self:3", outreachFact: { subjectKey: "ievt:evt-4", step: 2, position: "followup" } },
              ],
            },
          });
        }
        // camp-1b is a sibling row of camp-1's family: instantly-service answers the family's whole thread.
        const aliceCampaigns = aliceTwinCampaign ? ["camp-1", "camp-1b"] : ["camp-1"];
        if (!aliceCampaigns.includes(url.searchParams.get("campaign_id") ?? "") || email !== "alice@x.com") {
          return json({ error: "campaign_not_found" }, 404);
        }
        return json({
          success: true,
          conversation: {
            campaignId: "camp-1",
            messages: [
              { direction: "outbound", from: "kevin@send.com", to: "alice@x.com", at: "2026-09-02T08:00:00.000Z", subject: "Cold", text: "Cold email", campaignId: "camp-1", instantlyCampaignId: "self:1", outreachFact: { subjectKey: "ievt:evt-1", step: 1, position: "first" } },
              { direction: "inbound", from: "alice@x.com", to: "kevin@send.com", at: "2026-09-02T10:00:00.000Z", subject: "Re: Cold", text: "Interested", campaignId: "camp-1", instantlyCampaignId: "self:1", outreachFact: null },
              ...(aliceOurReply
                ? [{ direction: "outbound", from: "kevin@send.com", to: "alice@x.com", at: "2026-09-12T21:28:45.000Z", subject: "Re: Cold", text: "Floating this to the top of your inbox", campaignId: "camp-1", instantlyCampaignId: "self:1", outreachFact: null }]
                : []),
            ],
          },
        });
      }
    }
    if (url.host === "lead.test") {
      if (leadServiceDown) return json({ error: "down" }, 503);
      if (url.pathname === "/orgs/leads") {
        const q = url.searchParams.get("q");
        if (q === null) {
          // The whole-brand walk: same order, paged on offset.
          const offset = Number(url.searchParams.get("offset"));
          const limit = Number(url.searchParams.get("limit"));
          return json({ leads: leadList.slice(offset, offset + limit), total: leadList.length });
        }
        if (q === "bob@y.com") {
          return json({
            leads: [
              // A substring hit that is NOT bob, first in lead-service's order: must be ignored.
              { id: "lc-0", leadId: "l-0", email: "jimbob@y.com", campaignId: "camp-9", standing: { state: "customer", tag: "customer" }, disqualification: null, company: null, human: null },
              { id: "lc-2", leadId: "l-2", email: "bob@y.com", campaignId: "camp-2", standing: { state: "engaged", tag: "engaged", signal: "click" }, disqualification: { level: "lead", offerId: null, note: "Runs a construction company, we sell to supermarkets.", source: "manual", statedByUserId: "user-1", statedAt: "2026-10-13T09:00:00.000Z" }, company: { id: "c0c0c0c0-1111-4111-8111-000000000001", key: "c0c0c0c0-1111-4111-8111-000000000001", isClient: true, signedUp: true, disqualification: { level: "company", offerId: null, note: "Not our target.", source: "manual", statedByUserId: "user-1", statedAt: "2026-10-13T10:00:00.000Z" } }, human: { optedOut: true, doNotContact: false } },
            ],
          });
        }
        return json({ leads: [] });
      }
      if (url.pathname === "/orgs/leads/crm-pairings") {
        const states = (url.searchParams.get("state") ?? "").split(",");
        return json({ crmConnected: true, connection: null, pairings: leadPairings.filter((p) => states.includes(p.pairing.state)), nextOffset: null });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

/**
 * A thread read re-reads stale units in the BACKGROUND, so a test can end while one of those
 * writes is still in flight; a wipe racing it can be picked as a deadlock victim (40P01).
 * The wipe is then simply run again once the writer is done.
 */
async function retryOnDeadlock(fn: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      // A background people build (its fact emission included) can hold rows for a few seconds.
      // drizzle wraps the Postgres error: its code sits on the cause (pgErrorOf walks it).
      if (pgErrorOf(err).code !== "40P01" || attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function wipe() {
  await retryOnDeadlock(() => db.execute(sql`TRUNCATE sender_verdicts, conversation_verdicts, domain_verdicts, company_keys, people_corrections, people_scopes, people, person_ids, person_id_aliases, person_merges, contact_uploads, lead_standing_observations, matrix_raw_events, conversations, matrix_leads, matrix_connections, ghl_opportunities, ghl_connections, contacts CASCADE`));
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
  // A build a route kicked may be running: wait for it, then build (a skipped build read nothing new).
  for (;;) {
    const result = await runScopeBuild(scope);
    expect(result.ok).toBe(true);
    if (!result.skipped) return result.summary!;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!RUN)("person layer", () => {
  beforeEach(async () => {
    gmailConnected = false;
    leadServiceDown = false;
    leadPairings = [];
    gmailConversationDown = false;
    gmailConversationDelayMs = 0;
    gmailConversationQueries.length = 0;
    aliceNewMessage = false;
    aliceOurReply = false;
    aliceTwinCampaign = false;
    outreachFacts = [];
    automatedEmails = new Map();
    personalEmails = new Set();
    relevanceRequests.length = 0;
    jevDown = false;
    extraCorrespondents = [];
    extraWritten = [];
    writtenPageSize = 1000;
    leadList = [];
    delete process.env.PEOPLE_STANDING_WALK_MIN;
    leadFamilies = [];
    featuresDown = false;
    featuresRefusals = 0;
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

  it("every lead we wrote to is a person, answered or not; repliers keep what they showed", async () => {
    const written = (email: string, campaignId: string, extra: Record<string, unknown> = {}) => ({
      campaignId,
      instantlyCampaignId: `self:${campaignId}`,
      leadEmail: email,
      brandIds: [BRAND],
      firstSentAt: "2026-09-06T08:00:00.000Z",
      lastSentAt: "2026-09-09T08:00:00.000Z",
      engaged: false,
      replied: false,
      clicked: false,
      unsubscribed: false,
      bounced: false,
      firstRepliedAt: null,
      firstClickedAt: null,
      replyClassification: null,
      replyKind: null,
      disqualified: false,
      ...extra,
    });
    // dave never answered; erin replied asking to stop (never engaged) and is not one of our leads.
    extraWritten = [
      written("dave@w.com", "camp-3"),
      written("erin@v.com", "camp-4", { replied: true, unsubscribed: true, firstRepliedAt: "2026-09-07T08:00:00.000Z", replyClassification: "negative" }),
    ];
    writtenPageSize = 1; // every row on its own page: the cursor is walked to the end
    // The whole-brand walk answers lead-service's standing for every address at once.
    process.env.PEOPLE_STANDING_WALK_MIN = "1";
    leadList = [
      { id: "lc-0", leadId: "l-0", email: "jimbob@y.com", campaignId: "camp-9", standing: { state: "customer", tag: "customer" }, disqualification: null, company: null, human: null },
      { id: "lc-2", leadId: "l-2", email: "bob@y.com", campaignId: "camp-2", standing: { state: "engaged", tag: "engaged", signal: "click" }, disqualification: null, company: null, human: null },
      { id: "lc-3", leadId: "l-3", email: "Dave@w.com", campaignId: "camp-3", standing: { state: "contacted", tag: "contacted" }, disqualification: null, company: null, human: null },
      { id: "lc-4", leadId: "l-4", email: "dave@w.com", campaignId: "camp-5", standing: { state: "unresolved", tag: "unresolved" }, disqualification: null, company: null, human: null },
    ];
    const summary = await buildNow();

    const rows = await db.select().from(people).orderBy(people.personKey);
    expect(rows.map((r) => r.personKey)).toEqual(["email:alice@x.com", "email:bob@y.com", "email:dave@w.com", "email:erin@v.com"]);
    const [alice, bob, dave, erin] = rows;
    // The repliers are unchanged: alice (not a lead) replied, bob is lead-service's exact row.
    expect(alice).toMatchObject({ state: "replied", stateSource: "instantly" });
    expect(bob).toMatchObject({ state: "engaged", stateSource: "lead_service" });
    expect((bob.stateDetail as { leadCampaignId: string }).leadCampaignId).toBe("lc-2");
    // dave: lead-service's FIRST row for his address in its own order.
    expect(dave).toMatchObject({ state: "contacted", stateSource: "lead_service", sources: ["instantly"] });
    expect((dave.stateDetail as { leadCampaignId: string }).leadCampaignId).toBe("lc-3");
    expect(dave.lastActivityAt!.toISOString()).toBe("2026-09-09T08:00:00.000Z");
    // A reply asking to stop is not an engagement: erin is in the list, stating no reply.
    expect(erin).toMatchObject({ state: "in_conversation", stateSource: "none" });
    expect((erin.presences as { detail: { replied: boolean } }[])[0].detail.replied).toBe(false);

    expect(summary.standing).toMatchObject({ asked: 4, failed: 0 });
    expect(calls.filter((c) => c === "lead.test/orgs/leads")).toHaveLength(1);
    const instantly = summary.sources.find((s) => s.source === "instantly")!;
    expect(instantly).toMatchObject({ status: "ok", presences: 4, sourceCount: 4 });
    expect(calls.filter((c) => c === "instantly.test/orgs/written-to-leads")).toHaveLength(4);

    // dave's thread shows the emails we sent him.
    const res = await request(app())
      .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:dave@w.com")}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { source: string; direction: string; text: string }) => [i.source, i.direction, i.text])).toEqual([
      ["instantly", "outbound", "Initial to Dave"],
      ["instantly", "outbound", "Followup to Dave"],
    ]);
  });

  it("a lead-service walk that fails reads every address unavailable, never a guess", async () => {
    process.env.PEOPLE_STANDING_WALK_MIN = "1";
    leadServiceDown = true;
    const summary = await buildNow();
    const rows = await db.select().from(people).orderBy(people.personKey);
    expect(rows.map((r) => [r.personKey, r.state, r.stateSource])).toEqual([
      ["email:alice@x.com", "unavailable", "lead_service"],
      ["email:bob@y.com", "unavailable", "lead_service"],
    ]);
    expect(summary.standing).toMatchObject({ asked: 2, failed: 2 });
  });

  it("a CRM contact lead-service CONFIDENTLY paired with our lead is that lead, shown under the lead's address", async () => {
    await seedLocalSources();
    const [ghl] = await db.select().from(ghlConnections);
    const [bobCrm, other] = await db
      .insert(contacts)
      .values([
        // Bob booked from another address that sorts BEFORE bob@y.com: nothing but lead-service's pairing ties them.
        { orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-bob", primaryEmail: "aa.bob@gmail.com", phoneE164: "+13529423443", fullName: "Bob Stone", rawAttributes: {}, sourceConnectionId: ghl.id },
        // lead-service REJECTED this one's pairing with bob: it stays its own person.
        { orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-other", primaryEmail: "other@z.com", fullName: "Rob Stone", rawAttributes: {}, sourceConnectionId: ghl.id },
      ])
      .returning();
    await db.insert(ghlOpportunities).values({ orgId: ORG, brandId: BRAND, connectionId: ghl.id, externalId: "opp-bob", name: "Bob deal", status: "open", stageName: "Booked", pipelineName: "Sales", contactId: bobCrm.id });
    const lead = { email: "bob@y.com", fullName: "Bob Stone", company: null };
    leadPairings = [
      { crmContact: { id: bobCrm.id, email: "aa.bob@gmail.com", phone: "+13529423443", fullName: "Bob Stone", company: null }, pairing: { state: "paired", toConfirm: false, lead } },
      { crmContact: { id: other.id, email: "other@z.com", phone: null, fullName: "Rob Stone", company: null }, pairing: { state: "rejected", toConfirm: false, lead } },
    ];

    const summary = await buildNow();
    const rows = await db.select().from(people).orderBy(people.personKey);
    expect(rows.map((r) => r.personKey)).toEqual(["email:aa.bob@gmail.com", "email:alice@x.com", "email:other@z.com"]);

    const bob = rows[0];
    expect(bob.sources).toEqual(["instantly", "gohighlevel"]);
    expect(bob.identityKeys).toEqual(["email:aa.bob@gmail.com", "email:bob@y.com", "phone:+13529423443"]);
    // The address lead-service serves comes first, whatever the key order.
    expect(bob.emails).toEqual(["bob@y.com", "aa.bob@gmail.com"]);
    // lead-service's standing outranks the CRM's open deal.
    expect(bob).toMatchObject({ state: "engaged", stateSource: "lead_service", possibleLeads: [] });
    expect(bob.mergeEvidence).toContainEqual(expect.objectContaining({ kind: "lead_pairing", ref: bobCrm.id }));

    expect(rows[2]).toMatchObject({ sources: ["gohighlevel"], identityKeys: ["email:other@z.com"], possibleLeads: [] });
    expect(summary.evidence).toContainEqual({ kind: "lead_pairing", status: "ok", records: 1, error: null });
  });

  it("a pairing lead-service is only guessing (toConfirm) is NOT one person: the CRM contact carries a hint", async () => {
    await seedLocalSources();
    const [ghl] = await db.select().from(ghlConnections);
    // Brice Jackson's shape (2026-10-10): paired by full name at 0.69, CRM gmail vs the lead's work address.
    const [bobCrm] = await db
      .insert(contacts)
      .values({ orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-bob", primaryEmail: "aa.bob@gmail.com", fullName: "Bob Stone", rawAttributes: {}, sourceConnectionId: ghl.id })
      .returning();
    await db.insert(ghlOpportunities).values({ orgId: ORG, brandId: BRAND, connectionId: ghl.id, externalId: "opp-bob", name: "Bob deal", status: "open", stageName: "Booked", pipelineName: "Sales", contactId: bobCrm.id });
    leadPairings = [
      { crmContact: { id: bobCrm.id, email: "aa.bob@gmail.com", phone: null, fullName: "Bob Stone", company: null }, pairing: { state: "paired", toConfirm: true, lead: { leadId: "bbbbbbbb-1111-4111-8111-00000000b0b0", email: "Bob@y.com", fullName: "Bob Stone", company: "Y" } } },
    ];

    const summary = await buildNow();
    const rows = await db.select().from(people).orderBy(people.personKey);
    expect(rows.map((r) => r.personKey)).toEqual(["email:aa.bob@gmail.com", "email:alice@x.com", "email:bob@y.com"]);
    expect(rows[0]).toMatchObject({
      sources: ["gohighlevel"],
      emails: ["aa.bob@gmail.com"],
      stateSource: "gohighlevel",
      mergeEvidence: [],
      possibleLeads: [{ crmContactId: bobCrm.id, leadId: "bbbbbbbb-1111-4111-8111-00000000b0b0", email: "bob@y.com", fullName: "Bob Stone", company: "Y" }],
    });
    expect(rows[2]).toMatchObject({ sources: ["instantly"], emails: ["bob@y.com"], stateSource: "lead_service", possibleLeads: [] });
    expect(summary.evidence).toContainEqual({ kind: "lead_pairing", status: "ok", records: 0, error: null });

    const res = await request(app())
      .get(`/orgs/people?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(res.status).toBe(200);
    const crm = res.body.people.find((x: { personKey: string }) => x.personKey === "email:aa.bob@gmail.com");
    expect(crm.possibleLeads).toEqual([{ crmContactId: bobCrm.id, leadId: "bbbbbbbb-1111-4111-8111-00000000b0b0", email: "bob@y.com", fullName: "Bob Stone", company: "Y" }]);
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

  it("a cold email read through two campaign units of one family is stored and served once", async () => {
    aliceTwinCampaign = true;
    extraWritten = [{ ...WRITTEN[0], campaignId: "camp-1b" }];
    await seedLocalSources();
    await buildNow();
    const read = () =>
      request(app())
        .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:alice@x.com")}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.sources.find((s: { source: string }) => s.source === "instantly").asked.sort()).toEqual([
      "camp-1:alice@x.com",
      "camp-1b:alice@x.com",
    ]);
    const cold = () => res.body.items.filter((i: { source: string }) => i.source === "instantly");
    expect(cold().map((i: { text: string }) => i.text)).toEqual(["Cold email", "Interested"]);
    expect(cold()[0].outreachFact).toEqual({ subjectKey: "ievt:evt-1", step: 1, position: "first" });
    const stored = await db.execute(sql`SELECT unit FROM people_message_texts WHERE source = 'instantly' AND address = 'alice@x.com'`);
    expect(stored.length).toBe(2);
    const units = await db.execute(sql`SELECT unit, messages FROM people_message_units WHERE source = 'instantly' AND address = 'alice@x.com' ORDER BY unit`);
    expect((units as unknown as { messages: number }[]).reduce((n, u) => n + u.messages, 0)).toBe(2);

    // A row an older build stored under a per-unit key (a deploy rolled back) is still one message
    // on the serve, and its unit is re-read and re-keyed by the next pass (store format < 4).
    await db.execute(sql`
      INSERT INTO people_message_texts (scope_id, source, unit, address, message_key, at, direction, search_text, item)
      SELECT scope_id, source, 'camp-1b:alice@x.com', address, '0:' || (item->>'at') || ':outbound', at, direction, search_text, item
      FROM people_message_texts WHERE source = 'instantly' AND address = 'alice@x.com' AND direction = 'outbound'
      ON CONFLICT DO NOTHING`);
    await db.execute(sql`UPDATE people_message_units SET format = 3 WHERE unit = 'camp-1b:alice@x.com'`);
    const legacy = await read();
    expect(legacy.body.items.filter((i: { source: string }) => i.source === "instantly").map((i: { text: string }) => i.text)).toEqual([
      "Cold email",
      "Interested",
    ]);
    await buildNow();
    const keys = (await db.execute(
      sql`SELECT message_key FROM people_message_texts WHERE source = 'instantly' AND address = 'alice@x.com'`,
    )) as unknown as { message_key: string }[];
    expect(keys.filter((k) => !k.message_key.includes("|"))).toEqual([]);
    expect(keys).toHaveLength(2);

    // A real new message reaches the thread once, whichever unit re-reads it; a re-read of both adds nothing.
    aliceOurReply = true;
    await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '2 days' WHERE source = 'instantly'`);
    await buildNow();
    const again = await read();
    expect(again.body.items.filter((i: { source: string }) => i.source === "instantly").map((i: { text: string }) => i.text)).toEqual([
      "Cold email",
      "Interested",
      "Floating this to the top of your inbox",
    ]);

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
    // lead-service's Disqualified mark rides BESIDE the state, verbatim; the state is unchanged.
    expect(res.body.people[0]).toMatchObject({
      state: "engaged",
      stateSource: "lead_service",
      disqualification: { level: "lead", offerId: null, note: "Runs a construction company, we sell to supermarkets.", source: "manual", statedByUserId: "user-1", statedAt: "2026-10-13T09:00:00.000Z" },
      // Tags at THEIR level, relayed verbatim: the company's (client, signed up, not our target) and the human's opt-out.
      companyTags: {
        id: "c0c0c0c0-1111-4111-8111-000000000001",
        isClient: true,
        signedUp: true,
        disqualification: { level: "company", note: "Not our target." },
      },
      humanTags: { optedOut: true, doNotContact: false },
    });
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

    it("features-service refusing connections mid-deploy, then accepting: family=hot still lists", async () => {
      await seedLocalSources();
      await buildNow();
      featuresRefusals = 2;
      const hot = await listPeople("&family=hot");
      expect(hot.status).toBe(200);
      expect(hot.body.families.status).toBe("ok");
      expect(hot.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:bob@y.com"]);
      expect(featuresRefusals).toBe(0);
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

  it("a cached standing from before lead-service served its Disqualified mark is re-asked, never read as not disqualified", async () => {
    await seedLocalSources();
    await buildNow();
    const cached = await db.select().from(leadStandingObservations);
    for (const c of cached.filter((x) => x.found)) {
      const { disqualification: _d, ...payload } = c.payload as Record<string, unknown>;
      await db.update(leadStandingObservations).set({ payload }).where(eq(leadStandingObservations.id, c.id));
    }
    const again = await buildNow();
    expect(again.standing.asked).toBe(1);
    expect(again.standing.reused).toBe(1);
    const [bob] = await db.select().from(people).where(eq(people.personKey, "email:bob@y.com"));
    expect((bob.stateDetail as { disqualification: { note: string } }).disqualification.note).toBe("Runs a construction company, we sell to supermarkets.");
  });

  it("a cached standing from before lead-service served its company block is re-asked, never read as no company", async () => {
    await seedLocalSources();
    await buildNow();
    const cached = await db.select().from(leadStandingObservations);
    for (const c of cached.filter((x) => x.found)) {
      const { company: _c, ...payload } = c.payload as Record<string, unknown>;
      await db.update(leadStandingObservations).set({ payload }).where(eq(leadStandingObservations.id, c.id));
    }
    const again = await buildNow();
    expect(again.standing.asked).toBe(1);
    expect(again.standing.reused).toBe(1);
    const [bob] = await db.select().from(people).where(eq(people.personKey, "email:bob@y.com"));
    expect((bob.stateDetail as { company: { isClient: boolean } }).company.isClient).toBe(true);
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

  describe("entry events: how the person came in", () => {
    const timeline = (q: string) =>
      request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&${q}`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);

    it("a CRM contact with no deal and no message still has a thread: added to the CRM on its date", async () => {
      await seedLocalSources();
      const [ghl] = await db.select().from(ghlConnections);
      await db.insert(contacts).values([
        {
          orgId: ORG,
          brandId: BRAND,
          source: "gohighlevel",
          externalId: "ghl-dan",
          phoneE164: "+12014713892",
          rawAttributes: {},
          sourceConnectionId: ghl.id,
          sourceCreatedAt: new Date("2026-10-09T22:44:00Z"),
          leadSource: "Meta Ads",
        },
        // GoHighLevel gave no creation date: nothing is invented.
        { orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-undated", phoneE164: "+12014710000", rawAttributes: {}, sourceConnectionId: ghl.id },
      ]);
      await buildNow();

      const dan = await timeline(`personKey=${encodeURIComponent("phone:+12014713892")}`);
      expect(dan.status).toBe(200);
      expect(dan.body.itemCount).toBe(1);
      expect(dan.body.items[0]).toMatchObject({
        at: "2026-10-09T22:44:00.000Z",
        source: "gohighlevel",
        channel: "crm",
        kind: "event",
        ref: { externalContactId: "ghl-dan" },
        event: { step: "added_to_crm", dateBasis: "contact_created_at", detail: { leadSource: "Meta Ads" } },
      });
      expect(dan.body.sources.find((s: { source: string }) => s.source === "gohighlevel")).toMatchObject({ status: "ok", items: 1 });

      const undated = await timeline(`personKey=${encodeURIComponent("phone:+12014710000")}`);
      expect(undated.body.itemCount).toBe(0);
    });

    it("a person the client imported from a file shows the import, dated by the upload", async () => {
      await seedLocalSources();
      const [upload] = await db
        .insert(contactUploads)
        .values({
          orgId: ORG,
          brandId: BRAND,
          filename: "clients.csv",
          contentHash: "h-people-entry",
          columnHeaders: ["email"],
          runId: "run-x",
          uploadedAt: new Date("2026-07-01T09:00:00Z"),
        })
        .returning();
      await db.insert(contacts).values({
        orgId: ORG,
        brandId: BRAND,
        source: "csv",
        primaryEmail: "Bob@Y.com",
        rawAttributes: {},
        sourceUploadId: upload.id,
      });
      await buildNow();

      const bob = await timeline(`personKey=${encodeURIComponent("email:bob@y.com")}`);
      const imported = bob.body.items.find((i: { source: string }) => i.source === "csv");
      expect(imported).toMatchObject({
        at: "2026-07-01T09:00:00.000Z",
        channel: "file",
        kind: "event",
        event: { step: "added_to_crm", dateBasis: "uploaded_at", detail: { origin: "csv_import", filename: "clients.csv", uploadId: upload.id } },
      });
      // Oldest first: the import precedes the cold email.
      expect(bob.body.items[0].source).toBe("csv");
    });
  });

  describe("opaque person id", () => {
    const timeline = (q: string) =>
      request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&${q}`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
    const list = () =>
      request(app()).get(`/orgs/people?brandId=${BRAND}`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it("every person carries one, carrying no personal data, identical after a rebuild", async () => {
      await seedLocalSources();
      await buildNow();
      const first = await list();
      const ids = Object.fromEntries(first.body.people.map((p: { personKey: string; personId: string }) => [p.personKey, p.personId]));
      expect(Object.keys(ids)).toHaveLength(2);
      for (const id of Object.values(ids)) expect(id).toMatch(UUID);
      expect(new Set(Object.values(ids)).size).toBe(2);

      await buildNow();
      const second = await list();
      expect(Object.fromEntries(second.body.people.map((p: { personKey: string; personId: string }) => [p.personKey, p.personId]))).toEqual(ids);
    });

    it("the thread read answers the same thread by id as by key; bad or unknown ids are refused", async () => {
      await seedLocalSources();
      await buildNow();
      const [alice] = await db.select().from(people).where(eq(people.personKey, "email:alice@x.com"));
      const byKey = await timeline(`personKey=${encodeURIComponent("email:alice@x.com")}`);
      const byId = await timeline(`personId=${alice.personId}`);
      expect(byId.status).toBe(200);
      expect(byId.body.person.personId).toBe(alice.personId);
      expect(byId.body.items).toEqual(byKey.body.items);

      expect((await timeline(`personId=not-a-uuid`)).status).toBe(400);
      expect((await timeline(`personId=${alice.personId}&personKey=${encodeURIComponent("email:alice@x.com")}`)).status).toBe(400);
      expect((await timeline(``)).status).toBe(400);
      const unknown = await timeline(`personId=bbbbbbbb-1111-4111-8111-00000000beef`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.reason).toBe("person_not_found");
    });

    it("an id retired by a merge still opens the person it merged into", async () => {
      await seedLocalSources();
      await buildNow();
      const [alice] = await db.select().from(people).where(eq(people.personKey, "email:alice@x.com"));
      const retired = "bbbbbbbb-1111-4111-8111-0000000000a1";
      await db.insert(personIdAliases).values({ orgId: ORG, brandId: BRAND, retiredId: retired, personId: alice.personId! });
      const res = await timeline(`personId=${retired}`);
      expect(res.status).toBe(200);
      expect(res.body.person.personKey).toBe("email:alice@x.com");
    });

    it("two people found to be one keep one of their ids; the other id is retired into it", async () => {
      await seedLocalSources();
      // Carol on WhatsApp only (phone), and carol's email in cold email: two people today.
      const [mx] = await db.select().from(matrixConnections);
      const [carolWa] = await db
        .insert(contacts)
        .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_33699999999:hs", phoneE164: "+33699999999", rawAttributes: {}, sourceConnectionId: mx.id })
        .returning();
      await db.insert(conversations).values({
        orgId: ORG, brandId: BRAND, connectionId: mx.id, contactId: carolWa.id, channel: "whatsapp", roomId: "!carol",
        firstMessageAt: new Date("2026-09-06T12:00:00Z"), lastMessageAt: new Date("2026-09-06T12:00:00Z"),
        messageCount: 1, inboundCount: 1, outboundCount: 0, lastEventId: "$c1",
      });
      extraWritten = [{ ...WRITTEN[1], campaignId: "camp-3", leadEmail: "carol@z.com", engaged: false, clicked: false, firstClickedAt: null }];
      await buildNow();
      const before = await db.select().from(people);
      const phoneId = before.find((p) => p.personKey === "phone:+33699999999")!.personId!;
      const emailId = before.find((p) => p.personKey === "email:carol@z.com")!.personId!;

      // A GoHighLevel contact states both: one person now.
      const [ghl] = await db.select().from(ghlConnections);
      await db.insert(contacts).values({ orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-carol", primaryEmail: "carol@z.com", phoneE164: "+33699999999", rawAttributes: {}, sourceConnectionId: ghl.id });
      await buildNow();
      const carol = (await db.select().from(people).where(eq(people.personKey, "email:carol@z.com")))[0];
      expect([phoneId, emailId]).toContain(carol.personId);
      const retiredId = carol.personId === phoneId ? emailId : phoneId;
      const viaRetired = await timeline(`personId=${retiredId}`);
      expect(viaRetired.status).toBe(200);
      expect(viaRetired.body.person.personId).toBe(carol.personId);
    });
  });

  describe("stated merges (two people said to be one)", () => {
    const H = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
    const merge = (body: unknown) => H(request(app()).post("/orgs/people/merges")).send(body);
    const undo = (mergeId: string) => H(request(app()).post(`/orgs/people/merges/${mergeId}/undo`)).send({ brandId: BRAND });
    const listMergesReq = () => H(request(app()).get(`/orgs/people/merges?brandId=${BRAND}`));
    /** A build once the one the route kicked in the background has finished. */
    async function buildAfterKick() {
      const { scope } = await ensureScope(ORG, BRAND, USER);
      for (let i = 0; i < 100; i++) {
        const r = await runScopeBuild(scope);
        expect(r.ok).toBe(true);
        if (!r.skipped) return;
        await new Promise((ok) => setTimeout(ok, 20));
      }
      throw new Error("the kicked build never finished");
    }

    /** Carol on WhatsApp only (phone) and carol@z.com in cold email: two people, no record ties them. */
    async function seedCarol() {
      await seedLocalSources();
      const [mx] = await db.select().from(matrixConnections);
      const [carolWa] = await db
        .insert(contacts)
        .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_33699999999:hs", phoneE164: "+33699999999", rawAttributes: {}, sourceConnectionId: mx.id })
        .returning();
      await db.insert(conversations).values({
        orgId: ORG, brandId: BRAND, connectionId: mx.id, contactId: carolWa.id, channel: "whatsapp", roomId: "!carol",
        firstMessageAt: new Date("2026-09-06T12:00:00Z"), lastMessageAt: new Date("2026-09-06T12:00:00Z"),
        messageCount: 1, inboundCount: 1, outboundCount: 0, lastEventId: "$c1",
      });
      extraWritten = [{ ...WRITTEN[1], campaignId: "camp-3", leadEmail: "carol@z.com", engaged: false, clicked: false, firstClickedAt: null }];
      await buildNow();
      const rows = await db.select().from(people);
      return {
        phoneId: rows.find((p) => p.personKey === "phone:+33699999999")!.personId!,
        emailId: rows.find((p) => p.personKey === "email:carol@z.com")!.personId!,
      };
    }

    it("merges two people into one that survives every rebuild; undo gives each its id back", async () => {
      const { phoneId, emailId } = await seedCarol();
      const res = await merge({ brandId: BRAND, personIds: [emailId, phoneId], reason: "same human, WhatsApp number never saved" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ duplicate: false, applied: false, rebuild: "started" });
      expect(res.body.merge).toMatchObject({ personIds: [emailId, phoneId], statedByUserId: USER, active: true, reason: "same human, WhatsApp number never saved" });
      expect(res.body.merge.keys).toEqual({ a: ["email:carol@z.com"], b: ["phone:+33699999999"] });
      const mergeId = res.body.merge.mergeId;

      await buildAfterKick();
      const after = await db.select().from(people).where(sql`${people.identityKeys} @> '["phone:+33699999999"]'::jsonb`);
      expect(after).toHaveLength(1);
      expect(after[0].personKey).toBe("email:carol@z.com");
      expect(after[0].sources).toEqual(["instantly", "matrix"]);
      expect([phoneId, emailId]).toContain(after[0].personId);
      expect((after[0].mergeEvidence as { kind: string; ref: string }[]).map((e) => [e.kind, e.ref])).toEqual([["stated_merge", mergeId]]);
      // The retired id still opens the merged person; one thread holds both channels.
      const retired = after[0].personId === phoneId ? emailId : phoneId;
      const thread = await H(request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&personId=${retired}`));
      expect(thread.status).toBe(200);
      expect(thread.body.person.personId).toBe(after[0].personId);
      expect(thread.body.person.sources).toEqual(["instantly", "matrix"]);

      // A second rebuild changes nothing: still one.
      await buildNow();
      expect(await db.select().from(people).where(sql`${people.identityKeys} @> '["phone:+33699999999"]'::jsonb`)).toHaveLength(1);

      // Idempotent, and the list says it is applied.
      const again = await merge({ brandId: BRAND, personIds: [phoneId, emailId] });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ duplicate: true, applied: true, personId: after[0].personId, rebuild: "not_needed" });
      expect(again.body.merge.mergeId).toBe(mergeId);
      const listed = await listMergesReq();
      expect(listed.body.merges).toHaveLength(1);
      expect(listed.body.merges[0]).toMatchObject({ mergeId, applied: true, active: true });

      // Undo: two people again, each with its own id.
      const undone = await undo(mergeId);
      expect(undone.status).toBe(200);
      expect(undone.body).toMatchObject({ duplicate: false, rebuild: "started" });
      expect(undone.body.merge).toMatchObject({ active: false, undoneByUserId: USER });
      await buildAfterKick();
      const split = await db.select().from(people);
      expect(split.find((p) => p.personKey === "phone:+33699999999")!.personId).toBe(phoneId);
      expect(split.find((p) => p.personKey === "email:carol@z.com")!.personId).toBe(emailId);
      expect((await undo(mergeId)).body.duplicate).toBe(true);
      expect((await listMergesReq()).body.merges[0]).toMatchObject({ active: false, applied: null });
    });

    it("refuses with a reason: unknown id, another brand, the same id, already one person", async () => {
      const { phoneId, emailId } = await seedCarol();
      const unknown = "bbbbbbbb-1111-4111-8111-00000000beef";
      const r404 = await merge({ brandId: BRAND, personIds: [emailId, unknown] });
      expect(r404.status).toBe(404);
      expect(r404.body).toMatchObject({ type: "refused", reason: "person_not_found", personId: unknown });

      const otherBrand = "dddddddd-1111-4111-8111-0000000000b2";
      const r422 = await merge({ brandId: otherBrand, personIds: [emailId, phoneId] });
      expect(r422.status).toBe(422);
      expect(r422.body.reason).toBe("different_brand");

      expect((await merge({ brandId: BRAND, personIds: [emailId, emailId] })).body.reason).toBe("same_person");

      const alice = (await db.select().from(people).where(eq(people.personKey, "email:alice@x.com")))[0];
      const retired = "bbbbbbbb-1111-4111-8111-0000000000a1";
      await db.insert(personIdAliases).values({ orgId: ORG, brandId: BRAND, retiredId: retired, personId: alice.personId! });
      const r409 = await merge({ brandId: BRAND, personIds: [alice.personId, retired] });
      expect(r409.status).toBe(409);
      expect(r409.body.reason).toBe("already_one_person");

      expect((await merge({ brandId: BRAND, personIds: [emailId] })).status).toBe(400);
      expect((await undo("bbbbbbbb-1111-4111-8111-00000000dead")).status).toBe(404);
      expect((await listMergesReq()).body.merges).toEqual([]);
    });
  });

  describe("contacts added by hand (MANUAL-CONTACT-IS-A-PERSON-1024)", () => {
    const H = (r: request.Test) => r.set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
    async function buildAfterKick() {
      const { scope } = await ensureScope(ORG, BRAND, USER);
      for (let i = 0; i < 100; i++) {
        const r = await runScopeBuild(scope);
        expect(r.ok).toBe(true);
        if (!r.skipped) return;
        await new Promise((ok) => setTimeout(ok, 20));
      }
      throw new Error("the kicked build never finished");
    }

    /** Dana added by hand (email + phone + company), a file row nobody else holds, and a WhatsApp writer (phone only). */
    async function seedManual() {
      await seedLocalSources();
      const [manual] = await db
        .insert(contactUploads)
        .values({ orgId: ORG, brandId: BRAND, filename: "Contacts added one by one", contentHash: `manual:${BRAND}`, columnHeaders: [], runId: "run-m", kind: "manual", status: "promoted", uploadedAt: new Date("2026-10-20T08:00:00Z") })
        .returning();
      const [raw] = await db
        .insert(contactRowsRaw)
        .values({ orgId: ORG, brandId: BRAND, uploadId: manual.id, rowNumber: 2, payload: { email: "dana@staff-test.distribute.you" }, fetchedAt: new Date("2026-10-24T12:53:05Z") })
        .returning();
      const [dana] = await db
        .insert(contacts)
        .values({
          orgId: ORG, brandId: BRAND, source: "csv", primaryEmail: "dana@staff-test.distribute.you", phoneE164: "+33699990000",
          fullName: "Dana Testlahoud", companyName: "Staff Test Co", companyDomain: "staff-test.distribute.you", rawAttributes: {},
          sourceUploadId: manual.id, sourceRowId: raw.id,
        })
        .returning();
      const [file] = await db
        .insert(contactUploads)
        .values({ orgId: ORG, brandId: BRAND, filename: "prospects.csv", contentHash: "h-file-only", columnHeaders: ["email"], runId: "run-f", status: "promoted" })
        .returning();
      await db.insert(contacts).values({ orgId: ORG, brandId: BRAND, source: "csv", primaryEmail: "erin@staff-test.distribute.you", fullName: "Erin Fileonly", rawAttributes: {}, sourceUploadId: file.id });
      const [mx] = await db.select().from(matrixConnections);
      const [visitor] = await db
        .insert(contacts)
        .values({ orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_33688880000:hs", phoneE164: "+33688880000", rawAttributes: {}, sourceConnectionId: mx.id })
        .returning();
      await db.insert(conversations).values({
        orgId: ORG, brandId: BRAND, connectionId: mx.id, contactId: visitor.id, channel: "whatsapp", roomId: "!visitor",
        firstMessageAt: new Date("2026-10-24T09:28:00Z"), lastMessageAt: new Date("2026-10-24T09:29:00Z"),
        messageCount: 1, inboundCount: 1, outboundCount: 0, lastEventId: "$v1",
      });
      return { dana, manual };
    }

    it("is a person of the brand: listed with its tag, found by name, phone and company; a FILE row is not", async () => {
      const { dana, manual } = await seedManual();
      const summary = await buildNow();

      const rows = await db.select().from(people);
      const person = rows.find((p) => p.personKey === "email:dana@staff-test.distribute.you");
      expect(person).toMatchObject({ sources: ["csv"], displayName: "Dana Testlahoud", company: "Staff Test Co" });
      expect(person!.identityKeys).toEqual(["email:dana@staff-test.distribute.you", "phone:+33699990000"]);
      expect(person!.lastActivityAt?.toISOString()).toBe("2026-10-24T12:53:05.000Z");
      // A file row nobody else holds stays merge evidence: nobody.
      expect(rows.some((p) => (p.emails as string[]).includes("erin@staff-test.distribute.you"))).toBe(false);
      expect(summary.sources.find((s) => s.source === "csv")).toMatchObject({ status: "ok", presences: 1, sourceCount: 1 });

      const search = (q: string) => H(request(app()).get(`/orgs/people?brandId=${BRAND}&q=${encodeURIComponent(q)}`));
      for (const q of ["testlahoud", "dana@staff-test", "699 990", "staff test co"]) {
        const res = await search(q);
        expect(res.status).toBe(200);
        expect(res.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:dana@staff-test.distribute.you"]);
      }
      const listed = (await search("testlahoud")).body.people[0];
      expect(listed.connectionTags.map((t: { tag: string }) => t.tag)).toEqual(["professional_to_brand"]);
      expect(listed.sources).toEqual(["csv"]);

      // Its thread: the add, dated by the client's statement, never by the list's creation.
      const thread = await H(request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&personId=${person!.personId}`));
      expect(thread.status).toBe(200);
      expect(thread.body.items).toEqual([
        expect.objectContaining({
          at: "2026-10-24T12:53:05.000Z",
          source: "csv",
          channel: "manual",
          kind: "event",
          ref: { contactId: dana.id, uploadId: manual.id },
          event: { step: "added_to_crm", dateBasis: "added_at", detail: { origin: "manual", uploadId: manual.id, filename: "Contacts added one by one" } },
        }),
      ]);
      expect(thread.body.sources.find((s: { source: string }) => s.source === "csv")).toMatchObject({ status: "ok", items: 1 });
    });

    it("merges with another person through the stated merge: one person holding the email, the phone and the other's thread", async () => {
      await seedManual();
      await buildNow();
      const before = await db.select().from(people);
      const danaId = before.find((p) => p.personKey === "email:dana@staff-test.distribute.you")!.personId!;
      const visitorId = before.find((p) => p.personKey === "phone:+33688880000")!.personId!;

      const res = await H(request(app()).post("/orgs/people/merges")).send({ brandId: BRAND, personIds: [visitorId, danaId], reason: "the visitor is the contact added by hand" });
      expect(res.status).toBe(201);
      await buildAfterKick();

      const after = await db.select().from(people).where(sql`${people.identityKeys} @> '["phone:+33688880000"]'::jsonb`);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ personKey: "email:dana@staff-test.distribute.you", sources: ["matrix", "csv"] });
      expect(after[0].emails).toEqual(["dana@staff-test.distribute.you"]);
      expect([...(after[0].phones as string[])].sort()).toEqual(["+33688880000", "+33699990000"]);
      expect([danaId, visitorId]).toContain(after[0].personId);
    });
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

  describe("business only (personal-channel conversations judged by Jev)", () => {
    const listPeople = (query = "") =>
      request(app())
        .get(`/orgs/people?brandId=${BRAND}${query}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);
    const keysOf = (res: { body: { people: { personKey: string }[] } }) => res.body.people.map((p) => p.personKey);

    beforeEach(() => {
      gmailConnected = true;
      extraCorrespondents = [{ email: "mom@family.com", name: "Mom" }];
      personalEmails = new Set(["mom@family.com"]);
    });

    it("RELATIONSHIP-TAGS-1014: a personal thread hides NOBODY from the Unibox; the verdicts still tag offers and are judged once", async () => {
      const summary = await buildNow();
      expect(summary.relevance).toMatchObject({ status: "ok", judged: 2, notBusinessPeople: 1 });
      expect(summary.relevance!.topics).toMatchObject({ personal: 1, this_brand: 1 });
      // Org-billed on the build's run; brand and offers are in what Jev reads.
      expect(relevanceRequests[0].headers["x-org-id"]).toBe(ORG);
      expect(relevanceRequests[0].headers["x-run-id"]).toMatch(/^run-/);
      expect((relevanceRequests[0].body.state as unknown as { offers: { name: string }[] }).offers[0].name).toBe("Pro plan");

      const list = await listPeople();
      expect(keysOf(list)).toContain("email:mom@family.com");
      expect(list.body.notBusinessHidden).toBe(0);
      // Still judged (it keeps a policy-less serve as narrow as before), shown all the same.
      expect(list.body.people.find((p: { personKey: string }) => p.personKey === "email:mom@family.com").notBusiness).toBe(true);
      const alice = list.body.people.find((p: { personKey: string }) => p.personKey === "email:alice@x.com");
      expect(alice).toMatchObject({ notBusiness: false, offerIds: [OFFER] });
      expect(alice.relevance[0]).toMatchObject({ conversation: "gmail:alice@x.com", topic: "this_brand" });

      // CONNECTION-TAGS-1017: Mom is personal to the mailbox's owner; Alice (a cold-email lead
      // whose thread is about the brand) is professional to the brand, from both.
      const mom = list.body.people.find((p: { personKey: string }) => p.personKey === "email:mom@family.com");
      expect(mom.connectionTags).toEqual([
        { tag: "personal_to_user", userIds: ["user-owner"], brandId: null, basis: [{ kind: "conversation", ref: "gmail:mom@family.com", probability: 0.9 }] },
      ]);
      expect(alice.connectionTags.map((t: { tag: string }) => t.tag)).toEqual(["professional_to_brand"]);
      expect(alice.connectionTags[0].brandId).toBe(BRAND);
      expect(alice.connectionTags[0].basis.map((b: { kind: string }) => b.kind)).toEqual(expect.arrayContaining(["source", "conversation"]));
      const shown = relevanceRequests[0].body.state as unknown as { user: { users: { name: string; emails: string[] }[] } };
      expect(shown.user.users[0]).toMatchObject({ name: "Owner Brand", emails: ["me@brand.com"] });
      expect(summary.connectionTags).toMatchObject({ peopleUntagged: 0 });

      // PERSON-ORGANIZATIONS-1017: Alice (x.com, a lead) speaks for x.com; Mom (family.com) is
      // personal only: no link, though family.com is an organization's domain.
      expect(alice.organizations).toHaveLength(1);
      expect(alice.organizations[0]).toMatchObject({ domain: "x.com", evidence: expect.arrayContaining([{ kind: "email", value: "alice@x.com", source: "instantly" }]) });
      expect(alice.organizations[0].tags.map((t: { tag: string }) => t.tag)).toEqual(["professional_to_brand"]);
      expect(mom.organizations).toEqual([]);
      expect(companyResolves).toContain("x.com");
      expect(summary.organizations).toMatchObject({ status: "ok" });
      const orgs = await request(app())
        .get(`/orgs/people/organizations?brandId=${BRAND}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);
      expect(orgs.status).toBe(200);
      const xcom = orgs.body.organizations.find((o: { domains: string[] }) => o.domains.includes("x.com"));
      expect(xcom).toMatchObject({ people: 1, tags: [{ tag: "professional_to_brand", people: 1 }] });
      // The registry tells lead-service through the fact feed: one connection_tag per tag held,
      // one organization_link per company (with its professional tags), keyed on the person id.
      const registryFacts = async () =>
        (await db.execute(sql`
          SELECT type, payload, human_id, live, person_key FROM people_facts
          WHERE brand_id = ${BRAND} AND source = 'crm' AND type IN ('connection_tag', 'organization_link') AND live
          ORDER BY feed_seq
        `)) as unknown as { type: string; payload: Record<string, unknown>; live: boolean; person_key: string }[];
      const before = await registryFacts();
      expect(before.find((f) => f.person_key === "email:mom@family.com" && f.type === "connection_tag")?.payload).toMatchObject({
        tag: "personal_to_user",
        userIds: ["user-owner"],
        brandId: null,
      });
      expect(before.find((f) => f.person_key === "email:alice@x.com" && f.type === "organization_link")?.payload).toMatchObject({
        domain: "x.com",
        tags: ["professional_to_brand"],
      });

      // PERSON-RELATIONS-1017: Mom is one personal relation; Alice one professional relation at x.com.
      expect(mom.relations.map((r: { relationKey: string; capacity: string }) => [r.relationKey.split(":").slice(2).join(":"), r.capacity])).toEqual([["personal", "personal"]]);
      const aliceRel = alice.relations.find((r: { companyId: string | null }) => r.companyId === alice.organizations[0].companyId);
      expect(aliceRel).toMatchObject({ capacity: "professional", domain: "x.com", emails: ["alice@x.com"] });
      const readRel = (relationKey: string) =>
        request(app()).get(`/orgs/people/timeline?brandId=${BRAND}&relationKey=${encodeURIComponent(relationKey)}`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
      const relThread = await readRel(aliceRel.relationKey);
      expect(relThread.status).toBe(200);
      expect(relThread.body.items.every((i: { source: string }) => i.source !== "matrix")).toBe(true);
      expect((await readRel(`rel:${alice.personId}:personal`)).body.reason).toBe("relation_not_found");
      expect((await readRel("not-a-relation")).status).toBe(400);
      const relFacts = (await db.execute(sql`
        SELECT payload FROM people_facts WHERE brand_id = ${BRAND} AND type = 'relation' AND live
      `)) as unknown as { payload: { relationKey: string } }[];
      expect(relFacts.map((f) => f.payload.relationKey)).toContain(aliceRel.relationKey);

      // PEOPLE-CORRECTIONS-1017: the owner says Mom is a client at family.com, not a friend.
      const post = (body: Record<string, unknown>) =>
        request(app()).post("/orgs/people/corrections").set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER).send({ brandId: BRAND, ...body });
      const removed = await post({ kind: "tag_remove", personId: mom.personId, tag: "personal_to_user", reason: "my client" });
      expect(removed.status).toBe(201);
      expect((await post({ kind: "tag_remove", personId: mom.personId, tag: "personal_to_user" })).body.duplicate).toBe(true);
      expect((await post({ kind: "tag_add", personId: mom.personId, tag: "professional_to_brand" })).status).toBe(201);
      // No professional tag on her yet (no rebuild since): the user must say how she speaks for it.
      expect((await post({ kind: "organization_add", personId: mom.personId, domain: "family.com" })).body.reason).toBe("tags_required");
      const orgAdd = await post({ kind: "organization_add", personId: mom.personId, domain: "https://www.family.com", tags: ["professional_to_brand"] });
      expect(orgAdd.status).toBe(201);
      expect(orgAdd.body.correction.target).toMatchObject({ domain: "family.com", tags: ["professional_to_brand"] });
      expect((await post({ kind: "tag_add", personId: "aaaaaaaa-1111-4111-8111-000000000999", tag: "personal_to_user" })).status).toBe(404);
      await buildNow();
      const momAfter = (await listPeople()).body.people.find((p: { personKey: string }) => p.personKey === "email:mom@family.com");
      expect(momAfter.connectionTags.map((t: { tag: string }) => t.tag)).toEqual(["professional_to_brand"]);
      expect(momAfter.connectionTags[0].basis[0].kind).toBe("user_correction");
      expect(momAfter.organizations.map((o: { domain: string }) => o.domain)).toEqual(["family.com"]);
      // The feed follows: her friend tag is withdrawn, the corrected ones are stated.
      const momFacts = (await registryFacts()).filter((f) => f.person_key === "email:mom@family.com");
      expect(momFacts.map((f) => [f.type, f.payload.tag ?? f.payload.domain])).toEqual([
        ["connection_tag", "professional_to_brand"],
        ["organization_link", "family.com"],
      ]);
      // Undo the tag removal: the AI's friend tag is back on the next build.
      const undo = await request(app())
        .post(`/orgs/people/corrections/${removed.body.correction.correctionId}/undo`)
        .set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER)
        .send({ brandId: BRAND });
      expect(undo.status).toBe(200);
      await buildNow();
      const momUndone = (await listPeople()).body.people.find((p: { personKey: string }) => p.personKey === "email:mom@family.com");
      expect(momUndone.connectionTags.map((t: { tag: string }) => t.tag)).toEqual(["personal_to_user", "professional_to_brand"]);
      const listed = await request(app()).get(`/orgs/people/corrections?brandId=${BRAND}`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
      expect(listed.body.corrections).toHaveLength(3);
      expect(listed.body.corrections.filter((c: { undoneAt: string | null }) => c.undoneAt)).toHaveLength(1);

      // Domains are judged once: a rebuild asks Jev about none of them again.
      domainQuestions.length = 0;
      companyResolves.length = 0;
      await buildNow();
      expect(domainQuestions).toEqual([]);
      expect(companyResolves).toEqual([]);

      // An offer-scoped read: only the people Jev tied to that offer.
      expect(keysOf(await listPeople(`&offerId=${OFFER}`))).toEqual(["email:alice@x.com"]);
      expect(keysOf(await listPeople("&offerId=dddddddd-1111-4111-8111-0000000000f2"))).toEqual([]);

      // A search reaches everyone.
      expect(keysOf(await listPeople("&q=Mom"))).toEqual(["email:mom@family.com"]);

      // A rebuild with nothing new judges nothing (no new bill).
      relevanceRequests.length = 0;
      const again = await buildNow();
      expect(relevanceRequests).toHaveLength(0);
      expect(again.relevance).toMatchObject({ judged: 0, reused: 2, notBusinessPeople: 1 });
    });

    it("an unjudged thread stays visible: brand-service down hides nobody", async () => {
      const failing = vi.fn();
      vi.stubGlobal("fetch", ((orig) => async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname.endsWith("/offers")) {
          failing();
          return json({ error: "down" }, 503);
        }
        return orig(input, init);
      })(globalThis.fetch));
      const summary = await buildNow();
      expect(failing).toHaveBeenCalled();
      expect(summary.relevance).toMatchObject({ status: "failed", judged: 0, notBusinessPeople: 0 });
      expect(keysOf(await listPeople())).toContain("email:mom@family.com");
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

    it("RIGHT-MOMENT-OR-LATER-1014: a message sent by hand seconds ago is on the FIRST read (read-through, fresh mirror asked)", async () => {
      // The store read Alice's thread 30s ago; the owner has answered her by hand since.
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '30 seconds'`);
      aliceNewMessage = true;
      gmailConversationQueries.length = 0;
      const first = await timeline();
      expect(texts(first)).toContain("Send me the deck");
      const gmail = first.body.sources.find((x: { source: string }) => x.source === "gmail");
      expect(gmail).toMatchObject({ status: "ok", servedFrom: "store", items: 3, error: null });
      expect(Date.now() - new Date(gmail.readAt).getTime()).toBeLessThan(10_000);
      // google-service was asked to bring its mirror up to date before answering.
      expect(gmailConversationQueries).toHaveLength(1);
      expect(gmailConversationQueries[0].get("fresh")).toBe("true");
      // and the search sees it too
      const found = await request(app()).get(`/orgs/people?brandId=${BRAND}&q=deck`).set("x-api-key", API_KEY).set("x-org-id", ORG).set("x-user-id", USER);
      expect(found.body.people.map((p: { personKey: string }) => p.personKey)).toEqual(["email:alice@x.com"]);
      // A second read seconds later shares that read: no new sibling call.
      calls.length = 0;
      expect(texts(await timeline())).toContain("Send me the deck");
      expect(siblingReads()).toEqual([]);
    });

    it("HEAVY-MAILBOX-THREAD-READ-1029: a fresh Gmail read that fails serves crm's stored copy, saying why and how old", async () => {
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '30 seconds'`);
      gmailConversationDown = true;
      const res = await timeline();
      expect(res.status).toBe(200);
      const sources = Object.fromEntries(res.body.sources.map((x: { source: string }) => [x.source, x]));
      expect(sources.gmail).toMatchObject({ status: "ok", items: 2, refreshing: false });
      expect(sources.gmail.error).toContain("not re-read for this answer");
      expect(sources.gmail.error).toContain("returned 500");
      expect(texts(res)).toContain("Sure, call me"); // what was stored is still shown, flagged
      expect(sources.instantly).toMatchObject({ status: "ok" });
      // The source answers again: the next read is ok.
      gmailConversationDown = false;
      const back = await timeline();
      expect(back.body.sources.find((x: { source: string }) => x.source === "gmail")).toMatchObject({ status: "ok", error: null });
    });

    it("HEAVY-MAILBOX-THREAD-READ-1029: a Gmail re-read slower than the deadline never fails the read: the stored copy is served at the deadline (refreshing), the late read lands for the next one", async () => {
      const prev = process.env.PEOPLE_TIMELINE_FRESH_DEADLINE_MS;
      process.env.PEOPLE_TIMELINE_FRESH_DEADLINE_MS = "200";
      try {
        await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '30 seconds'`);
        aliceNewMessage = true;
        gmailConversationDelayMs = 800;
        const startedAt = Date.now();
        const slow = await timeline();
        expect(Date.now() - startedAt).toBeLessThan(800); // answered at the deadline, never after the re-read
        const gmail = slow.body.sources.find((x: { source: string }) => x.source === "gmail");
        expect(gmail).toMatchObject({ status: "ok", items: 2, error: null, refreshing: true });
        expect(texts(slow)).not.toContain("Send me the deck");
        gmailConversationDelayMs = 0;
        await vi.waitFor(
          async () => {
            const [row] = (await db.execute(
              sql`SELECT count(*)::int AS n FROM people_message_units WHERE source = 'gmail' AND unit = 'alice@x.com' AND indexed_at > now() - interval '5 seconds'`,
            )) as unknown as { n: number }[];
            expect(row.n).toBe(1);
          },
          { timeout: 5000, interval: 50 },
        );
        const next = await timeline();
        expect(next.body.sources.find((x: { source: string }) => x.source === "gmail")).toMatchObject({ status: "ok" });
        expect(texts(next)).toContain("Send me the deck");
      } finally {
        if (prev === undefined) delete process.env.PEOPLE_TIMELINE_FRESH_DEADLINE_MS;
        else process.env.PEOPLE_TIMELINE_FRESH_DEADLINE_MS = prev;
      }
    });

    const paged = (q: string) =>
      request(app())
        .get(`/orgs/people/timeline?brandId=${BRAND}&personKey=${encodeURIComponent("email:alice@x.com")}&${q}`)
        .set("x-api-key", API_KEY)
        .set("x-org-id", ORG)
        .set("x-user-id", USER);

    it("DASH-LATENCY-1014: a paged read serves the latest items first; walking olderCursor covers the whole thread once", async () => {
      const whole = await timeline();
      const total = whole.body.items.length;
      expect(total).toBeGreaterThan(3);
      const first = await paged("limit=2");
      expect(first.status).toBe(200);
      expect(first.body.itemCount).toBe(2);
      expect(first.body.totalItems).toBe(total);
      expect(first.body.page).toMatchObject({ limit: 2, before: null, hasOlder: true });
      // Oldest first inside the page; the page is the newest of the thread.
      expect(first.body.items.map((i: { at: string | null }) => i.at)).toEqual(whole.body.items.slice(-2).map((i: { at: string | null }) => i.at));
      const walked = [...first.body.items];
      let cursor: string | null = first.body.page.olderCursor;
      while (cursor) {
        const next = await paged(`limit=2&before=${encodeURIComponent(cursor)}`);
        expect(next.status).toBe(200);
        expect(next.body.page.before).toBe(cursor);
        walked.unshift(...next.body.items);
        cursor = next.body.page.olderCursor;
      }
      expect(walked).toHaveLength(total);
      // Same items, same values (key order aside: a page's texts are filled in after the order is known).
      const sortKeys = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)])) : v;
      const canon = (xs: unknown[]) => xs.map((x) => JSON.stringify(sortKeys(x))).sort();
      expect(canon(walked)).toEqual(canon(whole.body.items));
      // The whole-thread read is unchanged: no page fields.
      expect(whole.body.page).toBeUndefined();
      expect(whole.body.itemCount).toBe(total);
      // `before` alone pages too (default 10); a cursor we never served is a 400.
      const byCursor = await paged(`before=${encodeURIComponent(first.body.page.olderCursor)}`);
      expect(byCursor.body.page.limit).toBe(10);
      expect(byCursor.body.items).toHaveLength(total - 2);
      expect((await paged("before=not-a-cursor")).status).toBe(400);
    });

    it("DASH-LATENCY-1014: a paged read never waits for a slow Gmail re-read: stored thread served, gmail refreshing (not failed)", async () => {
      const prev = process.env.PEOPLE_TIMELINE_PAGE_FRESH_WAIT_MS;
      process.env.PEOPLE_TIMELINE_PAGE_FRESH_WAIT_MS = "100";
      try {
        await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '30 seconds'`);
        aliceNewMessage = true;
        gmailConversationDelayMs = 800;
        const t0 = Date.now();
        const page = await paged("limit=50");
        expect(Date.now() - t0).toBeLessThan(700);
        const gmail = page.body.sources.find((x: { source: string }) => x.source === "gmail");
        expect(gmail).toMatchObject({ status: "ok", items: 2, error: null, refreshing: true });
        expect(texts(page)).not.toContain("Send me the deck");
        gmailConversationDelayMs = 0;
        await vi.waitFor(
          async () => {
            const [row] = (await db.execute(
              sql`SELECT count(*)::int AS n FROM people_message_units WHERE source = 'gmail' AND unit = 'alice@x.com' AND indexed_at > now() - interval '5 seconds'`,
            )) as unknown as { n: number }[];
            expect(row.n).toBe(1);
          },
          { timeout: 5000, interval: 50 },
        );
        const next = await paged("limit=50");
        expect(next.body.sources.find((x: { source: string }) => x.source === "gmail")).toMatchObject({ status: "ok", refreshing: false });
        expect(texts(next)).toContain("Send me the deck");
      } finally {
        if (prev === undefined) delete process.env.PEOPLE_TIMELINE_PAGE_FRESH_WAIT_MS;
        else process.env.PEOPLE_TIMELINE_PAGE_FRESH_WAIT_MS = prev;
      }
    });

    it("DASH-LATENCY-1014: two reads at once share ONE re-read of a thread", async () => {
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '30 seconds'`);
      aliceNewMessage = true;
      gmailConversationDelayMs = 300;
      gmailConversationQueries.length = 0;
      try {
        const [a, b] = await Promise.all([timeline(), timeline()]);
        for (const r of [a, b]) {
          expect(r.body.sources.find((x: { source: string }) => x.source === "gmail")).toMatchObject({ status: "ok", refreshing: false });
          expect(texts(r)).toContain("Send me the deck");
        }
        expect(gmailConversationQueries).toHaveLength(1);
      } finally {
        gmailConversationDelayMs = 0;
      }
    });

    const factFor = (seq: number, email: string, campaignId: string, orgId = ORG, brandIds = [BRAND], recordedAt = new Date().toISOString()) => ({
      seq: String(seq),
      type: "email_sent",
      subjectKey: `ievt:${seq}`,
      supersedesSeq: null,
      occurredAt: recordedAt,
      recordedAt,
      leadEmail: email,
      orgId,
      campaignId,
      instantlyCampaignId: "self:1",
      brandIds,
      transport: "smtp",
    });

    it("a reply we sent hours after the store read the thread is in it on the FIRST open (the watch re-read it)", async () => {
      aliceOurReply = true;
      gmailConnected = false; // the Gmail half of the watch has its own test
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '10 hours'`);
      outreachFacts = [
        factFor(1, "Alice@X.com", "camp-1"),
        // Another brand's thread and a fact older than a day name nothing here.
        factFor(2, "alice@x.com", "camp-1", ORG, ["eeeeeeee-1111-4111-8111-000000000009"]),
        factFor(3, "bob@y.com", "camp-2", ORG, [BRAND], "2026-01-01T00:00:00.000Z"),
      ];
      const [pass] = (await runFreshnessPass())!;
      expect(pass).toMatchObject({ moved: 1, refreshed: 1, failed: 0 });

      calls.length = 0;
      const first = await timeline();
      expect(texts(first)).toContain("Floating this to the top of your inbox");
      // Served from the store the watch refreshed: the open itself read no conversation.
      expect(calls.filter((c) => c.endsWith("/orgs/conversations"))).toEqual([]);

      // The cursor moved: a second pass names nothing new and reads nothing.
      calls.length = 0;
      const [again] = (await runFreshnessPass())!;
      expect(again).toMatchObject({ moved: 0, refreshed: 0 });
      expect(calls.filter((c) => c.endsWith("/orgs/conversations"))).toEqual([]);
    });

    it("an open that finds a thread stored before a known move re-reads that thread first, and only it", async () => {
      aliceOurReply = true;
      // Read 5s ago (inside the read-through window), but the cold-email thread moved since.
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '5 seconds'`);
      await db.execute(sql`UPDATE people_message_units SET changed_at = now() WHERE source = 'instantly' AND unit = 'camp-1:alice@x.com'`);
      calls.length = 0;
      const first = await timeline();
      expect(texts(first)).toContain("Floating this to the top of your inbox");
      expect(calls.filter((c) => c.endsWith("/orgs/conversations"))).toHaveLength(1);
      expect(calls.filter((c) => c.endsWith("/orgs/google/conversation"))).toEqual([]);
    });

    it("a Gmail address whose last message moved past what we saw is re-read by the watch", async () => {
      aliceNewMessage = true;
      await db.execute(sql`UPDATE people_message_units SET indexed_at = now() - interval '10 hours'`);
      await runFreshnessPass();
      calls.length = 0;
      expect(texts(await timeline())).toContain("Send me the deck");
      // The open answered from the Gmail copy the watch refreshed seconds ago (the 10-hour-old
      // cold-email copy is re-read before the answer, Gmail is not).
      expect(calls.filter((c) => c.endsWith("/orgs/google/conversation"))).toEqual([]);
      // Same last message on the next pass: nothing to re-read.
      calls.length = 0;
      const [again] = (await runFreshnessPass())!;
      expect(again).toMatchObject({ moved: 0, refreshed: 0 });
      expect(calls.filter((c) => c.endsWith("/orgs/google/conversation"))).toEqual([]);
    });

    const wipeMessageStore = () =>
      retryOnDeadlock(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM people_message_texts`);
          await tx.execute(sql`DELETE FROM people_message_units`);
        }),
      );

    it("a never-read address is read once, on the spot; a source that could never be read says failed", async () => {
      await wipeMessageStore();
      const res = await timeline();
      expect(texts(res)).toContain("Sure, call me");

      await wipeMessageStore();
      gmailConversationDown = true;
      const down = await timeline();
      const gmail = down.body.sources.find((x: { source: string }) => x.source === "gmail");
      expect(gmail).toMatchObject({ status: "failed", items: 0, readAt: null });
      expect(gmail.error).toContain("returned 500");

      // Each read retries the failed thread once, before answering.
      calls.length = 0;
      await timeline();
      expect(calls.filter((c) => c.endsWith("/orgs/google/conversation")).length).toBeLessThanOrEqual(1);
      gmailConversationDown = false;
      await vi.waitFor(
        async () => {
          await timeline(); // each read retries the failed unit
          const [row] = (await db.execute(sql`SELECT status FROM people_message_units WHERE source = 'gmail' AND unit = 'alice@x.com'`)) as unknown as { status: string }[];
          expect(row.status).toBe("ok");
        },
        { timeout: 5000, interval: 50 },
      );
      expect(texts(await timeline())).toContain("Sure, call me");
    });
  });
});
