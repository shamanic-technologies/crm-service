/**
 * MEETINGS FROM A CONNECTED GOOGLE CALENDAR — the policy, pure (GOOGLE-CALENDAR-MEETING-FACTS-1021).
 *
 * Owner 2026-10-21 (Jarygo Studios closes on Google Meet, books through his own scheduling link):
 * any client connects his Google Calendar; google-service reads it and serves every event with its
 * attendees and, for a Meet call, the participants Meet saw. This module turns those events into the
 * SAME facts the GoHighLevel appointments state (`meeting_booked`, `meeting_attended`,
 * `meeting_not_held`), so lead-service reads them with no per-source branch.
 *
 *  1. BOOKED = an event one of whose attendees IS a person of the brand. An address is not a person
 *     (people book from another address than the one we wrote to): the same address is a direct link;
 *     any other attendee is judged by Jev against the brand's people (lib/calendar/matching.ts), once,
 *     recorded. No match = no funnel step (the attendee still enters the registry as a contact).
 *     Dated on `bookedAt` (the event's creation at Google), so lead-service's whose-win rule answers
 *     "not caused by our outreach" for a meeting booked before our first email, like any CRM fact.
 *  2. ATTENDED only on a POSITIVE fact: a Meet participant Jev judged to be that lead. A meeting that
 *     passed is no proof; Meet `not_meet` / `pending` / `no_record` / `unavailable` = unknown, no fact.
 *  3. A RESCHEDULE is the same booking: a moved event keeps its id (its one booking fact is re-stated
 *     with the new time), and a booking cancelled and booked again later by the same person is ONE
 *     booking, dated at the first. A cancellation with no new booking = `meeting_not_held` at the
 *     scheduled start (as GoHighLevel's `cancelled` appointment), beside its booking.
 *  4. An attendee who DECLINED the invitation booked nothing.
 */

import type { CandidateFact, FactSubject } from "../people/facts.js";
import { emailKey, normalizeEmail } from "../people/identity.js";

export const CALENDAR_SOURCE = "google_calendar" as const;

/** Below this confidence a Jev answer is recorded but never a match. */
export const CALENDAR_MATCH_MIN_CONFIDENCE = 0.5;

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: string | null;
  organizer: boolean;
  self: boolean;
}

export interface MeetParticipant {
  displayName: string | null;
  kind: string;
  joinedAt: string | null;
  leftAt: string | null;
}

/** google-service's served event (GET /internal/calendar/events), as mirrored. */
export interface CalendarEvent {
  id: string;
  orgId: string;
  calendarEmail: string;
  googleEventId: string;
  status: string;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  bookedAt: string | null;
  updatedAt: string | null;
  organizerEmail: string | null;
  attendees: CalendarAttendee[];
  meet: { status: string; participants: MeetParticipant[]; error: string | null; checkedAt: string | null };
  changedAt: string;
}

/** An address that is a calendar or a room, never a person (Google's own resource / group calendars). */
function isCalendarResource(email: string): boolean {
  return /@(resource\.calendar\.google\.com|group\.calendar\.google\.com|group\.v\.calendar\.google\.com)$/.test(email);
}

/**
 * One event per Google event id: the same meeting read from two connected calendars of the org (the
 * organizer's and an invited teammate's) is ONE meeting. The latest served version wins.
 */
export function latestPerGoogleEvent(events: CalendarEvent[]): CalendarEvent[] {
  const best = new Map<string, CalendarEvent>();
  for (const e of events) {
    const cur = best.get(e.googleEventId);
    if (!cur || e.changedAt > cur.changedAt || (e.changedAt === cur.changedAt && e.id > cur.id)) best.set(e.googleEventId, e);
  }
  return [...best.values()].sort((a, b) => (a.googleEventId < b.googleEventId ? -1 : 1));
}

/**
 * The people an event is WITH: every attendee but the calendar's owner, a room, the brand's own team
 * (`ownAddresses`: the org's members) and whoever declined. Normalized addresses, deduplicated.
 */
export function externalAttendees(event: CalendarEvent, ownAddresses: ReadonlySet<string>): { email: string; displayName: string | null }[] {
  const owner = normalizeEmail(event.calendarEmail);
  const out = new Map<string, { email: string; displayName: string | null }>();
  for (const a of event.attendees) {
    const email = normalizeEmail(a.email);
    if (!email || a.self || email === owner || isCalendarResource(email) || ownAddresses.has(email)) continue;
    if (a.responseStatus === "declined") continue;
    if (!out.has(email)) out.set(email, { email, displayName: a.displayName?.trim() || null });
  }
  return [...out.values()];
}

/** A person of the brand, as the matcher and the facts know them. */
export interface CalendarPerson {
  personId: string;
  displayName: string | null;
  company: string | null;
  emails: string[];
  identityKeys: string[];
}

/** Who an attendee is: the same address (direct), or Jev's recorded answer. */
export interface AttendeeIdentity {
  person: CalendarPerson;
  basis: "same_address" | "jev";
  confidence: number | null;
}

/** Which Meet participant Jev judged to be the lead (null = none of them). */
export interface AttendanceAnswer {
  participantIndex: number | null;
  confidence: number;
}

export interface MeetingFactContext {
  /** The person an attendee address is, or null (no match / not judged yet). */
  identityOf(email: string): AttendeeIdentity | null;
  /** Jev's recorded answer for (event, person), when the event has a Meet record. */
  attendanceOf(googleEventId: string, personId: string): AttendanceAnswer | null;
  /** crm-service's contact row of the attendee (the registry entry), null when none yet. */
  contactIdOf(email: string): string | null;
  /** The org's own team (never a lead). */
  ownAddresses: ReadonlySet<string>;
}

const ms = (v: string | null): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** The subject of a calendar fact: the person the attendee IS (their keys), named by the attendee address too. */
function subjectOf(email: string, identity: AttendeeIdentity, fullName: string | null): FactSubject {
  const keys = identity.basis === "same_address" ? [emailKey(email)] : identity.person.identityKeys;
  return { presence: null, keys, standalone: false, emails: [], phones: [], fullName: identity.person.displayName ?? fullName };
}

interface Booking {
  event: CalendarEvent;
  email: string;
  displayName: string | null;
  identity: AttendeeIdentity;
}

/**
 * Every meeting fact the brand's connected calendars state, keyed on Google's event id and the
 * attendee address (one booking per attendee per meeting, whatever happens to it).
 */
export function meetingCandidateFacts(events: CalendarEvent[], ctx: MeetingFactContext): CandidateFact[] {
  const bookings: Booking[] = [];
  for (const event of latestPerGoogleEvent(events)) {
    for (const a of externalAttendees(event, ctx.ownAddresses)) {
      const identity = ctx.identityOf(a.email);
      if (!identity) continue;
      bookings.push({ event, email: a.email, displayName: a.displayName, identity });
    }
  }

  // Rule 3: a booking cancelled and booked again later by the same person is ONE booking.
  const byPerson = new Map<string, Booking[]>();
  for (const b of bookings) byPerson.set(b.identity.person.personId, [...(byPerson.get(b.identity.person.personId) ?? []), b]);
  const replaced = new Set<Booking>();
  const rescheduledFrom = new Map<Booking, Booking[]>();
  for (const list of byPerson.values()) {
    const sorted = [...list].sort((x, y) => (ms(x.event.bookedAt) ?? 0) - (ms(y.event.bookedAt) ?? 0) || (x.event.googleEventId < y.event.googleEventId ? -1 : 1));
    for (const b of sorted) {
      if (b.event.status !== "cancelled") continue;
      const bookedAt = ms(b.event.bookedAt);
      const next = sorted.find(
        (o) => o !== b && o.event.status !== "cancelled" && bookedAt !== null && (ms(o.event.bookedAt) ?? -1) >= bookedAt,
      );
      if (!next) continue;
      replaced.add(b);
      rescheduledFrom.set(next, [...(rescheduledFrom.get(next) ?? []), b]);
    }
  }

  const out: CandidateFact[] = [];
  for (const b of bookings) {
    if (replaced.has(b)) continue;
    const { event, email, identity } = b;
    const base = {
      family: "calendar_meeting" as const,
      source: CALENDAR_SOURCE,
      sourceRef: event.googleEventId,
      sourceContactId: email,
      crmContactId: ctx.contactIdOf(email),
      subject: subjectOf(email, identity, b.displayName),
    };
    const earlier = (rescheduledFrom.get(b) ?? []).flatMap((r) => [r, ...(rescheduledFrom.get(r) ?? [])]);
    const firstBookedAt = [event.bookedAt, ...earlier.map((r) => r.event.bookedAt)]
      .filter((v): v is string => !!v)
      .sort((x, y) => (ms(x) ?? 0) - (ms(y) ?? 0))[0] ?? null;
    out.push({
      ...base,
      naturalKey: `google_calendar|${event.googleEventId}|${email}|booked`,
      type: "meeting_booked",
      occurredAt: firstBookedAt ? new Date(firstBookedAt).toISOString() : null,
      dateBasis: "booked_at",
      payload: {
        via: "calendar_event",
        title: event.title,
        startsAt: event.startAt,
        endsAt: event.endAt,
        attendeeEmail: email,
        matchBasis: identity.basis,
        rescheduledFrom: earlier.map((r) => r.event.googleEventId).sort(),
      },
    });

    if (event.status === "cancelled") {
      out.push({
        ...base,
        naturalKey: `google_calendar|${event.googleEventId}|${email}|outcome`,
        type: "meeting_not_held",
        occurredAt: event.startAt ? new Date(event.startAt).toISOString() : null,
        dateBasis: "scheduled_start",
        payload: { via: "calendar_event", reason: "cancelled", title: event.title, startsAt: event.startAt, attendeeEmail: email },
      });
      continue;
    }

    // Rule 2: attended only when a Meet participant was judged to be this lead.
    if (event.meet.status !== "record_found" || event.meet.participants.length === 0) continue;
    const answer = ctx.attendanceOf(event.googleEventId, identity.person.personId);
    if (!answer || answer.participantIndex === null || answer.confidence < CALENDAR_MATCH_MIN_CONFIDENCE) continue;
    const participant = event.meet.participants[answer.participantIndex];
    if (!participant) continue;
    out.push({
      ...base,
      naturalKey: `google_calendar|${event.googleEventId}|${email}|outcome`,
      type: "meeting_attended",
      occurredAt: participant.joinedAt
        ? new Date(participant.joinedAt).toISOString()
        : event.startAt
          ? new Date(event.startAt).toISOString()
          : null,
      dateBasis: participant.joinedAt ? "joined_at" : "scheduled_start",
      payload: {
        via: "meet_participants",
        title: event.title,
        startsAt: event.startAt,
        attendeeEmail: email,
        participantName: participant.displayName,
        leftAt: participant.leftAt,
      },
    });
  }
  return out;
}
