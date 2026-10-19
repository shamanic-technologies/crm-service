import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { peopleFacts } from "../../src/db/schema.js";
import { attachFactIds } from "../../src/lib/people/fact-ids.js";
import type { TimelineItem } from "../../src/lib/people/timeline.js";

/** UNIBOX-FACT-ID-1019: a timeline message states the id of the LIVE fact it is. */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "fac71d00-1111-4111-8111-000000000001";
const BRAND = "fac71d00-1111-4111-8111-000000000002";
const OTHER_BRAND = "fac71d00-1111-4111-8111-000000000003";
const LIVE = "fac71d00-1111-4111-8111-0000000000a1";
const OLD = "fac71d00-1111-4111-8111-0000000000a2";
const GMAIL = "fac71d00-1111-4111-8111-0000000000a3";
const ELSEWHERE = "fac71d00-1111-4111-8111-0000000000a4";

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  at: "2026-10-15T18:01:55.000Z", source: "matrix", channel: "whatsapp", kind: "message", direction: "outbound",
  subject: null, text: "hi", from: "@crm_x:hs", to: [], ref: {}, textClean: null, outreachFact: null, event: null, ...over,
});

const fact = (factId: string, brandId: string, naturalKey: string, live: boolean) => ({
  factId, orgId: ORG, brandId, personKey: "email:a@x.com", emails: ["a@x.com"], phones: [], type: "message_out",
  dateBasis: "sent_at", source: naturalKey.split("|")[0], sourceRef: naturalKey.split("|").at(-1)!, payload: {},
  naturalKey, family: "m", contentHash: "h", live,
});

describe.skipIf(!RUN)("attachFactIds", () => {
  const wipe = () => db.execute(sql`DELETE FROM people_facts WHERE org_id = ${ORG}`);
  beforeAll(async () => {
    await wipe();
    await db.insert(peopleFacts).values([
      fact(OLD, BRAND, "matrix|$sent", false), // re-stated: the old copy
      fact(LIVE, BRAND, "matrix|$sent", true),
      fact(GMAIL, BRAND, "gmail|a@x.com|m1", true),
      fact(ELSEWHERE, OTHER_BRAND, "matrix|$other", true),
    ]);
  });
  afterAll(wipe);

  it("serves the live fact id on its message, nothing on what is no fact of this brand", async () => {
    const items = [
      item({ ref: { eventId: "$sent", roomId: "!r" } }),
      item({ source: "gmail", channel: "email", from: "me@brand.com", to: ["a@x.com"], ref: { gmailMessageId: "m1" } }),
      item({ ref: { eventId: "$other" } }), // another brand's fact
      item({ ref: { eventId: "$unknown" } }), // no fact emitted
      item({ kind: "event", direction: null, source: "posthog", channel: "web", ref: { externalId: "v" } }),
    ];
    await attachFactIds(ORG, BRAND, ["a@x.com"], items);
    expect(items.map((i) => i.ref.factId ?? null)).toEqual([LIVE, GMAIL, null, null, null]);
    expect(items[0].ref).toEqual({ eventId: "$sent", roomId: "!r", factId: LIVE });
  });
});
