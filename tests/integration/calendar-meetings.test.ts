import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { calendarAttendeeMatches, people, peopleFacts, peopleScopes, type PeopleScope } from "../../src/db/schema.js";
import { storeFeedPage } from "../../src/lib/calendar/feed.js";
import { judgeScopeMeetings } from "../../src/lib/calendar/matching.js";
import type { CalendarEvent } from "../../src/lib/calendar/meetings.js";
import { emitScopeFacts } from "../../src/lib/people/facts.js";
import { listLegReachBrands } from "../../src/lib/people/leg-reach.js";

/**
 * GOOGLE-CALENDAR-MEETING-FACTS-1021 against a real Postgres (gated on CRM_TEST_DB): the feed page is
 * stored, attendees are judged (Jev stubbed), and the people fact feed states the meetings.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "ca1e0da0-1111-4111-8111-000000000001";
const BRAND = "ca1e0da0-1111-4111-8111-000000000002";
const USER = "ca1e0da0-1111-4111-8111-000000000003";
const JOHN = "ca1e0da0-1111-4111-8111-0000000000a1";
const MARY = "ca1e0da0-1111-4111-8111-0000000000a2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const jevCalls: { questions: Record<string, { criteria: Record<string, string> }>; state: unknown }[] = [];

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) return json({ id: "run-cal" });
    if (url.pathname === "/orgs/judgments") {
      const body = JSON.parse(String(init?.body));
      jevCalls.push(body);
      const [key] = Object.keys(body.questions);
      const criteria = body.questions[key].criteria as Record<string, string>;
      // The stub "recognises" John Smith among the options (a candidate or a Meet participant).
      const pick = Object.entries(criteria).find(([k, v]) => k !== "none" && /john|johnny/i.test(v))?.[0] ?? "none";
      return json({ model: "jev-test", answers: { [key]: { type: "choice", choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9 } } } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function event(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "ca1e0da0-1111-4111-8111-0000000000e1",
    orgId: ORG,
    calendarEmail: "owner@jarygo.test",
    googleEventId: "g-1",
    status: "confirmed",
    title: "Call with John Smith",
    startAt: "2026-10-25T10:00:00.000Z",
    endAt: "2026-10-25T10:30:00.000Z",
    bookedAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
    organizerEmail: "owner@jarygo.test",
    attendees: [{ email: "owner@jarygo.test", displayName: "Owner", responseStatus: "accepted", organizer: true, self: true }],
    meet: { status: "pending", participants: [], error: null, checkedAt: null },
    changedAt: "2026-10-20T08:00:00.000Z",
    ...over,
  };
}

const attendee = (email: string, displayName: string | null) => ({ email, displayName, responseStatus: "accepted", organizer: false, self: false });

describe.skipIf(!RUN)("calendar meetings -> people facts", () => {
  let scope: PeopleScope;

  beforeAll(async () => {
    stubFetch();
    [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();
    const person = (personId: string, name: string, email: string) => ({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personId,
      personKey: `email:${email}`,
      identityKeys: [`email:${email}`],
      displayName: name,
      emails: [email],
      phones: [],
      sources: ["instantly"],
      presences: [{ source: "instantly", sourceRef: email, displayName: name, company: null, emails: [email], phones: [], firstActivityAt: null, lastActivityAt: null, messageCount: null, inboundCount: null, outboundCount: null, detail: {} }],
      mergeEvidence: [],
      state: "contacted",
      stateSource: "test",
    });
    await db.insert(people).values([person(JOHN, "John Smith", "john@acme.test"), person(MARY, "Mary Jones", "mary@beta.test")]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.execute(sql`DELETE FROM people_facts WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM calendar_attendee_matches WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM calendar_attendance_verdicts WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM calendar_events WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM calendar_feed_cursors`);
    await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM people WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM people_scopes WHERE org_id = ${ORG}`);
  });

  const liveFacts = async () =>
    (await db.select().from(peopleFacts).where(and(eq(peopleFacts.orgId, ORG), eq(peopleFacts.live, true)))).filter((f) => f.source === "google_calendar");

  it("states booked (same address + Jev-matched other address), attended from Meet, nothing for a stranger", async () => {
    await storeFeedPage({
      hasMore: false,
      nextCursor: "c1",
      events: [
        // Mary books with the address we know.
        event({ id: "ca1e0da0-1111-4111-8111-0000000000e1", googleEventId: "g-mary", title: "Intro", attendees: [attendee("mary@beta.test", "Mary Jones")] }),
        // John books from his personal address, and joins the Meet call.
        event({
          id: "ca1e0da0-1111-4111-8111-0000000000e2",
          googleEventId: "g-john",
          attendees: [attendee("jsmith.home@gmail.test", "J. Smith")],
          meet: {
            status: "record_found",
            participants: [
              { displayName: "Owner", kind: "signed_in", joinedAt: "2026-10-25T09:59:00.000Z", leftAt: null },
              { displayName: "Johnny", kind: "anonymous", joinedAt: "2026-10-25T10:03:00.000Z", leftAt: null },
            ],
            error: null,
            checkedAt: "2026-10-25T12:00:00.000Z",
          },
        }),
        // Someone the brand does not know.
        event({ id: "ca1e0da0-1111-4111-8111-0000000000e3", googleEventId: "g-zed", title: "Dentist", attendees: [attendee("zed@other.test", "Zed Q")] }),
      ],
    });

    const summary = await judgeScopeMeetings(scope, { orgId: ORG, userId: USER, runId: "run-cal", brandIds: [BRAND] }, new Set(), "Jarygo Studios");
    expect(summary).toMatchObject({ attendees: 3, contactsAdded: 3, sameAddress: 1, attendeeJudged: 1, attendeeNoCandidate: 1, attendanceJudged: 1 });

    // Judged once: a second pass asks nothing.
    const calls = jevCalls.length;
    const again = await judgeScopeMeetings(scope, { orgId: ORG, userId: USER, runId: "run-cal", brandIds: [BRAND] }, new Set(), "Jarygo Studios");
    expect(again.changed).toBe(false);
    expect(jevCalls.length).toBe(calls);

    await emitScopeFacts(scope);
    const facts = await liveFacts();
    const by = (type: string, email: string) => facts.find((f) => f.type === type && (f.payload as { attendeeEmail?: string }).attendeeEmail === email);
    expect(by("meeting_booked", "mary@beta.test")).toMatchObject({ personKey: "email:mary@beta.test", dateBasis: "booked_at" });
    expect(by("meeting_booked", "jsmith.home@gmail.test")).toMatchObject({ personKey: "email:john@acme.test" });
    expect(by("meeting_attended", "jsmith.home@gmail.test")).toMatchObject({ personKey: "email:john@acme.test", dateBasis: "joined_at" });
    expect(by("meeting_attended", "mary@beta.test")).toBeUndefined();
    expect(facts.some((f) => (f.payload as { attendeeEmail?: string }).attendeeEmail === "zed@other.test")).toBe(false);
    // Every attendee entered the registry; facts name its row.
    expect(by("meeting_booked", "mary@beta.test")!.crmContactId).toBeTruthy();
    const zed = await db.select().from(calendarAttendeeMatches).where(eq(calendarAttendeeMatches.attendeeEmail, "zed@other.test"));
    expect(zed[0]).toMatchObject({ personId: null, basis: "no_candidate" });

    // A connected calendar records the meeting steps for the brand's own-team legs (features-service).
    const mine = (await listLegReachBrands()).find((b) => b.brandId === BRAND)!;
    expect(mine.recordedSteps).toEqual(expect.arrayContaining(["meeting_booked", "meeting_attended"]));
  });

  it("a reschedule re-states the one booking; a cancellation adds not-held", async () => {
    await storeFeedPage({
      hasMore: false,
      nextCursor: "c2",
      events: [
        event({ id: "ca1e0da0-1111-4111-8111-0000000000e1", googleEventId: "g-mary", title: "Intro", startAt: "2026-10-26T10:00:00.000Z", changedAt: "2026-10-21T08:00:00.000Z", attendees: [attendee("mary@beta.test", "Mary Jones")] }),
      ],
    });
    await emitScopeFacts(scope);
    let mary = (await liveFacts()).filter((f) => (f.payload as { attendeeEmail?: string }).attendeeEmail === "mary@beta.test");
    expect(mary.map((f) => f.type)).toEqual(["meeting_booked"]);
    expect((mary[0].payload as { startsAt: string }).startsAt).toBe("2026-10-26T10:00:00.000Z");

    await storeFeedPage({
      hasMore: false,
      nextCursor: "c3",
      events: [
        event({ id: "ca1e0da0-1111-4111-8111-0000000000e1", googleEventId: "g-mary", status: "cancelled", title: "Intro", startAt: "2026-10-26T10:00:00.000Z", changedAt: "2026-10-22T08:00:00.000Z", attendees: [attendee("mary@beta.test", "Mary Jones")] }),
      ],
    });
    await emitScopeFacts(scope);
    mary = (await liveFacts()).filter((f) => (f.payload as { attendeeEmail?: string }).attendeeEmail === "mary@beta.test");
    expect(mary.map((f) => f.type).sort()).toEqual(["meeting_booked", "meeting_not_held"]);
  });
});
