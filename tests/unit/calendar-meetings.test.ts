import { describe, it, expect } from "vitest";
import {
  meetingCandidateFacts,
  type AttendanceAnswer,
  type AttendeeIdentity,
  type CalendarEvent,
  type CalendarPerson,
  type MeetingFactContext,
} from "../../src/lib/calendar/meetings.js";
import { attendeeCandidates, attendeeQuestion, attendanceQuestion, nameTokens } from "../../src/lib/calendar/matching.js";

/**
 * GOOGLE-CALENDAR-MEETING-FACTS-1021: a meeting in a connected Google Calendar becomes the SAME
 * meeting facts a GoHighLevel appointment states, for the brand's person the attendee IS.
 */

const john: CalendarPerson = {
  personId: "p-john",
  displayName: "John Smith",
  company: "Acme",
  emails: ["john@acme.com"],
  identityKeys: ["email:john@acme.com"],
};

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "row-1",
    orgId: "org-1",
    calendarEmail: "owner@jarygo.com",
    googleEventId: "ev-1",
    status: "confirmed",
    title: "Call with John Smith",
    startAt: "2026-10-25T10:00:00.000Z",
    endAt: "2026-10-25T10:30:00.000Z",
    bookedAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
    organizerEmail: "owner@jarygo.com",
    attendees: [
      { email: "owner@jarygo.com", displayName: "Owner", responseStatus: "accepted", organizer: true, self: true },
      { email: "john@acme.com", displayName: "John Smith", responseStatus: "accepted", organizer: false, self: false },
    ],
    meet: { status: "pending", participants: [], error: null, checkedAt: null },
    changedAt: "2026-10-20T08:00:00.000Z",
    ...over,
  };
}

function ctx(opts: {
  identities?: Record<string, AttendeeIdentity>;
  attendance?: Record<string, AttendanceAnswer>;
  own?: string[];
} = {}): MeetingFactContext {
  return {
    identityOf: (email) => opts.identities?.[email] ?? null,
    attendanceOf: (g, p) => opts.attendance?.[`${g}|${p}`] ?? null,
    contactIdOf: (email) => `contact-${email}`,
    ownAddresses: new Set(opts.own ?? []),
  };
}

const same = (email: string): Record<string, AttendeeIdentity> => ({ [email]: { person: john, basis: "same_address", confidence: null } });

describe("meeting booked", () => {
  it("same address: the attendee IS the person, booked on the booking date", () => {
    const facts = meetingCandidateFacts([event()], ctx({ identities: same("john@acme.com") }));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      type: "meeting_booked",
      source: "google_calendar",
      family: "calendar_meeting",
      occurredAt: "2026-10-20T08:00:00.000Z",
      dateBasis: "booked_at",
      sourceRef: "ev-1",
      crmContactId: "contact-john@acme.com",
      naturalKey: "google_calendar|ev-1|john@acme.com|booked",
    });
    // The person is found by the address the attendee booked with.
    expect(facts[0].subject.keys).toEqual(["email:john@acme.com"]);
  });

  it("another address judged by Jev to be the person: the fact is the PERSON's (their keys)", () => {
    const e = event({
      attendees: [{ email: "jsmith.perso@gmail.com", displayName: "J Smith", responseStatus: "accepted", organizer: false, self: false }],
    });
    const facts = meetingCandidateFacts([e], ctx({ identities: { "jsmith.perso@gmail.com": { person: john, basis: "jev", confidence: 0.86 } } }));
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe("meeting_booked");
    expect(facts[0].subject.keys).toEqual(["email:john@acme.com"]);
    expect(facts[0].payload).toMatchObject({ attendeeEmail: "jsmith.perso@gmail.com", matchBasis: "jev" });
  });

  it("no match: no funnel step", () => {
    expect(meetingCandidateFacts([event()], ctx())).toEqual([]);
  });

  it("the calendar owner, the org's own team and a declined attendee are nobody's booking", () => {
    const e = event({
      attendees: [
        { email: "owner@jarygo.com", displayName: null, responseStatus: "accepted", organizer: true, self: true },
        { email: "mate@jarygo.com", displayName: null, responseStatus: "accepted", organizer: false, self: false },
        { email: "john@acme.com", displayName: null, responseStatus: "declined", organizer: false, self: false },
      ],
    });
    const identities = { ...same("john@acme.com"), "mate@jarygo.com": { person: john, basis: "same_address" as const, confidence: null } };
    expect(meetingCandidateFacts([e], ctx({ identities, own: ["mate@jarygo.com"] }))).toEqual([]);
  });

  it("booked before the lead was ours: the fact keeps the booking date (lead-service's whose-win rule reads it)", () => {
    const facts = meetingCandidateFacts([event({ bookedAt: "2026-01-02T09:00:00.000Z" })], ctx({ identities: same("john@acme.com") }));
    expect(facts[0]).toMatchObject({ occurredAt: "2026-01-02T09:00:00.000Z", dateBasis: "booked_at" });
  });
});

describe("reschedule and cancel", () => {
  it("a moved meeting is the same booking (same natural key, new time)", () => {
    const before = meetingCandidateFacts([event()], ctx({ identities: same("john@acme.com") }));
    const after = meetingCandidateFacts(
      [event({ startAt: "2026-10-27T15:00:00.000Z", endAt: "2026-10-27T15:30:00.000Z", changedAt: "2026-10-21T08:00:00.000Z" })],
      ctx({ identities: same("john@acme.com") }),
    );
    expect(after).toHaveLength(1);
    expect(after[0].naturalKey).toBe(before[0].naturalKey);
    expect(after[0].occurredAt).toBe(before[0].occurredAt);
    expect(after[0].payload.startsAt).toBe("2026-10-27T15:00:00.000Z");
  });

  it("the same meeting read from two calendars of the org is one booking (latest version)", () => {
    const facts = meetingCandidateFacts(
      [event(), event({ id: "row-2", calendarEmail: "mate@jarygo.com", changedAt: "2026-10-21T00:00:00.000Z", title: "Renamed" })],
      ctx({ identities: same("john@acme.com") }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].payload.title).toBe("Renamed");
  });

  it("a cancellation: the booking stays and the meeting is not held, at its scheduled start", () => {
    const facts = meetingCandidateFacts([event({ status: "cancelled" })], ctx({ identities: same("john@acme.com") }));
    expect(facts.map((f) => f.type).sort()).toEqual(["meeting_booked", "meeting_not_held"]);
    const notHeld = facts.find((f) => f.type === "meeting_not_held")!;
    expect(notHeld).toMatchObject({ occurredAt: "2026-10-25T10:00:00.000Z", dateBasis: "scheduled_start" });
    expect(notHeld.payload.reason).toBe("cancelled");
  });

  it("cancelled then booked again by the same person: ONE booking, dated at the first", () => {
    const first = event({ status: "cancelled" });
    const second = event({ id: "row-2", googleEventId: "ev-2", bookedAt: "2026-10-22T08:00:00.000Z", startAt: "2026-10-28T10:00:00.000Z" });
    const facts = meetingCandidateFacts([first, second], ctx({ identities: same("john@acme.com") }));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ type: "meeting_booked", sourceRef: "ev-2", occurredAt: "2026-10-20T08:00:00.000Z" });
    expect(facts[0].payload.rescheduledFrom).toEqual(["ev-1"]);
  });
});

describe("meeting attended", () => {
  const ended = (over: Partial<CalendarEvent["meet"]> = {}) =>
    event({
      meet: {
        status: "record_found",
        participants: [
          { displayName: "Owner", kind: "signed_in", joinedAt: "2026-10-25T09:59:00.000Z", leftAt: "2026-10-25T10:31:00.000Z" },
          { displayName: "Johnny S.", kind: "anonymous", joinedAt: "2026-10-25T10:02:00.000Z", leftAt: "2026-10-25T10:30:00.000Z" },
        ],
        error: null,
        checkedAt: "2026-10-25T11:00:00.000Z",
        ...over,
      },
    });

  it("a Meet participant judged to be the lead: attended, when they joined", () => {
    const facts = meetingCandidateFacts(
      [ended()],
      ctx({ identities: same("john@acme.com"), attendance: { "ev-1|p-john": { participantIndex: 1, confidence: 0.9 } } }),
    );
    const attended = facts.find((f) => f.type === "meeting_attended")!;
    expect(attended).toMatchObject({
      occurredAt: "2026-10-25T10:02:00.000Z",
      dateBasis: "joined_at",
      naturalKey: "google_calendar|ev-1|john@acme.com|outcome",
    });
    expect(attended.payload.participantName).toBe("Johnny S.");
  });

  it("none of the participants, or a hesitant answer: no attended fact (never a no-show either)", () => {
    for (const answer of [{ participantIndex: null, confidence: 0.95 }, { participantIndex: 1, confidence: 0.4 }]) {
      const facts = meetingCandidateFacts([ended()], ctx({ identities: same("john@acme.com"), attendance: { "ev-1|p-john": answer } }));
      expect(facts.map((f) => f.type)).toEqual(["meeting_booked"]);
    }
  });

  it("no Meet record (not Meet, pending, no record, unavailable): attendance unknown, no fact, even after the meeting passed", () => {
    for (const status of ["not_meet", "pending", "no_record", "unavailable"]) {
      const facts = meetingCandidateFacts(
        [ended({ status, participants: [] })],
        ctx({ identities: same("john@acme.com"), attendance: { "ev-1|p-john": { participantIndex: 1, confidence: 0.9 } } }),
      );
      expect(facts.map((f) => f.type)).toEqual(["meeting_booked"]);
    }
  });
});

describe("matching (who to ask about, and the question)", () => {
  const mary: CalendarPerson = { personId: "p-mary", displayName: "Mary Jones", company: null, emails: ["mary@beta.io"], identityKeys: ["email:mary@beta.io"] };

  it("name words skip meeting vocabulary and fold accents", () => {
    expect(nameTokens("Call with Jérôme Dupont (30 min)")).toEqual(["jerome", "dupont"]);
  });

  it("candidates share a name word with the attendee, their address or the title, or an organization domain", () => {
    const found = attendeeCandidates({ email: "jsmith.perso@gmail.com", displayName: null }, ["Call with John Smith"], [john, mary], new Set());
    expect(found.map((p) => p.personId)).toEqual(["p-john"]);
    const byDomain = attendeeCandidates({ email: "ceo@beta.io", displayName: null }, [], [john, mary], new Set(["beta.io"]));
    expect(byDomain.map((p) => p.personId)).toEqual(["p-mary"]);
    // A mailbox provider's domain is nobody's.
    expect(attendeeCandidates({ email: "zz@gmail.com", displayName: null }, [], [{ ...mary, emails: ["x@gmail.com"] }], new Set())).toEqual([]);
  });

  it("the attendee question offers each candidate and none; its hash moves when the question does", () => {
    const a = { email: "jsmith.perso@gmail.com", displayName: "J Smith" };
    const q = attendeeQuestion(a, ["Call with John Smith"], [john], "Jarygo Studios");
    expect(Object.keys(q.question.criteria)).toEqual(["p0", "none"]);
    expect(attendeeQuestion(a, ["Call with John Smith"], [john], "Jarygo Studios").hash).toBe(q.hash);
    expect(attendeeQuestion(a, ["Call with John Smith"], [john, mary], "Jarygo Studios").hash).not.toBe(q.hash);
  });

  it("the attendance question offers each Meet participant and none", () => {
    const e = event({
      meet: {
        status: "record_found",
        participants: [{ displayName: "Owner", kind: "signed_in", joinedAt: null, leftAt: null }, { displayName: "John", kind: "anonymous", joinedAt: null, leftAt: null }],
        error: null,
        checkedAt: null,
      },
    });
    expect(Object.keys(attendanceQuestion(e, john, { email: "john@acme.com", displayName: "John Smith" }).question.criteria)).toEqual(["m0", "m1", "none"]);
  });
});
