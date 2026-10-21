/**
 * WHO A CALENDAR ATTENDEE IS, AND WHETHER THEY JOINED THE CALL (GOOGLE-CALENDAR-MEETING-FACTS-1021).
 *
 * Owner 2026-10-21: an address is not a person. People book from another address than the one we
 * wrote to, and Meet names participants by display name only (never an email). So both matches are
 * JUDGMENTS, by Jev (chat-service `POST /orgs/judgments`, org-billed against our run), recorded once:
 *
 *  - attendee -> person: an attendee whose address no person of the brand holds is asked against the
 *    brand's people who share a name word (with the attendee's name, address or the meeting title,
 *    "Call with John Smith") or an organization domain. A `choice` among them + `none`; below 0.5 or
 *    `none` = nobody. Recorded in `calendar_attendee_matches` keyed on (brand, address, what was
 *    asked): asked again only when the question changes (new candidates, new titles). No candidate
 *    = nobody, recorded without a call. Picking WHO to ask about is retrieval, never the answer.
 *  - Meet participant -> lead: for a Meet record of a meeting with a matched person, a `choice` among
 *    the participants + `none` (`calendar_attendance_verdicts`).
 *
 * Every external attendee also enters the brand's registry as a contact (`contacts`, source
 * `google_calendar`, keyed on the address), matched or not; the org's own team never does.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  calendarAttendanceVerdicts,
  calendarAttendeeMatches,
  calendarEvents,
  contacts,
  domainVerdicts,
  people,
  personIdAliases,
  type PeopleScope,
} from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import {
  CALENDAR_MATCH_MIN_CONFIDENCE,
  CALENDAR_SOURCE,
  externalAttendees,
  latestPerGoogleEvent,
  type AttendanceAnswer,
  type AttendeeIdentity,
  type CalendarEvent,
  type CalendarPerson,
  type MeetingFactContext,
} from "./meetings.js";

/** How many of the brand's people one attendee question offers at most. */
export const MAX_ATTENDEE_CANDIDATES = 12;

// Words of a meeting title / a name that say nothing about WHO (they would make everyone a candidate).
const STOP_WORDS = new Set([
  "call", "meeting", "meet", "with", "and", "the", "for", "between", "intro", "introduction", "demo", "discovery",
  "chat", "sync", "catch", "up", "zoom", "google", "teams", "invitation", "invite", "updated", "event", "session",
  "consultation", "consult", "strategy", "onboarding", "follow", "followup", "via", "from", "your", "you", "our",
  "minute", "minutes", "min", "mins", "hour", "appel", "rdv", "rendez", "vous", "avec", "info", "contact", "hello",
  "team", "sales", "admin", "office", "booking", "scheduled", "neocal", "calendly",
]);

/** PURE: the name words of a free text (accents folded, 3+ letters, no stop word). */
export function nameTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const folded = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return [...new Set(folded.split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)))];
}

const domainOf = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : null;
};

/**
 * PURE: the brand's people worth asking about for one attendee: sharing a name word with the
 * attendee's name, address or one of their meeting titles, or an ORGANIZATION domain (a mailbox
 * provider's domain is nobody's). Most shared words first, capped.
 */
export function attendeeCandidates(
  attendee: { email: string; displayName: string | null },
  titles: string[],
  pool: CalendarPerson[],
  organizationDomains: ReadonlySet<string>,
): CalendarPerson[] {
  const words = new Set([
    ...nameTokens(attendee.displayName),
    ...nameTokens(attendee.email.split("@")[0]),
    ...titles.flatMap((t) => nameTokens(t)),
  ]);
  const domain = domainOf(attendee.email);
  const orgDomain = domain && organizationDomains.has(domain) ? domain : null;
  const scored: { person: CalendarPerson; score: number }[] = [];
  for (const p of pool) {
    const theirs = new Set([...nameTokens(p.displayName), ...p.emails.flatMap((e) => nameTokens(e.split("@")[0]))]);
    let score = 0;
    for (const w of theirs) if (words.has(w)) score++;
    if (orgDomain && p.emails.some((e) => domainOf(e) === orgDomain)) score += 2;
    if (score > 0) scored.push({ person: p, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.person.personId < b.person.personId ? -1 : 1))
    .slice(0, MAX_ATTENDEE_CANDIDATES)
    .map((s) => s.person);
}

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** PURE: the attendee question (state + the one choice), and the hash that keys its recorded answer. */
export function attendeeQuestion(
  attendee: { email: string; displayName: string | null },
  titles: string[],
  candidates: CalendarPerson[],
  brandName: string | null,
): { state: unknown; question: ChoiceQuestion; hash: string } {
  const criteria: Record<string, string> = {};
  candidates.forEach((c, i) => {
    criteria[`p${i}`] =
      `${c.displayName ?? "(no name)"}${c.company ? `, ${c.company}` : ""}; addresses: ${c.emails.join(", ") || "(none)"}`;
  });
  criteria.none = "none of these people: the attendee is someone else";
  const state = {
    business: brandName,
    meetingTitles: [...titles].sort(),
    attendee: { address: attendee.email, name: attendee.displayName },
  };
  return {
    state,
    question: {
      type: "choice",
      instructions:
        "A meeting with the attendee below was booked in the business's calendar. Is this attendee the SAME HUMAN as one " +
        "of the business's known contacts listed as options? People often book from another address than the one the " +
        "business knows (a personal vs a work address), so judge on the person: their name, the name in the meeting " +
        "title (\"Call with John Smith\"), their company or domain. A shared first name alone, or a shared company " +
        "alone, is not the same human. Answer none unless one option is clearly this attendee.",
      criteria,
    },
    hash: sha({ v: 1, attendee, titles: state.meetingTitles, candidates: candidates.map((c) => [c.personId, c.displayName, c.emails]) }),
  };
}

/** PURE: the Meet attendance question for one (meeting, lead). */
export function attendanceQuestion(
  event: CalendarEvent,
  person: CalendarPerson,
  attendee: { email: string; displayName: string | null },
): { state: unknown; question: ChoiceQuestion; hash: string } {
  const criteria: Record<string, string> = {};
  event.meet.participants.forEach((p, i) => {
    criteria[`m${i}`] = `${p.displayName ?? "(no name shown)"} (${p.kind})`;
  });
  criteria.none = "none of these participants is the person";
  const state = {
    meeting: { title: event.title, startsAt: event.startAt, calendarOwner: event.calendarEmail, organizer: event.organizerEmail },
    person: { name: person.displayName, addresses: person.emails, invitedAs: attendee },
  };
  return {
    state,
    question: {
      type: "choice",
      instructions:
        "Google Meet lists who joined the video call of this meeting, by display name only. Which participant, if any, " +
        "is the person described (the business's contact invited to the meeting)? The calendar owner and their " +
        "teammates also appear among participants: they are not the person. Answer none unless one participant is " +
        "clearly the person.",
      criteria,
    },
    hash: sha({ v: 1, participants: event.meet.participants.map((p) => [p.displayName, p.kind]), person: [person.personId, person.displayName, person.emails], attendee }),
  };
}

// ─── reads ──────────────────────────────────────────────────────────────────

/** Every mirrored event of the org (bronze), as served. */
export async function readOrgEvents(orgId: string): Promise<CalendarEvent[]> {
  const found = await db.select({ payload: calendarEvents.payload }).from(calendarEvents).where(eq(calendarEvents.orgId, orgId));
  return found.map((r) => r.payload as CalendarEvent);
}

/** The scope's people, as the matcher knows them (automated senders are nobody's lead). */
export async function readScopePeople(scope: Pick<PeopleScope, "id">): Promise<CalendarPerson[]> {
  const found = await db
    .select({
      personId: people.personId,
      displayName: people.displayName,
      company: people.company,
      emails: people.emails,
      identityKeys: people.identityKeys,
      automated: people.automated,
    })
    .from(people)
    .where(eq(people.scopeId, scope.id));
  return found
    .filter((r) => r.personId && !r.automated)
    .map((r) => ({
      personId: r.personId!,
      displayName: r.displayName,
      company: r.company,
      emails: r.emails as string[],
      identityKeys: r.identityKeys as string[],
    }));
}

/**
 * The fact context of a scope: who each attendee is (same address, else the latest recorded Jev
 * answer, its person followed through id aliases), who joined each Meet call, the attendee's
 * registry row. `ownAddresses` = attendees that never got a registry row (the org's team) are
 * nobody's lead: an attendee with no contact row states no fact.
 */
export async function meetingFactContext(
  orgId: string,
  brandId: string,
  peopleRows: CalendarPerson[],
): Promise<MeetingFactContext & { registered: ReadonlySet<string> }> {
  const byEmail = new Map<string, CalendarPerson>();
  const byId = new Map<string, CalendarPerson>();
  for (const p of peopleRows) {
    byId.set(p.personId, p);
    for (const k of p.identityKeys) if (k.startsWith("email:")) byEmail.set(k.slice(6), p);
  }
  const aliases = new Map(
    (
      await db
        .select({ retiredId: personIdAliases.retiredId, personId: personIdAliases.personId })
        .from(personIdAliases)
        .where(and(eq(personIdAliases.orgId, orgId), eq(personIdAliases.brandId, brandId)))
    ).map((a) => [a.retiredId, a.personId]),
  );
  const current = (id: string): CalendarPerson | null => {
    let cur = id;
    for (let i = 0; i < 10 && !byId.has(cur) && aliases.has(cur); i++) cur = aliases.get(cur)!;
    return byId.get(cur) ?? null;
  };

  const matches = (await db.execute(sql`
    SELECT DISTINCT ON (attendee_email) attendee_email, person_id, confidence
    FROM calendar_attendee_matches
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
    ORDER BY attendee_email, judged_at DESC, id DESC
  `)) as unknown as { attendee_email: string; person_id: string | null; confidence: number | null }[];
  const judged = new Map(matches.map((m) => [m.attendee_email, m]));

  const verdicts = (await db.execute(sql`
    SELECT DISTINCT ON (google_event_id, person_id) google_event_id, person_id, participant_index, confidence
    FROM calendar_attendance_verdicts
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
    ORDER BY google_event_id, person_id, judged_at DESC, id DESC
  `)) as unknown as { google_event_id: string; person_id: string; participant_index: number | null; confidence: number }[];
  const attendance = new Map<string, AttendanceAnswer>();
  for (const v of verdicts) {
    const person = current(v.person_id);
    if (person) attendance.set(`${v.google_event_id}|${person.personId}`, { participantIndex: v.participant_index, confidence: Number(v.confidence) });
  }

  const rowsFound = await db
    .select({ id: contacts.id, externalId: contacts.externalId })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.brandId, brandId), eq(contacts.source, CALENDAR_SOURCE)));
  const contactOf = new Map(rowsFound.filter((r) => r.externalId).map((r) => [r.externalId!, r.id]));

  return {
    registered: new Set(contactOf.keys()),
    ownAddresses: new Set<string>(),
    contactIdOf: (email) => contactOf.get(email) ?? null,
    identityOf: (email): AttendeeIdentity | null => {
      // An attendee the registry never took in (the org's own team) is nobody's lead.
      if (!contactOf.has(email)) return null;
      const direct = byEmail.get(email);
      if (direct) return { person: direct, basis: "same_address", confidence: null };
      const m = judged.get(email);
      if (!m?.person_id || m.confidence === null || Number(m.confidence) < CALENDAR_MATCH_MIN_CONFIDENCE) return null;
      const person = current(m.person_id);
      return person ? { person, basis: "jev", confidence: Number(m.confidence) } : null;
    },
    attendanceOf: (googleEventId, personId) => attendance.get(`${googleEventId}|${personId}`) ?? null,
  };
}

// ─── the judge pass ─────────────────────────────────────────────────────────

export interface ScopeJudgeSummary {
  scopeId: string;
  events: number;
  attendees: number;
  contactsAdded: number;
  sameAddress: number;
  attendeeJudged: number;
  attendeeNoCandidate: number;
  attendanceJudged: number;
  /** Something new was recorded: the facts may have moved. */
  changed: boolean;
}

/** Organization domains (never a mailbox provider's) among these, from the fleet-wide verdicts. */
async function organizationDomains(domains: string[]): Promise<Set<string>> {
  if (domains.length === 0) return new Set();
  const found = await db
    .select({ domain: domainVerdicts.domain, kind: domainVerdicts.kind, confidence: domainVerdicts.confidence })
    .from(domainVerdicts)
    .where(inArray(domainVerdicts.domain, domains));
  return new Set(found.filter((d) => d.kind === "organization" && d.confidence >= 0.5).map((d) => d.domain));
}

/**
 * One scope: register every external attendee as a contact, judge the attendees no person holds
 * by address (Jev, once per question), judge Meet attendance of the matched people. Fails loud on
 * a Jev failure (the next pass asks again; nothing half-recorded).
 */
export async function judgeScopeMeetings(
  scope: PeopleScope,
  tracking: ChatTrackingHeaders,
  ownAddresses: ReadonlySet<string>,
  brandName: string | null,
): Promise<ScopeJudgeSummary> {
  const events = latestPerGoogleEvent(await readOrgEvents(scope.orgId));
  const pool = await readScopePeople(scope);
  const summary: ScopeJudgeSummary = {
    scopeId: scope.id,
    events: events.length,
    attendees: 0,
    contactsAdded: 0,
    sameAddress: 0,
    attendeeJudged: 0,
    attendeeNoCandidate: 0,
    attendanceJudged: 0,
    changed: false,
  };

  // Who the meetings are with: per address, its names, its meetings' titles, its first booking.
  const attendees = new Map<string, { email: string; displayName: string | null; titles: Set<string>; firstBookedAt: string | null }>();
  for (const e of events) {
    for (const a of externalAttendees(e, ownAddresses)) {
      const cur = attendees.get(a.email) ?? { email: a.email, displayName: null, titles: new Set<string>(), firstBookedAt: null };
      cur.displayName = cur.displayName ?? a.displayName;
      if (e.title) cur.titles.add(e.title);
      if (e.bookedAt && (!cur.firstBookedAt || e.bookedAt < cur.firstBookedAt)) cur.firstBookedAt = e.bookedAt;
      attendees.set(a.email, cur);
    }
  }
  summary.attendees = attendees.size;
  if (attendees.size === 0) return summary;

  // Every attendee enters the registry (matched or not), once per address.
  const values = [...attendees.values()].map((a) => ({
    orgId: scope.orgId,
    brandId: scope.brandId,
    source: CALENDAR_SOURCE,
    externalId: a.email,
    primaryEmail: a.email,
    fullName: a.displayName,
    rawAttributes: {},
    sourceCreatedAt: a.firstBookedAt ? new Date(a.firstBookedAt) : null,
  }));
  for (let i = 0; i < values.length; i += 500) {
    const inserted = await db
      .insert(contacts)
      .values(values.slice(i, i + 500))
      .onConflictDoNothing({ target: [contacts.orgId, contacts.brandId, contacts.source, contacts.externalId] })
      .returning({ id: contacts.id });
    summary.contactsAdded += inserted.length;
  }
  if (summary.contactsAdded > 0) summary.changed = true;

  const byEmail = new Map<string, CalendarPerson>();
  for (const p of pool) for (const k of p.identityKeys) if (k.startsWith("email:")) byEmail.set(k.slice(6), p);

  const existing = await db
    .select({ attendeeEmail: calendarAttendeeMatches.attendeeEmail, inputHash: calendarAttendeeMatches.inputHash })
    .from(calendarAttendeeMatches)
    .where(and(eq(calendarAttendeeMatches.orgId, scope.orgId), eq(calendarAttendeeMatches.brandId, scope.brandId)));
  const asked = new Set(existing.map((r) => `${r.attendeeEmail}|${r.inputHash}`));
  const orgDomains = await organizationDomains([...new Set([...attendees.keys()].map((e) => domainOf(e)!).filter(Boolean))]);

  for (const a of attendees.values()) {
    if (byEmail.has(a.email)) {
      summary.sameAddress++;
      continue;
    }
    const titles = [...a.titles];
    const candidates = attendeeCandidates(a, titles, pool, orgDomains);
    const q = attendeeQuestion(a, titles, candidates, brandName);
    if (asked.has(`${a.email}|${q.hash}`)) continue;
    if (candidates.length === 0) {
      await db
        .insert(calendarAttendeeMatches)
        .values({ orgId: scope.orgId, brandId: scope.brandId, attendeeEmail: a.email, inputHash: q.hash, personId: null, basis: "no_candidate", candidates: [] })
        .onConflictDoNothing();
      summary.attendeeNoCandidate++;
      continue;
    }
    const { answers, model } = await judgeChoices(q.state, { attendee: q.question }, tracking);
    const answer = answers.attendee;
    if (!answer || typeof answer.confidence !== "number" || !(answer.choice in q.question.criteria)) {
      throw new Error(`[crm-service][calendar] Jev answered no usable choice for attendee ${a.email}: ${JSON.stringify(answer)}`);
    }
    const picked = answer.choice === "none" ? null : candidates[Number(answer.choice.slice(1))];
    await db
      .insert(calendarAttendeeMatches)
      .values({
        orgId: scope.orgId,
        brandId: scope.brandId,
        attendeeEmail: a.email,
        inputHash: q.hash,
        personId: picked?.personId ?? null,
        basis: "jev",
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        candidates: candidates.map((c) => c.personId),
        model,
        runId: tracking.runId,
      })
      .onConflictDoNothing();
    summary.attendeeJudged++;
    summary.changed = true;
  }

  // Meet attendance of the matched people (only where Meet published who joined).
  const ctx = await meetingFactContext(scope.orgId, scope.brandId, pool);
  const asked2 = new Set(
    (
      await db
        .select({ g: calendarAttendanceVerdicts.googleEventId, p: calendarAttendanceVerdicts.personId, h: calendarAttendanceVerdicts.inputHash })
        .from(calendarAttendanceVerdicts)
        .where(and(eq(calendarAttendanceVerdicts.orgId, scope.orgId), eq(calendarAttendanceVerdicts.brandId, scope.brandId)))
    ).map((r) => `${r.g}|${r.p}|${r.h}`),
  );
  for (const e of events) {
    if (e.status === "cancelled" || e.meet.status !== "record_found" || e.meet.participants.length === 0) continue;
    for (const a of externalAttendees(e, ownAddresses)) {
      const identity = ctx.identityOf(a.email);
      if (!identity) continue;
      const q = attendanceQuestion(e, identity.person, a);
      if (asked2.has(`${e.googleEventId}|${identity.person.personId}|${q.hash}`)) continue;
      const { answers, model } = await judgeChoices(q.state, { attendance: q.question }, tracking);
      const answer = answers.attendance;
      if (!answer || typeof answer.confidence !== "number" || !(answer.choice in q.question.criteria)) {
        throw new Error(`[crm-service][calendar] Jev answered no usable choice for Meet attendance of ${e.googleEventId}: ${JSON.stringify(answer)}`);
      }
      await db
        .insert(calendarAttendanceVerdicts)
        .values({
          orgId: scope.orgId,
          brandId: scope.brandId,
          googleEventId: e.googleEventId,
          personId: identity.person.personId,
          inputHash: q.hash,
          participantIndex: answer.choice === "none" ? null : Number(answer.choice.slice(1)),
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          model,
          runId: tracking.runId,
        })
        .onConflictDoNothing();
      asked2.add(`${e.googleEventId}|${identity.person.personId}|${q.hash}`);
      summary.attendanceJudged++;
      summary.changed = true;
    }
  }
  return summary;
}
