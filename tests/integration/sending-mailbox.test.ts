import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { calendarFeedCursors, mailboxMessages, people } from "../../src/db/schema.js";
import { ensureScope, runScopeBuild } from "../../src/lib/people/build.js";
import { emitScopeFacts } from "../../src/lib/people/facts.js";
import { mailboxItems } from "../../src/lib/people/timeline.js";
import { MAILBOX_FEED, runMailboxPass } from "../../src/lib/mailbox/feed.js";
import type { Presence } from "../../src/lib/people/identity.js";

/**
 * EVERY-PERSON-ON-THE-THREAD-1109: our sending mailboxes are a CRM source, against a real Postgres (gated on
 * CRM_TEST_DB). instantly-service's mailbox-messages feed, Jev and every sibling are stubbed at `fetch`.
 * The case is the real one (Living Vital, 2026-11-09), on fake ids: our cold email to Thomas, his colleague Markus
 * answering in the same thread, our answer Cc'ing Markus.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "5e4d5e4d-1111-4111-8111-000000000001";
const BRAND = "5e4d5e4d-1111-4111-8111-000000000002";
const OFFER = "5e4d5e4d-1111-4111-8111-000000000003";
const USER = "user-mailbox-1";

process.env.GOOGLE_SERVICE_URL = "http://google.test";
process.env.GOOGLE_SERVICE_API_KEY = "g";
process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
process.env.INSTANTLY_SERVICE_API_KEY = "i";
process.env.LEAD_SERVICE_URL = "http://lead.test";
process.env.LEAD_SERVICE_API_KEY = "l";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "b";
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "c";

const MAILBOX = "kevin@sendmail.test";
const THOMAS = "thomas@markthalle.test";
const MARKUS = "markus@markthalle.test";
const ANNA = "anna@markthalle.test";
const ROBOT = "noreply@robot.test";
const OTHER_LEAD = "lead2@elsewhere.test";
const T = "<cold-1@sendmail.test>";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const msg = (over: Record<string, unknown> & { id: string; version: string }) => ({
  mailbox: MAILBOX,
  direction: "in",
  kind: "reply",
  messageId: `<${over.id}@x>`,
  inReplyTo: null,
  references: [],
  threadKey: T,
  occurredAt: "2026-11-09T06:08:57.000Z",
  subject: "Re: Flohsamenschalen für die Markthalle",
  from: null,
  to: [],
  cc: [],
  bcc: [],
  participants: [],
  text: null,
  textUnavailableReason: null,
  sentBy: null,
  orgId: ORG,
  brandIds: [BRAND],
  campaignId: "camp-lv",
  instantlyCampaignId: "self:seq-thomas",
  leadEmail: THOMAS,
  ...over,
});

// Our cold email to Thomas (only him on it).
const COLD = msg({
  id: "smtp:cold",
  version: "1",
  direction: "out",
  kind: "outreach",
  messageId: T,
  subject: "Flohsamenschalen für die Markthalle",
  from: { address: MAILBOX, name: "Kevin" },
  to: [{ address: THOMAS, name: null }],
  participants: [{ email: MAILBOX, role: "from" }, { email: THOMAS, role: "to" }],
  text: "Hi Thomas, Living Vital ist ein Schweizer Familienbetrieb…",
  sentBy: "automation",
});
// Markus answers in Thomas's thread (forwarded to him internally), Anna in Cc.
const MARKUS_REPLY = msg({
  id: "imap:markus",
  version: "2",
  occurredAt: "2026-11-09T15:28:51.000Z",
  from: { address: MARKUS, name: "Markus Schmid" },
  to: [{ address: MAILBOX, name: null }],
  cc: [{ address: ANNA, name: "Anna Keller" }],
  references: [T],
  participants: [{ email: MARKUS, role: "from" }, { email: MAILBOX, role: "to" }, { email: ANNA, role: "cc" }],
  text: "Hoi Kevin, sind die Flohsamenschalen in der CH gewachsen?",
});
// Our answer: To Thomas, Cc Markus and our staff.
const OUR_ANSWER = msg({
  id: "smtp:answer",
  version: "3",
  direction: "out",
  kind: "manual_reply",
  occurredAt: "2026-11-09T15:30:13.000Z",
  from: { address: MAILBOX, name: "Kevin" },
  to: [{ address: THOMAS, name: null }],
  cc: [{ address: MARKUS, name: null }, { address: "kevin@distribute.you", name: null }],
  references: [T],
  participants: [],
  text: "Hi Markus, our psyllium is grown in…",
  sentBy: "automation",
});
// A plain cold email to another lead: nobody else on it, its words are not kept.
const OTHER_COLD = msg({
  id: "smtp:other",
  version: "4",
  direction: "out",
  kind: "outreach",
  threadKey: "<cold-2@sendmail.test>",
  messageId: "<cold-2@sendmail.test>",
  from: { address: MAILBOX, name: "Kevin" },
  to: [{ address: OTHER_LEAD, name: null }],
  leadEmail: OTHER_LEAD,
  text: "Hi, cold pitch",
});
// A robot writing to our mailbox on a thread of its own.
const ROBOT_REPLY = msg({
  id: "imap:robot",
  version: "5",
  threadKey: "<ticket-4411@robot.test>",
  from: { address: ROBOT, name: "Notifications" },
  to: [{ address: MAILBOX, name: null }],
  leadEmail: OTHER_LEAD,
  text: "Your ticket #4411 has been received. This is an automated message.",
  occurredAt: "2026-11-09T10:00:00.000Z",
});

let feed: Record<string, unknown>[] = [];
let threadFeed: Record<string, Record<string, unknown>[]> = {};
const relevanceInputs: { email: string; messages: { direction: string; from?: string; text: string }[] }[] = [];
const senderInputs: string[] = [];

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) return json({ id: "run-" + Math.random().toString(16).slice(2) });
    if (url.host === "instantly.test" && url.pathname === "/internal/mailbox-messages") {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("i");
      const threadKey = url.searchParams.get("threadKey");
      if (threadKey) return json({ messages: threadFeed[threadKey] ?? [], nextCursor: "0", hasMore: false });
      const after = Number(url.searchParams.get("after") ?? 0);
      const page = feed.filter((m) => Number(m.version) > after).sort((a, b) => Number(a.version) - Number(b.version));
      return json({ messages: page, nextCursor: page.length ? String(page[page.length - 1].version) : String(after), hasMore: false });
    }
    if (url.host === "localhost:9998" && url.pathname === "/orgs/judgments") {
      const body = JSON.parse(String(init!.body));
      if (body.state.conversation) {
        relevanceInputs.push({ email: body.state.conversation.counterpart.email, messages: body.state.conversation.messages });
        return json({
          model: "jev-test",
          answers: {
            topic: { type: "choice", choice: "this_brand", confidence: 0.9, probabilities: { personal: 0.02, other_business: 0.08, this_brand: 0.9 } },
            o0: { type: "noul", noul: 0.8 },
            t_personal_to_user: { type: "noul", noul: 0.02 },
            t_personal_not_to_user: { type: "noul", noul: 0.02 },
            t_professional_to_brand: { type: "noul", noul: 0.92 },
            t_professional_not_to_brand: { type: "noul", noul: 0.05 },
          },
        });
      }
      if (body.state.senders) {
        const answers: Record<string, unknown> = {};
        for (const [k, s] of Object.entries(body.state.senders as Record<string, { email: string }>)) {
          senderInputs.push(s.email);
          answers[k] =
            s.email === ROBOT
              ? { type: "choice", choice: "automated", confidence: 0.95, probabilities: { human: 0.05, automated: 0.95 } }
              : { type: "choice", choice: "human", confidence: 0.95, probabilities: { human: 0.95, automated: 0.05 } };
        }
        return json({ model: "jev-test", answers });
      }
      if (body.questions.point) return json({ model: "jev-test", answers: { point: { type: "choice", choice: "unknown", confidence: 0.9, probabilities: {} } } });
      const answers: Record<string, unknown> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { type: "choice", choice: "organization", confidence: 0.95, probabilities: {} };
      return json({ model: "jev-test", answers });
    }
    if (url.host === "google.test") return json({ error: "none", reason: "no_google_account_connected" }, 404);
    if (url.host === "instantly.test" && url.pathname === "/internal/accounts") return json({ accounts: [{ email: MAILBOX, mailboxLogin: MAILBOX }] });
    if (url.host === "instantly.test" && url.pathname === "/orgs/written-to-leads") {
      return json({
        success: true,
        count: 1,
        nextCursor: null,
        leads: [
          {
            campaignId: "camp-lv", instantlyCampaignId: "self:seq-thomas", leadEmail: THOMAS, brandIds: [BRAND],
            firstSentAt: "2026-11-09T06:08:57.000Z", lastSentAt: "2026-11-09T15:30:13.000Z", engaged: true, replied: true, clicked: false,
            unsubscribed: false, bounced: false, firstRepliedAt: "2026-11-09T15:28:51.000Z", firstClickedAt: null, replyClassification: null,
            replyKind: null, disqualified: false,
          },
        ],
      });
    }
    if (url.host === "instantly.test") return json({ success: true, count: 0, leads: [], facts: [], nextCursor: "0", hasMore: false });
    if (url.host === "lead.test" && url.pathname === "/orgs/leads/unibox") return json({ rows: [], nextCursor: null });
    if (url.host === "lead.test") return json({ leads: [] });
    if (url.host === "client.test") return json({ users: [], total: 0 });
    if (url.host === "brand.test" && url.pathname === "/internal/companies/resolve") {
      const body = JSON.parse(String(init!.body)) as { companies: { ref: string; domain: string }[] };
      return json({ companies: body.companies.map((c, index) => ({ index, ref: c.ref, brandId: "5e4d5e4d-2222-4222-8222-000000000009", domain: c.domain, matchedBy: "domain", created: true, unresolvedReason: null })) });
    }
    if (url.host === "brand.test") {
      if (url.pathname.endsWith("/offers")) return json({ offers: [{ offerId: OFFER, brandId: BRAND, name: "Psyllium husks", description: null, status: "active" }] });
      if (url.pathname === "/orgs/brands") return json({ brands: [{ id: BRAND, name: "Living Vital", domain: "livingvital.test" }] });
      if (url.pathname.endsWith("/extracted-fields")) return json({ brandId: BRAND, fields: [] });
      if (url.pathname.endsWith("/fields")) return json({ fields: {} });
      return json({ brand: { id: BRAND, name: "Living Vital", domain: "livingvital.test", url: "https://livingvital.test" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function wipe() {
  await db.execute(sql`DELETE FROM mailbox_message_people WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM mailbox_messages WHERE org_id = ${ORG} OR id LIKE 'test-mb:%'`);
  await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, MAILBOX_FEED));
  for (const t of ["people_facts", "people", "lead_standing_observations", "conversation_verdicts", "person_ids", "people_scopes"]) {
    await db.execute(sql.raw(`DELETE FROM ${t} WHERE brand_id = '${BRAND}'`));
  }
  await db.execute(sql`DELETE FROM sender_verdicts WHERE org_id = ${ORG}`);
}

const noRebuild = async () => undefined;

describe.skipIf(!RUN)("Sending mailboxes: every person on the thread", () => {
  beforeEach(async () => {
    installFetchStub();
    feed = [];
    threadFeed = {};
    relevanceInputs.length = 0;
    senderInputs.length = 0;
    await wipe();
  });
  afterAll(wipe);

  it("Markus (From) and Anna (Cc) become people of the brand, judged by Jev; Thomas stays the cold-email lead; a robot is filtered", async () => {
    feed = [COLD, MARKUS_REPLY, OUR_ANSWER, OTHER_COLD, ROBOT_REPLY];
    const pass = await runMailboxPass(noRebuild);
    expect(pass).toMatchObject({ read: 5, stored: 5, caughtUp: true, cursor: "5" });
    expect(pass.scopes).toEqual([{ orgId: ORG, brandId: BRAND }]);

    // Words kept on Thomas's thread (it names Markus), not on a cold email nobody else is on.
    const stored = new Map((await db.select().from(mailboxMessages)).map((m) => [m.id, m]));
    expect(stored.get("smtp:cold")!.text).toContain("Hi Thomas");
    expect(stored.get("smtp:other")!).toMatchObject({ text: null, textKept: false, textUnavailableReason: "not_kept_lead_only_thread" });
    expect(stored.get("imap:robot")!.textKept).toBe(true);

    const people2 = await db.execute(sql`SELECT message_id, address, role, sequence_lead FROM mailbox_message_people WHERE org_id = ${ORG} ORDER BY message_id, address`);
    // Our mailbox and our staff are nobody; the sequence's lead holds no row here (the cold-email source's).
    expect((people2 as unknown as { message_id: string; address: string; role: string }[]).map((r) => `${r.message_id} ${r.address} ${r.role}`)).toEqual([
      `imap:markus ${ANNA} cc`,
      `imap:markus ${MARKUS} from`,
      `imap:robot ${ROBOT} from`,
      `smtp:answer ${MARKUS} cc`,
    ]);

    const { scope } = await ensureScope(ORG, BRAND, USER);
    const built = await runScopeBuild(scope);
    expect(built.ok).toBe(true);
    const rows = await db.select().from(people).where(eq(people.scopeId, scope.id));
    const byEmail = (e: string) => rows.find((r) => (r.emails as string[]).includes(e));

    const markus = byEmail(MARKUS)!;
    expect(markus).toBeTruthy();
    expect(markus.displayName).toBe("Markus Schmid");
    const mp = (markus.presences as Presence[]).find((p) => p.source === "sending_mailbox")!;
    expect(mp).toMatchObject({ inboundCount: 1, outboundCount: 1, messageCount: 2 });
    expect((markus.connectionTags as { tag: string }[]).map((t) => t.tag)).toContain("professional_to_brand");

    // Jev read Markus's whole thread: our cold email to Thomas, his own reply, our answer.
    const seen = relevanceInputs.find((r) => r.email === MARKUS)!;
    expect(seen.messages.map((m) => [m.direction, m.from])).toEqual([
      ["outbound", MAILBOX],
      ["inbound", MARKUS],
      ["outbound", MAILBOX],
    ]);
    // Anna was only copied: she wrote nothing, so her thread is read too (it holds words), but never as hers.
    const anna = byEmail(ANNA)!;
    expect((anna.presences as Presence[]).find((p) => p.source === "sending_mailbox")).toMatchObject({ inboundCount: 0, outboundCount: 0 });
    expect(relevanceInputs.find((r) => r.email === ANNA)!.messages.some((m) => m.direction === "inbound")).toBe(false);

    // Thomas: the cold-email lead, no second presence.
    const thomas = byEmail(THOMAS)!;
    expect((thomas.presences as Presence[]).map((p) => p.source)).toEqual(["instantly"]);

    // The robot: Jev asked who owns the address, automated, filtered as today.
    expect(senderInputs).toContain(ROBOT);
    expect(senderInputs).not.toContain(ANNA); // wrote nothing: never asked
    expect(byEmail(ROBOT)!.automated).toBe(true);

    // Facts: one per (address, message); the sequence's lead states none here.
    await emitScopeFacts(scope);
    const facts = (await db.execute(sql`
      SELECT type, subject_presence, payload FROM people_facts
      WHERE brand_id = ${BRAND} AND source = 'sending_mailbox' AND live ORDER BY subject_presence, type
    `)) as unknown as { type: string; subject_presence: string; payload: Record<string, unknown> }[];
    expect(facts.map((f) => `${f.subject_presence} ${f.type} ${f.payload.role}`)).toEqual([
      `sending_mailbox:${ANNA} message_copied cc`,
      `sending_mailbox:${MARKUS} message_in from`,
      `sending_mailbox:${MARKUS} message_out cc`,
      `sending_mailbox:${ROBOT} message_in from`,
    ]);
    const markusIn = facts.find((f) => f.type === "message_in" && f.subject_presence.endsWith(MARKUS))!;
    expect(markusIn.payload).toMatchObject({
      channel: "email",
      mailboxMessageId: "imap:markus",
      threadKey: T,
      from: MARKUS,
      sequence: { campaignId: "camp-lv", leadEmail: THOMAS },
    });
    expect((markusIn.payload.participants as { email: string; role: string }[]).map((p) => p.role)).toEqual(["from", "to", "cc"]);

    // Markus's Unibox: the whole thread, the message linked to both of them.
    const items = await mailboxItems({ orgId: ORG, brandId: BRAND, emails: [MARKUS] });
    expect(items.items.map((i) => [i.ref.mailboxMessageId, i.direction])).toEqual([
      ["smtp:cold", "outbound"],
      ["imap:markus", "inbound"],
      ["smtp:answer", "outbound"],
    ]);
    expect(items.items[1].cc).toEqual([ANNA]);
    // Thomas reads his thread from the cold-email source: nothing doubled here.
    expect((await mailboxItems({ orgId: ORG, brandId: BRAND, emails: [THOMAS] })).items).toEqual([]);
  }, 60_000);

  it("a re-served message replaces its copy; an older version never steps back", async () => {
    feed = [COLD];
    await runMailboxPass(noRebuild);
    feed = [{ ...COLD, version: "7", subject: "Updated subject" }];
    expect(await runMailboxPass(noRebuild)).toMatchObject({ stored: 1, cursor: "7" });
    // The same id served again at an older version (a page re-read out of order): nothing changes.
    await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, MAILBOX_FEED));
    feed = [{ ...COLD, version: "1", subject: "Old subject" }];
    expect(await runMailboxPass(noRebuild)).toMatchObject({ stored: 0 });
    const [row] = await db.select().from(mailboxMessages).where(eq(mailboxMessages.id, "smtp:cold"));
    expect(row).toMatchObject({ version: "7", subject: "Updated subject" });
  });

  it("a thread that starts naming someone else gets the words of its earlier messages back (one thread read)", async () => {
    feed = [OTHER_COLD];
    await runMailboxPass(noRebuild);
    expect((await db.select().from(mailboxMessages).where(eq(mailboxMessages.id, "smtp:other")))[0].textKept).toBe(false);
    threadFeed = { "<cold-2@sendmail.test>": [OTHER_COLD] };
    const colleague = msg({
      id: "imap:colleague",
      version: "8",
      threadKey: "<cold-2@sendmail.test>",
      from: { address: "boss@elsewhere.test", name: "Boss" },
      to: [{ address: MAILBOX, name: null }],
      cc: [{ address: OTHER_LEAD, name: null }],
      leadEmail: OTHER_LEAD,
      text: "I handle this, call me",
    });
    feed = [colleague];
    expect(await runMailboxPass(noRebuild)).toMatchObject({ stored: 1, threadsFilled: 1 });
    const [earlier] = await db.select().from(mailboxMessages).where(eq(mailboxMessages.id, "smtp:other"));
    expect(earlier).toMatchObject({ textKept: true, text: "Hi, cold pitch" });
  });

  it("a message the producer cannot attribute is stored and filed on nobody", async () => {
    feed = [msg({ id: "test-mb:orphan", version: "9", orgId: null, brandIds: [], leadEmail: null, from: { address: "x@y.test", name: null }, text: "hello" })];
    expect(await runMailboxPass(noRebuild)).toMatchObject({ stored: 1, scopes: [] });
    const n = await db.execute(sql`SELECT count(*)::int AS n FROM mailbox_message_people WHERE message_id = 'test-mb:orphan'`);
    expect((n as unknown as { n: number }[])[0].n).toBe(0);
  });
});
