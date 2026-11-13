import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { calendarFeedCursors, newsletterSends } from "../../src/db/schema.js";
import { transactionalItems } from "../../src/lib/people/timeline.js";
import { NEWSLETTER_FEED, runNewsletterPass, type FeedNewsletter } from "../../src/lib/transactional/newsletters.js";

/**
 * UNIBOX-NEWSLETTER-1113: transactional-email-service's sent-newsletters feed mirrored and filed on the subscriber's
 * thread in the sending org's scopes, against a real Postgres (gated on CRM_TEST_DB). The feed is stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "4e754e75-1111-4111-8111-000000000001";
const BRAND = "4e754e75-1111-4111-8111-000000000002";
const OTHER_BRAND = "4e754e75-1111-4111-8111-000000000003";
const OTHER_ORG = "4e754e75-1111-4111-8111-000000000004";
const SUB = "jmatuszak@excelsiorortho.test";

process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://tx.test";
process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "tx-key";
// Not the staff Unibox: a newsletter is filed in any scope of the org that sent it.
process.env.COPILOT_UNIBOX_ORG_ID = "4e754e75-1111-4111-8111-0000000000ff";
process.env.COPILOT_UNIBOX_BRAND_ID = "4e754e75-1111-4111-8111-0000000000fe";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const send = (over: Partial<FeedNewsletter> & { id: string }): FeedNewsletter => ({
  releaseId: "4e754e75-1111-4111-8111-0000000000b1",
  listSlug: "newsletter",
  recipientEmail: "JMatuszak@ExcelsiorOrtho.test",
  orgId: ORG,
  brandIds: null,
  from: "Kevin from distribute.you <kevin@distribute.you>",
  subject: "When positive replies to cold email arrive",
  sentAt: "2026-10-26T22:07:25.748Z",
  ...over,
});

const N1 = send({ id: "4e754e75-1111-4111-8111-0000000000a1" });
const N2 = send({ id: "4e754e75-1111-4111-8111-0000000000a2", releaseId: "4e754e75-1111-4111-8111-0000000000b2", subject: "Signups and meetings start with the right people", sentAt: "2026-11-02T04:00:02.503Z" });
const N3 = send({ id: "4e754e75-1111-4111-8111-0000000000a3", subject: "Another org's letter", orgId: OTHER_ORG, sentAt: "2026-11-03T04:00:00Z" });
const N4 = send({ id: "4e754e75-1111-4111-8111-0000000000a4", subject: "Other brand only", brandIds: [OTHER_BRAND], sentAt: "2026-11-04T04:00:00Z" });

let pages: Record<string, { emails: FeedNewsletter[]; nextCursor: string | null }> = {};
const asked: (string | null)[] = [];

function stubFeed() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "tx.test" && url.pathname === "/internal/sent-newsletters") {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("tx-key");
      const after = url.searchParams.get("after");
      asked.push(after);
      return json(pages[after ?? ""] ?? { emails: [], nextCursor: after });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe.skipIf(!RUN)("newsletter sends on the subscriber's thread (real DB)", () => {
  const wipe = async () => {
    await db.execute(sql`TRUNCATE newsletter_sends`);
    await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, NEWSLETTER_FEED));
  };
  beforeEach(async () => {
    await wipe();
    pages = {};
    asked.length = 0;
    stubFeed();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await wipe();
  });

  it("mirrors each sent newsletter once, then files it on the subscriber's thread in the sending org's scopes only", async () => {
    pages = { "": { emails: [N1, N2], nextCursor: "c1" }, c1: { emails: [N3, N4], nextCursor: "c2" } };
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(await runNewsletterPass(now)).toMatchObject({ read: 4, stored: 4, caughtUp: true, cursor: "c2" });
    // A re-read stores nothing twice.
    pages[""] = { emails: [N1, N2], nextCursor: "c1" };
    await db.delete(calendarFeedCursors).where(eq(calendarFeedCursors.feed, NEWSLETTER_FEED));
    expect(await runNewsletterPass(now)).toMatchObject({ stored: 0 });
    const [row] = await db.select().from(newsletterSends).where(eq(newsletterSends.id, N1.id));
    expect(row.recipientEmail).toBe(SUB);

    const thread = await transactionalItems({ orgId: ORG, brandId: BRAND, emails: [SUB] });
    expect(thread.status).toBe("ok");
    expect(thread.items.map((i) => [i.at, i.subject, i.direction, i.ref.eventType])).toEqual([
      ["2026-10-26T22:07:25.748Z", "When positive replies to cold email arrive", "outbound", "newsletter"],
      ["2026-11-02T04:00:02.503Z", "Signups and meetings start with the right people", "outbound", "newsletter"],
    ]);
    expect(thread.items[0]).toMatchObject({ source: "transactional", channel: "email", kind: "message", to: [SUB], from: "Kevin from distribute.you <kevin@distribute.you>" });
    // The other brand of the org also gets the org's letters, plus its own.
    expect((await transactionalItems({ orgId: ORG, brandId: OTHER_BRAND, emails: [SUB] })).items.map((i) => i.subject)).toEqual([
      "When positive replies to cold email arrive",
      "Signups and meetings start with the right people",
      "Other brand only",
    ]);
    // A scope of an org that sent nothing to them: nothing, as before.
    expect(await transactionalItems({ orgId: "4e754e75-1111-4111-8111-000000000009", brandId: BRAND, emails: [SUB] })).toMatchObject({ status: "not_connected", items: [] });
  });

  it("holds the cursor over a page younger than the settle margin (a late commit is re-read)", async () => {
    pages = { "": { emails: [N1], nextCursor: "c1" }, c1: { emails: [N2], nextCursor: "c2" } };
    const r = await runNewsletterPass(Date.parse(N2.sentAt) + 60_000);
    expect(r).toMatchObject({ stored: 2, cursor: "c1" });
  });

  it("fails the pass loud on a malformed row and stores nothing of its page", async () => {
    pages = { "": { emails: [N1, { ...N2, subject: undefined } as unknown as FeedNewsletter], nextCursor: "c1" } };
    await expect(runNewsletterPass()).rejects.toThrow(/no subject/);
    expect(await db.select().from(newsletterSends)).toEqual([]);
  });
});
