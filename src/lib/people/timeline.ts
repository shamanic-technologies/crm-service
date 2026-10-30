/**
 * One person's whole exchange, every channel merged into ONE thread, oldest
 * first. Gmail and cold email are served from crm-service's message store
 * (people/search.ts), re-read before the answer when older than a few seconds
 * (bounded wait); every other source is crm-service's own mirror, read in place:
 *
 *  - gmail       google-service per-address conversation read (both directions)
 *  - instantly   instantly-service conversation read, per campaign the address is
 *                a lead on (Instantly Unibox and our own SMTP/IMAP self-send)
 *  - matrix      crm-service's own mirror of the WhatsApp / Telegram / Discord DMs
 *  - gohighlevel crm-service's GoHighLevel funnel evidence (appointments, stage
 *                entries, won/lost, form submissions)
 *  - posthog     crm-service's PostHog mirror: website visits (entry page,
 *                pageviews) and key events, by name
 *  - stripe      crm-service's Stripe mirror: payments, refunds, subscriptions,
 *                with amount (minor unit, verbatim), currency and status
 *  - clerk       crm-service's auth-provider mirror: the signup, nothing else
 *  - copilot     the person's chat with the distribute.you Copilot (a member of
 *                OUR staff, named "AI Copilot"), pushed by chat-service and
 *                stored ONLY under the staff Unibox scope (lib/copilot/messages.ts)
 *  - api         the person's calls to our API (channel `api`) or through our MCP
 *                server (channel `mcp`) with their own key, pushed by api-service,
 *                staff Unibox scope only (lib/api-calls/calls.ts): each call is
 *                what they asked (inbound) and what we answered (outbound)
 *  - transactional every email the platform SENT the person (dunning, receipts, onboarding...),
 *                read off transactional-email-service's sent-emails feed, staff Unibox scope
 *                only (lib/transactional/sent-emails.ts): outbound, subject + body, at send time
 *
 * Every source record that brought the person in also adds ONE entry event,
 * dated by the source (`entryItems`): GoHighLevel `added_to_crm` (contact
 * created), CSV `added_to_crm` (file uploaded), PostHog `signup` (person
 * created), Stripe `stripe_customer_created` (customer created), Clerk `signup` (user
 * created). A record whose source
 * gives no date adds nothing: a date is never invented, never the build time.
 * So a person is never an empty thread while any of their records is dated.
 *
 * Gmail and cold-email items carry `servedFrom: "store"` and `readAt` (the
 * oldest read they come from). A read is a READ-THROUGH (RIGHT-MOMENT-OR-LATER-1014):
 * every stored thread of the person read more than `freshReadWindowMs()` ago is
 * re-read before the answer (Gmail with google-service's fresh mirror), so a writer
 * sees an answer the owner sent by hand seconds ago; a Gmail thread that could not
 * be re-read makes the gmail source `failed` (people/search.ts). The freshness
 * watch (people/freshness.ts) keeps the store warm between reads. Each source answers a status, so "not connected",
 * "connected, nothing with this person" and "could not read it" never collapse
 * into an empty thread.
 */

import { connectionOwnSenders } from "../matrix/own-senders.js";
import { isOwnSender } from "../matrix/events.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { describeKeyEvent } from "../posthog/records.js";
import {
  contacts,
  contactUploads,
  contactRowsRaw,
  conversations,
  creditEvents,
  matrixConnections,
  matrixRawEvents,
  people,
  posthogActivities,
  stripeTransactions,
  type PeopleScope,
  type Person,
} from "../../db/schema.js";
import { majorAmount } from "../stripe/records.js";
import { stripeAttempt, subscriptionAttempt } from "../stripe/attempts.js";
import { readFunnelEvents, type FunnelEvent } from "../gohighlevel/funnel-events.js";
import type { BuildSummary } from "./build.js";
import { PEOPLE_SOURCES, type PeopleSource, type Presence } from "./identity.js";
import { LATE_JOIN_SOURCES, mirrorContactKeys, type LateJoinSource, type MirrorContactRow } from "./record-keys.js";
import type { SiblingIdentity } from "./siblings.js";
import { readStoredTimeline, type StoredReadOptions, type StoredTimeline } from "./search.js";
import { lookupLeadStanding } from "./sources.js";
import {
  COPILOT_CHANNEL,
  COPILOT_SENDER_NAME,
  isCopilotDestination,
  readCopilotThread,
} from "../copilot/messages.js";
import {
  API_SENDER_NAME,
  describeRequest,
  describeResponse,
  readApiCallThread,
  sessionsOf,
} from "../api-calls/calls.js";
import { siblingGetOk } from "./siblings.js";
import { readTxEmailThread, TX_EMAIL_CHANNEL, TX_EMAIL_SENDER_NAME } from "../transactional/sent-emails.js";
import { ACTIVITY_CHANNEL, activityLine, readActivityThread } from "../account-activity/line.js";
import { deferApiAnswer } from "./item-fill.js";
import { ACCOUNT_CHANNEL, creditDateBasis, creditEventText } from "../credit-events/rules.js";
import { readVoiceTranscripts, voiceNoteText } from "../matrix/voice-notes.js";
import { cachedOnboardingRecords, ONBOARDING_CHANNEL, ONBOARDING_STEP, recordText } from "../onboarding/record.js";

export const TIMELINE_SOURCE_STATUSES = ["ok", "empty", "not_connected", "failed"] as const;
export type TimelineSourceStatus = (typeof TIMELINE_SOURCE_STATUSES)[number];

export interface TimelineItem {
  /** ISO time the message was sent / the event happened; null when the source gave none. */
  at: string | null;
  /** `csv` = the entry event of a contact imported from an uploaded file or added by hand. */
  source: PeopleSource;
  /** email | whatsapp | telegram | discord | crm | web | payment */
  channel: string;
  kind: "message" | "event";
  /** inbound = the person wrote; outbound = the brand did; null for an event. */
  direction: "inbound" | "outbound" | "other" | null;
  subject: string | null;
  text: string | null;
  from: string | null;
  to: string[];
  /**
   * The source's own ids for this item (thread, message, campaign, contact...). A message
   * that IS one of our facts (Matrix, Gmail) also carries `factId` = the live fact's id on
   * the people fact feed (UNIBOX-FACT-ID-1019); absent on anything else.
   */
  ref: Record<string, string | null>;
  /**
   * Gmail messages only (null elsewhere): how `text` was derived by google-service,
   * which owns the cleaning. `cleaned` is true only when `text` is the sender's own
   * lines (status `cleaned`); any other status means `text` is NOT the cleaned
   * version (original served, structural clean only, or the snippet) and the reader
   * must be told. `original` is the full original body, verbatim.
   */
  textClean: TextClean | null;
  /**
   * Instantly messages only (null elsewhere): the `email_sent` outreach fact this
   * outbound email IS, as instantly-service states it, verbatim. `subjectKey` is
   * the identity lead-service keeps as that fact's id / source ref, so a reader
   * pairs the email with its fact by identity, never by comparing clocks (the two
   * stamps of one send differ by up to a minute). Null on inbound mail and on a
   * send instantly-service cannot tie to a fact (a manual reply).
   */
  outreachFact: OutreachFact | null;
  /**
   * Events only: the step and its evidence, as the source states it. GoHighLevel
   * carries its funnel-event detail; PostHog `visit` / `event` and Stripe
   * `payment` / `refund` / `subscription_started` / `subscription_canceled`
   * carry their own (page, pageviews; amount, currency, status).
   */
  event: { step: string; dateBasis: string; detail: FunnelEvent["detail"] | Record<string, unknown> } | null;
  /**
   * WHO sent an outbound message (ONBOARDING-FICHE-1027), set on every item the timeline serves, the same words as the
   * latest-message read: `automation` = one of our machines (a transactional email, a cold-email sequence step, an
   * automated WhatsApp send, the Copilot, the API); `person` = a human of the brand typed it (a WhatsApp / Telegram
   * message from the brand's account that is none of our sends); null = inbound, an event, or the source does not say
   * (a Gmail send, a cold email tied to no sequence step). A writer never reads an `automation` line as a person's words.
   */
  sentBy?: "person" | "automation" | null;
}

/** google-service's `bodyCleanStatus`, verbatim. */
export const TEXT_CLEAN_STATUSES = [
  "cleaned",
  "nothing_kept",
  "pending",
  "judge_failed",
  "not_applicable",
  "not_cleaned",
] as const;
export type TextCleanStatus = (typeof TEXT_CLEAN_STATUSES)[number];

/** instantly-service's `outreachFact` on a conversation message, verbatim. */
export interface OutreachFact {
  subjectKey: string;
  step: number | null;
  position: "first" | "followup";
}

export interface TextClean {
  status: TextCleanStatus;
  cleaned: boolean;
  original: string | null;
}

export interface TimelineSource {
  source: PeopleSource;
  status: TimelineSourceStatus;
  items: number;
  error: string | null;
  /** What was asked (addresses, campaigns, contacts) so an empty answer is auditable. */
  asked: string[];
  /** store = crm-service's message store (Gmail, cold email); mirror = crm-service's own synced data. */
  servedFrom: "store" | "mirror";
  /** store only: the oldest source read the items come from (null = never read). */
  readAt: string | null;
  /** store only: a re-read of one of its threads was still running when the answer left (read again shortly). */
  refreshing: boolean;
  /**
   * Mirror records (contact ids) of this source that state one of the person's identity keys but
   * that the person index has not joined to them yet (the index was built before the record carried
   * the key). Their items ARE in this answer (read through); empty = the index already held them all.
   */
  joinedAtRead: string[];
}

interface SourceResult {
  status: TimelineSourceStatus;
  items: TimelineItem[];
  error: string | null;
  asked: string[];
  readAt?: string | null;
  refreshing?: boolean;
}

const notConnected = (asked: string[] = []): SourceResult => ({ status: "not_connected", items: [], error: null, asked });

// ─── matrix ─────────────────────────────────────────────────────────────────

/**
 * A voice note carries no words in bronze (empty body): when it was transcribed
 * (SOPHIE-VOICE-1019), the Unibox shows what was said, `🎤 Voice note: <words>`.
 */
async function withVoiceNoteWords(items: TimelineItem[]): Promise<void> {
  const silent = items.filter((i) => !i.text?.trim() && typeof i.ref?.eventId === "string");
  if (silent.length === 0) return;
  const transcripts = await readVoiceTranscripts(silent.map((i) => i.ref!.eventId as string));
  for (const i of silent) {
    const t = transcripts.get(i.ref!.eventId as string);
    if (t) i.text = voiceNoteText(t);
  }
}

async function matrixItems(presences: Presence[]): Promise<SourceResult> {
  const conversationIds = presences
    .map((p) => p.detail.conversationId)
    .filter((c): c is string => typeof c === "string");
  // The groups the person is in (RELATIONSHIP-TAGS-1014): the words THEY wrote there, labelled with the group.
  const groupHandles = presences
    .filter((p) => Array.isArray(p.detail.groups) && (p.detail.groups as { authoredCount?: number }[]).some((g) => (g.authoredCount ?? 0) > 0))
    .map((p) => ({ handle: p.detail.channelHandle as string, channel: p.detail.channel as string, groups: p.detail.groups as { roomId: string; name: string | null; authoredCount: number }[] }));
  const groupItems: TimelineItem[] = [];
  for (const g of groupHandles) {
    const rooms = g.groups.filter((x) => x.authoredCount > 0);
    if (!g.handle || rooms.length === 0) continue;
    const events = await db
      .select()
      .from(matrixRawEvents)
      .where(
        and(
          inArray(matrixRawEvents.roomId, rooms.map((r) => r.roomId)),
          eq(matrixRawEvents.sender, g.handle),
          eq(matrixRawEvents.eventType, "m.room.message"),
        ),
      );
    for (const e of events) {
      const content = (e.payload as { content?: { body?: unknown } }).content;
      groupItems.push({
        at: e.originServerTs.toISOString(),
        source: "matrix",
        channel: g.channel,
        kind: "message",
        direction: "inbound",
        subject: rooms.find((r) => r.roomId === e.roomId)?.name ?? null,
        text: typeof content?.body === "string" ? content.body : null,
        from: e.sender,
        to: [],
        ref: { eventId: e.eventId, roomId: e.roomId, groupRoomId: e.roomId, recordedAt: e.ingestedAt.toISOString() },
        textClean: null,
        outreachFact: null,
        event: null,
      });
    }
  }
  if (conversationIds.length === 0) {
    await withVoiceNoteWords(groupItems);
    return { status: groupItems.length ? "ok" : "empty", items: groupItems, error: null, asked: [] };
  }
  const convs = await db
    .select({
      id: conversations.id,
      roomId: conversations.roomId,
      channel: conversations.channel,
      connectionId: conversations.connectionId,
      ownMxid: matrixConnections.matrixUserId,
      counterpartPrefix: matrixConnections.counterpartPrefix,
    })
    .from(conversations)
    .innerJoin(matrixConnections, eq(matrixConnections.id, conversations.connectionId))
    .where(inArray(conversations.id, conversationIds));
  const items: TimelineItem[] = [];
  for (const c of convs) {
    const own = await connectionOwnSenders({ id: c.connectionId, matrixUserId: c.ownMxid, counterpartPrefix: c.counterpartPrefix });
    const events = await db
      .select()
      .from(matrixRawEvents)
      .where(
        and(
          eq(matrixRawEvents.connectionId, c.connectionId),
          eq(matrixRawEvents.roomId, c.roomId),
          eq(matrixRawEvents.eventType, "m.room.message"),
        ),
      );
    for (const e of events) {
      const content = (e.payload as { content?: { body?: unknown } }).content;
      items.push({
        at: e.originServerTs.toISOString(),
        source: "matrix",
        channel: c.channel,
        kind: "message",
        direction: isOwnSender(e.sender, own) ? "outbound" : "inbound",
        subject: null,
        text: typeof content?.body === "string" ? content.body : null,
        from: e.sender,
        to: [],
        ref: { eventId: e.eventId, roomId: e.roomId, conversationId: c.id, recordedAt: e.ingestedAt.toISOString() },
        textClean: null,
        outreachFact: null,
        event: null,
      });
    }
  }
  items.push(...groupItems);
  await withVoiceNoteWords(items);
  return { status: items.length ? "ok" : "empty", items, error: null, asked: conversationIds };
}

// ─── entry events: how the person entered each source record ───────────────

const ENTRY: Record<"gohighlevel" | "posthog" | "stripe" | "clerk", { step: string; dateBasis: string; channel: string }> = {
  gohighlevel: { step: "added_to_crm", dateBasis: "contact_created_at", channel: "crm" },
  posthog: { step: "signup", dateBasis: "person_created_at", channel: "web" },
  // A Stripe customer record is no payment (a card check creates one): never "became a customer" (UNIBOX-PAYMENT-REFUSED-1028).
  stripe: { step: "stripe_customer_created", dateBasis: "customer_created_at", channel: "payment" },
  clerk: { step: "signup", dateBasis: "user_created_at", channel: "web" },
};

/** The natural key of the fact an entry event is (facts.ts ghlCandidates / posthogCandidates / authCandidates). */
const ENTRY_FACT_KEY: Partial<Record<keyof typeof ENTRY, (externalId: string | null) => string | null>> = {
  gohighlevel: (id) => (id ? `gohighlevel|contact|${id}` : null),
  posthog: (id) => (id ? `posthog|signup|${id}` : null),
  clerk: (id) => (id ? `clerk|signup|${id}` : null),
};

const entryEvent = (
  source: TimelineItem["source"],
  channel: string,
  at: Date,
  ref: Record<string, string | null>,
  step: string,
  dateBasis: string,
  detail: Record<string, unknown>,
): TimelineItem => ({
  at: at.toISOString(),
  source,
  channel,
  kind: "event",
  direction: null,
  subject: null,
  text: null,
  from: null,
  to: [],
  ref,
  textClean: null,
  outreachFact: null,
  event: { step, dateBasis, detail },
});

/** One entry event per mirrored contact of the source the vendor dated (its own creation date). */
export async function entryItems(source: keyof typeof ENTRY, presences: Presence[]): Promise<TimelineItem[]> {
  const ids = presences.map((p) => p.sourceRef);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      createdAt: contacts.sourceCreatedAt,
      lastRebuiltAt: contacts.lastRebuiltAt,
      leadSource: contacts.leadSource,
      originMedium: contacts.originMedium,
      contactType: contacts.contactType,
      rawAttributes: contacts.rawAttributes,
    })
    .from(contacts)
    .where(and(inArray(contacts.id, ids), eq(contacts.source, source)));
  const { step, dateBasis, channel } = ENTRY[source];
  return rows
    .filter((r) => r.createdAt !== null)
    // An invited teammate's account is no signup (auth/provider.ts isSignup).
    .filter((r) => !(source === "clerk" && (r.rawAttributes as { signedUp?: boolean } | null)?.signedUp === false))
    // A PostHog person known only by what they typed (no identify, no email) did not sign up (posthog/records.ts notSignup).
    .filter((r) => {
      const a = r.rawAttributes as { notSignup?: boolean; phoneOnly?: boolean } | null;
      return !(source === "posthog" && (a?.notSignup === true || a?.phoneOnly === true));
    })
    .map((r) =>
      entryEvent(
        source,
        channel,
        r.createdAt!,
        {
          contactId: r.id,
          externalContactId: r.externalId,
          // The fact this entry IS on the feed (facts.ts), when it is one: a Stripe customer record states none.
          factKey: ENTRY_FACT_KEY[source]?.(r.externalId) ?? null,
          recordedAt: r.lastRebuiltAt.toISOString(),
        },
        step,
        dateBasis,
        source === "gohighlevel"
          ? { leadSource: r.leadSource, originMedium: r.originMedium, contactType: r.contactType }
          : {},
      ),
    );
}

/**
 * The person imported from the brand's uploaded files, or added by hand: one `added_to_crm` per
 * CSV contact holding one of their addresses or phones, dated by the upload (a contact added by
 * hand: by the client's first statement of them, `added_at`). A FILE contact makes nobody a person;
 * a contact added by hand is one (source `csv`, MANUAL-CONTACT-IS-A-PERSON-1024).
 */
export async function csvEntryItems(person: Person): Promise<TimelineItem[]> {
  const emails = person.emails as string[];
  const phones = person.phones as string[];
  if (emails.length === 0 && phones.length === 0) return [];
  const rows = await db
    .select({
      id: contacts.id,
      uploadId: contactUploads.id,
      filename: contactUploads.filename,
      uploadedAt: contactUploads.uploadedAt,
      kind: contactUploads.kind,
      addedAt: contactRowsRaw.fetchedAt,
    })
    .from(contacts)
    .innerJoin(contactUploads, eq(contactUploads.id, contacts.sourceUploadId))
    .leftJoin(contactRowsRaw, eq(contactRowsRaw.id, contacts.sourceRowId))
    .where(
      and(
        eq(contacts.orgId, person.orgId),
        eq(contacts.brandId, person.brandId),
        eq(contacts.source, "csv"),
        sql`(${emails.length ? sql`lower(${contacts.primaryEmail}) IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})` : sql`false`}
          OR ${phones.length ? sql`${contacts.phoneE164} IN (${sql.join(phones.map((p) => sql`${p}`), sql`, `)})` : sql`false`})`,
      ),
    );
  return rows.map((r) =>
    r.kind === "manual"
      ? entryEvent("csv", "manual", r.addedAt ?? r.uploadedAt, { contactId: r.id, uploadId: r.uploadId }, "added_to_crm", "added_at", {
          origin: "manual",
          uploadId: r.uploadId,
          filename: r.filename,
        })
      : entryEvent("csv", "file", r.uploadedAt, { contactId: r.id, uploadId: r.uploadId }, "added_to_crm", "uploaded_at", {
          origin: "csv_import",
          uploadId: r.uploadId,
          filename: r.filename,
        }),
  );
}

// ─── gohighlevel ────────────────────────────────────────────────────────────

async function ghlItems(person: Person, presences: Presence[]): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const items: TimelineItem[] = await entryItems("gohighlevel", presences);
  for (const contactId of contactIds) {
    const r = await readFunnelEvents({ orgId: person.orgId, brandId: person.brandId, contactId, limit: 1, offset: 0 });
    for (const c of r.contacts) {
      for (const ev of c.events) {
        items.push({
          at: ev.occurredAt,
          source: "gohighlevel",
          channel: "crm",
          kind: "event",
          direction: null,
          subject: null,
          text: null,
          from: null,
          to: [],
          ref: { contactId: c.contactId, externalContactId: c.externalContactId, sourceId: ev.sourceId, evidence: ev.source },
          textClean: null,
          outreachFact: null,
          event: { step: ev.step, dateBasis: ev.dateBasis, detail: ev.detail },
        });
      }
    }
  }
  return { status: items.length ? "ok" : "empty", items, error: null, asked: contactIds };
}

// ─── posthog ────────────────────────────────────────────────────────────────

/** `authStatesSignups`: an auth provider is connected, it alone shows the signup (PostHog keeps its visits). */
async function posthogItems(presences: Presence[], authStatesSignups: boolean): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const rows = await db.select().from(posthogActivities).where(inArray(posthogActivities.contactId, contactIds));
  const items: TimelineItem[] = (authStatesSignups ? [] : await entryItems("posthog", presences)).concat(rows.map((a): TimelineItem => ({
    at: a.occurredAt.toISOString(),
    source: "posthog",
    channel: "web",
    kind: "event",
    direction: null,
    subject: null,
    // A custom event reads as its name and what it carried (ONBOARDING-IN-UNIBOX-1015: the step and what was entered).
    text: a.kind === "event" ? describeKeyEvent(a.name, (a.detail as { properties?: Record<string, unknown> } | null)?.properties) : a.name,
    from: null,
    to: [],
    ref: {
      contactId: a.contactId,
      externalId: a.externalId,
      externalPersonId: a.externalPersonId,
      factKey: `posthog|${a.kind}|${a.externalId}`,
      recordedAt: a.lastRebuiltAt.toISOString(),
    },
    textClean: null,
    outreachFact: null,
    event: {
      step: a.kind,
      dateBasis: a.kind === "visit" ? "visit_started_at" : "event_timestamp",
      detail: {
        name: a.name,
        url: a.url,
        pageviews: a.pageviews,
        endedAt: a.endedAt?.toISOString() ?? null,
        ...(a.detail as Record<string, unknown>),
      },
    },
  })));
  return { status: items.length ? "ok" : "empty", items, error: null, asked: contactIds };
}

// ─── auth providers (Clerk) ─────────────────────────────────────────────────

/** An auth provider states one thing about a person: when they signed up. */
async function authItems(source: "clerk", presences: Presence[]): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const items = await entryItems(source, presences);
  return { status: items.length ? "ok" : "empty", items, error: null, asked: contactIds };
}

// ─── copilot ────────────────────────────────────────────────────────────────

/**
 * The person's chat with the Copilot, matched on their addresses (read on the
 * spot, so a turn shows on the next open, before any rebuild). The user wrote =
 * inbound; the Copilot answered = outbound, from "AI Copilot", like any staff
 * member. Every scope but the staff Unibox is `not_connected`.
 */
export async function copilotItems(person: Pick<Person, "orgId" | "brandId" | "emails">): Promise<SourceResult> {
  if (!isCopilotDestination(person.orgId, person.brandId)) return notConnected();
  const emails = person.emails as string[];
  const rows = await readCopilotThread(person.orgId, person.brandId, emails);
  const items = rows.map((m): TimelineItem => {
    const inbound = m.role === "user";
    return {
      at: m.sentAt.toISOString(),
      source: "copilot",
      channel: COPILOT_CHANNEL,
      kind: "message",
      direction: inbound ? "inbound" : "outbound",
      subject: null,
      text: m.text,
      from: inbound ? m.email : COPILOT_SENDER_NAME,
      to: [inbound ? COPILOT_SENDER_NAME : m.email],
      ref: { messageId: m.messageId, sessionId: m.sessionId, chatOrgId: m.chatOrgId, chatUserId: m.chatUserId },
      textClean: null,
      outreachFact: null,
      event: null,
    };
  });
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── transactional emails ───────────────────────────────────────────────────

/**
 * Every transactional email the platform sent the person (TX-EMAIL-IN-UNIBOX-1024), matched on their
 * addresses, read on the spot: an outbound email FROM US with its subject and words at its send time.
 * `ref.messageSource` is the producer's word on the body (`stored` = as sent, `replayed` = re-rendered
 * from its template, `unavailable` = template gone, no subject / body). Staff Unibox scope only.
 */
export async function transactionalItems(person: Pick<Person, "orgId" | "brandId" | "emails">): Promise<SourceResult> {
  if (!isCopilotDestination(person.orgId, person.brandId)) return notConnected();
  const emails = person.emails as string[];
  const rows = await readTxEmailThread(person.orgId, person.brandId, emails);
  const items = rows.map(
    (e): TimelineItem => ({
      at: e.sentAt.toISOString(),
      source: "transactional",
      channel: TX_EMAIL_CHANNEL,
      kind: "message",
      direction: "outbound",
      subject: e.subject,
      text: e.text,
      from: e.fromAddress ?? TX_EMAIL_SENDER_NAME,
      to: [e.recipientEmail],
      ref: { emailId: e.id, eventType: e.eventType, messageSource: e.messageSource, billedOrgId: e.billedOrgId },
      textClean: null,
      outreachFact: null,
      event: null,
    }),
  );
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── account events (billing-service) ───────────────────────────────────────

/**
 * What happened on the client's account with us, from billing-service's credit events (lib/credit-events/feed.ts,
 * CREDIT-RAN-OUT-UNIBOX-EVENT-1024): "Credit ran out" / "Credit restored" on the thread of every member of that org,
 * matched on their addresses, read on the spot. Staff Unibox scope only.
 */
export async function billingItems(person: Pick<Person, "orgId" | "brandId" | "emails">): Promise<SourceResult> {
  if (!isCopilotDestination(person.orgId, person.brandId)) return notConnected();
  const emails = (person.emails as string[]).map((e) => e.toLowerCase());
  if (emails.length === 0) return { status: "empty", items: [], error: null, asked: emails };
  const rows = await db
    .select()
    .from(creditEvents)
    .where(sql`${creditEvents.memberEmails} ?| ARRAY[${sql.join(emails.map((e) => sql`${e}`), sql`, `)}]::text[]`)
    .orderBy(creditEvents.at, creditEvents.eventId);
  const items = rows.map(
    (e): TimelineItem => ({
      at: e.at.toISOString(),
      source: "billing",
      channel: ACCOUNT_CHANNEL,
      kind: "event",
      direction: null,
      subject: null,
      text: creditEventText(e.type, e.orgLabel),
      from: null,
      to: [],
      ref: { billingEventId: e.eventId, accountOrgId: e.creditOrgId, episodeId: e.episodeId },
      textClean: null,
      outreachFact: null,
      event: { step: e.type, dateBasis: creditDateBasis(e.type), detail: { accountOrgId: e.creditOrgId, accountName: e.orgLabel, episodeId: e.episodeId } },
    }),
  );
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── what the client DID on their account (CLIENT-ACTIVITY-1030) ────────────

/**
 * Each action the person took on their account with us (a campaign created / edited / paused / resumed, a budget
 * changed...), reported by the service that performed it (lib/account-activity/), matched on their addresses, read on
 * the spot. One event per fact, `text` = the line (who, what, the campaign, before to after). Staff Unibox scope only.
 */
export async function activityItems(person: Pick<Person, "orgId" | "brandId" | "emails">): Promise<SourceResult> {
  if (!isCopilotDestination(person.orgId, person.brandId)) return notConnected();
  const emails = person.emails as string[];
  const rows = await readActivityThread(emails);
  const items = rows.map(
    (a): TimelineItem => ({
      at: a.occurredAt.toISOString(),
      source: "activity",
      channel: ACTIVITY_CHANNEL,
      kind: "event",
      direction: null,
      subject: null,
      text: activityLine({ title: a.title, subject: a.subject, changes: a.changes, actorName: a.actorName }),
      from: null,
      to: [],
      ref: { activityId: a.activityId, producer: a.producer, accountOrgId: a.accountOrgId, accountBrandId: a.accountBrandId },
      textClean: null,
      outreachFact: null,
      event: {
        step: a.type,
        dateBasis: "occurred_at",
        detail: {
          title: a.title,
          subject: a.subject,
          changes: a.changes,
          via: a.via,
          actorName: a.actorName,
          accountOrgId: a.accountOrgId,
          accountBrandId: a.accountBrandId,
        },
      },
    }),
  );
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── what the client set up with us (ONBOARDING-FICHE-1027) ────────────────

/**
 * The account(s) the person opened with us, one event per (org, brand): the whole record in `text` (plain lines,
 * nothing cut) and structured in `event.detail`, read from the owners for the person's OWN org
 * (lib/onboarding/record.ts). Placed at the latest dated change of the setup. Staff Unibox scope only.
 */
export async function onboardingItems(
  person: Pick<Person, "orgId" | "brandId" | "emails">,
  identity: SiblingIdentity,
): Promise<SourceResult> {
  if (!isCopilotDestination(person.orgId, person.brandId)) return notConnected();
  const emails = person.emails as string[];
  if (emails.length === 0) return { status: "empty", items: [], error: null, asked: emails };
  const records = await cachedOnboardingRecords(emails, identity);
  const items = records.map(
    (r): TimelineItem => ({
      at: r.latestChangeAt,
      source: "onboarding",
      channel: ONBOARDING_CHANNEL,
      kind: "event",
      direction: null,
      subject: `What they set up: ${r.brand.name ?? r.brand.website ?? "their brand"}`,
      text: recordText(r),
      from: null,
      to: [],
      ref: { accountOrgId: r.orgId, accountBrandId: r.brand.id, accountUserId: r.userId },
      textClean: null,
      outreachFact: null,
      event: { step: ONBOARDING_STEP, dateBasis: "latest_setup_change", detail: r as unknown as Record<string, unknown> },
    }),
  );
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── api / mcp calls ────────────────────────────────────────────────────────

/** Brand names seen recently (brand-service), so a thread names "AscendQE", not an id. */
const BRAND_NAME_TTL_MS = 60 * 60 * 1000;
const brandNameCache = new Map<string, { name: string; at: number }>();

export async function brandNamesFor(ids: string[], identity: SiblingIdentity): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = brandNameCache.get(id);
    if (hit && now - hit.at < BRAND_NAME_TTL_MS) out.set(id, hit.name);
    else missing.push(id);
  }
  await Promise.all(
    missing.slice(0, 20).map(async (id) => {
      try {
        const r = await siblingGetOk<{ brand: { name: string | null } }>("brand", `/internal/brands/${encodeURIComponent(id)}`, identity);
        if (r.brand?.name) {
          brandNameCache.set(id, { name: r.brand.name, at: now });
          out.set(id, r.brand.name);
        }
      } catch (err) {
        // The summary then names the brand by its id; the call itself still shows.
        console.error(`[crm-service] api-call thread: brand ${id} name unreadable:`, (err as Error).message);
      }
    }),
  );
  return out;
}

/**
 * The person's calls to our API / MCP server, matched on their addresses (read
 * on the spot, so a call shows on the next open). Each call is two messages:
 * what they asked (inbound, from their email) and what we answered (outbound,
 * from "distribute.you API"), both on channel `api` or `mcp`, both carrying the
 * call id in `ref.callId` (the whole request and response:
 * `GET /orgs/people/api-calls/{callId}`) and the session it belongs to.
 * Every scope but the staff Unibox is `not_connected`.
 */
export async function apiCallItems(
  person: Pick<Person, "orgId" | "brandId" | "emails">,
  identity: SiblingIdentity,
  opts: { deferAnswers?: boolean } = {},
): Promise<SourceResult> {
  if (!isCopilotDestination(person.orgId, person.brandId)) return notConnected();
  const emails = person.emails as string[];
  // deferAnswers (paged read): the answer summary is computed for the page's items only (item-fill.ts).
  const rows = await readApiCallThread(person.orgId, person.brandId, emails, { withoutBodies: opts.deferAnswers });
  const sessions = sessionsOf(rows);
  const brandNames = await brandNamesFor([...new Set(rows.flatMap((r) => (r.brandIds as string[]) ?? []))], identity);
  const items = rows.flatMap((c): TimelineItem[] => {
    const ref = {
      callId: c.callId,
      sessionId: sessions.get(c.callId) ?? c.callId,
      method: c.method,
      path: c.path,
      status: String(c.status),
      mcpTool: c.mcpTool,
      callerOrgId: c.callerOrgId,
      callerUserId: c.callerUserId,
      keyFingerprint: c.keyFingerprint,
    };
    const answeredAt = new Date(c.calledAt.getTime() + c.durationMs).toISOString();
    const asked = describeRequest(c, brandNames);
    const answer: TimelineItem = {
      at: answeredAt,
      source: "api",
      channel: c.channel,
      kind: "message",
      direction: "outbound",
      subject: null,
      text: opts.deferAnswers ? null : describeResponse(c),
      from: API_SENDER_NAME,
      to: [c.email],
      ref,
      textClean: null,
      outreachFact: null,
      event: null,
    };
    if (opts.deferAnswers) deferApiAnswer(answer, person.orgId, person.brandId, c.callId);
    return [
      {
        at: c.calledAt.toISOString(),
        source: "api",
        channel: c.channel,
        kind: "message",
        direction: "inbound",
        subject: null,
        text: c.mcpTool ? `${asked} (MCP tool ${c.mcpTool})` : asked,
        from: c.email,
        to: [API_SENDER_NAME],
        ref,
        textClean: null,
        outreachFact: null,
        event: null,
      },
      answer,
    ];
  });
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── stripe ─────────────────────────────────────────────────────────────────

async function stripeItems(presences: Presence[]): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const rows = await db.select().from(stripeTransactions).where(inArray(stripeTransactions.contactId, contactIds));
  const items: TimelineItem[] = await entryItems("stripe", presences);
  for (const t of rows) {
    const detail = t.detail as Record<string, unknown>;
    const money = {
      amountMinor: t.amountMinor,
      amount: majorAmount(t.amountMinor, t.currency),
      currency: t.currency,
      status: t.status,
      description: t.description,
    };
    const base = {
      textClean: null,
      outreachFact: null,
      source: "stripe" as const,
      channel: "payment",
      kind: "event" as const,
      direction: null,
      subject: null,
      from: null,
      to: [],
      ref: {
        contactId: t.contactId,
        externalId: t.externalId,
        externalCustomerId: t.externalCustomerId,
        // The fact this record IS on the feed (facts.ts stripeCandidates), and when crm-service recorded it.
        factKey: t.kind === "subscription" ? `stripe|subscription|${t.externalId}|${t.status}` : `stripe|${t.kind}|${t.externalId}`,
        recordedAt: t.lastRebuiltAt.toISOString(),
      },
    };
    // What the record WAS (UNIBOX-PAYMENT-REFUSED-1028): a refused card is `payment_refused`, never `payment`.
    const record = { kind: t.kind, amountMinor: t.amountMinor, currency: t.currency, status: t.status, description: t.description, detail };
    const attempt = stripeAttempt(record);
    items.push({
      ...base,
      at: t.occurredAt.toISOString(),
      text: attempt.text,
      event: { step: attempt.step, dateBasis: t.kind === "subscription" ? "start_date" : "created", detail: { ...money, ...detail } },
    });
    if (t.kind === "subscription" && typeof detail.canceledAt === "string") {
      const ended = subscriptionAttempt(record, true);
      items.push({
        ...base,
        at: detail.canceledAt,
        text: ended.text,
        event: { step: ended.step, dateBasis: "canceled_at", detail: { ...money, ...detail } },
      });
    }
  }
  return { status: items.length ? "ok" : "empty", items, error: null, asked: contactIds };
}

// ─── the merged thread ──────────────────────────────────────────────────────

/** The person holding `key` (any of their identity keys) in the (org, brand) index. */
export async function findPerson(orgId: string, brandId: string, key: string): Promise<Person | null> {
  const [row] = await db
    .select()
    .from(people)
    .where(
      and(
        eq(people.orgId, orgId),
        eq(people.brandId, brandId),
        sql`${people.identityKeys} @> ${JSON.stringify([key])}::jsonb`,
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─── records not yet joined (TIMELINE-STALE-SOURCE-1023) ───────────────────

/**
 * The person index (`people.presences`) is rebuilt whole per scope, minutes apart. A mirrored
 * record that starts stating one of a person's keys between two builds (a PostHog person who just
 * typed their email at signup) is not on the person yet, and a read of the index alone answered
 * that source `empty`: a real "nothing there" to a writer, who refused the person for good
 * (2026-10-22, a visitor's 3 visits stored, his PostHog person given his email 2 min before the read).
 * So the timeline reads those records THROUGH: every contact of a mirror source that states one of
 * the person's identity keys (exactly as the build derives them) is read, joined or not, and the
 * ones the index did not hold yet are named on the source (`joinedAtRead`).
 */
export { LATE_JOIN_SOURCES, mirrorContactKeys, type LateJoinSource, type MirrorContactRow };

/** PURE: the rows that state one of `identityKeys` and are not among the person's presences yet, as presences. */
export function unjoinedPresences(rows: MirrorContactRow[], identityKeys: string[], presences: Presence[]): Presence[] {
  const mine = new Set(identityKeys);
  const held = new Set(presences.map((p) => `${p.source}|${p.sourceRef}`));
  return rows
    .filter((r) => (LATE_JOIN_SOURCES as readonly string[]).includes(r.source))
    .filter((r) => !held.has(`${r.source}|${r.id}`))
    .map((r) => ({ r, keys: mirrorContactKeys(r) }))
    .filter(({ keys }) => keys.some((k) => mine.has(k)))
    .map(({ r, keys }) => ({
      source: r.source as LateJoinSource,
      sourceRef: r.id,
      displayName: null,
      company: null,
      emails: keys.filter((k) => k.startsWith("email:")).map((k) => k.slice(6)),
      phones: keys.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6)),
      userIds: keys.filter((k) => k.startsWith("uid:")).map((k) => k.slice(4)),
      firstActivityAt: null,
      lastActivityAt: null,
      messageCount: null,
      inboundCount: null,
      outboundCount: null,
      detail: { contactId: r.id, externalId: r.externalId },
    }));
}

const textArray = (xs: string[]) => sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::text[]`;

/** The brand's mirrored contacts of `sources` that may state one of the person's keys (exact check: unjoinedPresences). */
export async function unjoinedRecords(person: Person, sources: LateJoinSource[]): Promise<Presence[]> {
  const keys = person.identityKeys as string[];
  const emails = keys.filter((k) => k.startsWith("email:")).map((k) => k.slice(6));
  const phones = keys.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6));
  const uids = keys.filter((k) => k.startsWith("uid:")).map((k) => k.slice(4));
  if (sources.length === 0 || emails.length + phones.length + uids.length === 0) return [];
  const match = [
    ...(emails.length
      ? [sql`lower(${contacts.primaryEmail}) = ANY(${textArray(emails)})`, sql`(${contacts.rawAttributes}->'emails') ?| ${textArray(emails)}`]
      : []),
    ...(phones.length
      ? [sql`${contacts.phoneE164} = ANY(${textArray(phones)})`, sql`(${contacts.rawAttributes}->'phones') ?| ${textArray(phones)}`]
      : []),
    ...(uids.length
      ? [sql`${contacts.externalId} = ANY(${textArray(uids)})`, sql`(${contacts.rawAttributes}->'distinctIds') ?| ${textArray(uids)}`]
      : []),
  ];
  const rows = await db
    .select({
      id: contacts.id,
      source: contacts.source,
      primaryEmail: contacts.primaryEmail,
      phoneE164: contacts.phoneE164,
      externalId: contacts.externalId,
      rawAttributes: contacts.rawAttributes,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, person.orgId),
        eq(contacts.brandId, person.brandId),
        inArray(contacts.source, sources),
        sql`(${sql.join(match, sql` OR `)})`,
      ),
    );
  return unjoinedPresences(rows, keys, person.presences as Presence[]);
}

const toFailed = (err: unknown, asked: string[] = []): SourceResult => ({
  status: "failed",
  items: [],
  error: (err as Error).message,
  asked,
});

// ─── who sent it (ONBOARDING-FICHE-1027) ─────────────────────────────────────

/** Which outbound Matrix items are our automated WhatsApp sends (by event id, else same room + same text). */
async function automatedMatrixSends(items: TimelineItem[]): Promise<Set<string>> {
  const out = items.filter((i) => i.direction === "outbound" && i.ref.eventId);
  const auto = new Set<string>();
  if (out.length === 0) return auto;
  const ids = out.map((i) => i.ref.eventId as string);
  const rooms = [...new Set(out.map((i) => i.ref.roomId).filter((r): r is string => !!r))];
  const sends = (await db.execute(sql`
    SELECT event_id, room_id, text FROM whatsapp_sends
    WHERE event_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
      ${rooms.length ? sql`OR room_id IN (${sql.join(rooms.map((x) => sql`${x}`), sql`, `)})` : sql``}
  `)) as unknown as { event_id: string | null; room_id: string | null; text: string }[];
  const sentIds = new Set(sends.map((r) => r.event_id).filter((x): x is string => !!x));
  const sentTexts = new Set(sends.map((r) => `${r.room_id}|${r.text.trim()}`));
  for (const i of out) {
    const id = i.ref.eventId as string;
    if (sentIds.has(id) || (i.text?.trim() && sentTexts.has(`${i.ref.roomId}|${i.text.trim()}`))) auto.add(id);
  }
  return auto;
}

/** PURE: who sent an item (`TimelineItem.sentBy`). */
export function sentByOf(i: TimelineItem, ourWhatsappSends: Set<string>): TimelineItem["sentBy"] {
  if (i.kind !== "message" || i.direction === "inbound" || i.direction === null) return null;
  switch (i.source) {
    case "transactional":
    case "copilot":
    case "api":
      return "automation";
    case "instantly":
      return i.outreachFact ? "automation" : null;
    case "matrix":
      if (i.direction !== "outbound") return null;
      return i.ref.eventId && ourWhatsappSends.has(i.ref.eventId) ? "automation" : "person";
    default:
      return null;
  }
}

export interface TransactionalSend {
  recipientEmail: string;
  subject: string | null;
  sentAt: Date;
}

/** Transactional emails that could be the Gmail items' twins (same subject, sent within the window). */
async function transactionalSends(gmail: TimelineItem[]): Promise<TransactionalSend[]> {
  const subjects = [...new Set(gmail.map((i) => i.subject).filter((x): x is string => !!x))];
  if (subjects.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT recipient_email, subject, sent_at FROM transactional_emails
    WHERE subject IN (${sql.join(subjects.map((x) => sql`${x}`), sql`, `)})
  `)) as unknown as { recipient_email: string; subject: string | null; sent_at: Date | string }[];
  return rows.map((r) => ({ recipientEmail: r.recipient_email, subject: r.subject, sentAt: new Date(r.sent_at) }));
}

/** How far apart the producer's send time and the mailbox's copy of the same email may be. */
export const TX_GMAIL_TWIN_WINDOW_MS = 10 * 60_000;

/**
 * PURE: drop every Gmail item that IS a transactional email we sent (same recipient, same subject, sent within
 * TX_GMAIL_TWIN_WINDOW_MS): a staff mailbox (growth@) holds a copy of each, and Gmail threads same-subject sends to
 * DIFFERENT recipients together, so the copy showed twice on the recipient's thread and another client's welcome
 * email on theirs (Chaim's thread held Joshua's, 2026-10-27). The transactional item stays, labelled automation.
 */
export function withoutTransactionalCopies(gmail: TimelineItem[], sends: TransactionalSend[]): TimelineItem[] {
  if (sends.length === 0) return gmail;
  return gmail.filter((i) => {
    if (i.direction === "inbound" || !i.subject || !i.at) return true;
    const at = Date.parse(i.at);
    const to = new Set(i.to.map((t) => t.trim().toLowerCase()));
    return !sends.some(
      (s) => s.subject === i.subject && to.has(s.recipientEmail.trim().toLowerCase()) && Math.abs(s.sentAt.getTime() - at) <= TX_GMAIL_TWIN_WINDOW_MS,
    );
  });
}

export async function readTimeline(
  scope: PeopleScope,
  person: Person,
  sourceReads: BuildSummary | null,
  identity: SiblingIdentity,
  opts: StoredReadOptions & {
    /** false = do not read records not yet joined (a relation's thread: only its own contact points). */
    lateJoin?: boolean;
  } = {},
): Promise<{ sources: TimelineSource[]; items: TimelineItem[]; indexCurrent: boolean }> {
  const presences = person.presences as Presence[];
  const connected = (s: PeopleSource) =>
    sourceReads?.sources.find((r) => r.source === s)?.status !== "not_connected";
  const emails = person.emails as string[];

  // Records stating one of the person's keys that the index has not joined yet are read too.
  let late: Presence[] = [];
  let lateError: string | null = null;
  if (opts.lateJoin !== false) {
    try {
      late = await unjoinedRecords(person, LATE_JOIN_SOURCES.filter(connected));
    } catch (err) {
      lateError = `could not check for records not yet joined to this person: ${(err as Error).message}`;
      console.error(`[crm-service] timeline late-join read failed person=${person.personKey}:`, err);
    }
  }
  const of = (s: PeopleSource) => [...presences, ...late].filter((p) => p.source === s);

  const storedRead = readStoredTimeline(
    scope,
    { personKey: person.personKey, emails, presences, lastActivityAt: person.lastActivityAt },
    connected("gmail"),
    identity,
    // Every campaign the address is a lead on, engaged or not — asked in the background only.
    async (email) => {
      const lead = await lookupLeadStanding(identity, email);
      return lead.found ? lead.campaignIds : [];
    },
    opts,
  );
  // Every CSV contact holding one of the person's keys (a file row or one added by hand): its `added_to_crm` date.
  const csvRead = csvEntryItems(person).then(
    (items): SourceResult => ({ status: items.length ? "ok" : "empty", items, error: null, asked: emails }),
    (e) => toFailed(e, emails),
  );
  const fromStore = (pick: (t: StoredTimeline) => StoredTimeline["gmail"]) =>
    storedRead.then((t): SourceResult => pick(t)).catch((e) => toFailed(e, emails));

  const [gmail, instantly, matrix, gohighlevel, posthog, stripe, clerk, copilot, api, billing, transactional, onboarding, csv, activity] = await Promise.all([
    connected("gmail") ? fromStore((t) => t.gmail) : Promise.resolve(notConnected()),
    fromStore((t) => t.instantly),
    connected("matrix") ? matrixItems(of("matrix")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("gohighlevel")
      ? ghlItems(person, of("gohighlevel")).catch((e) => toFailed(e))
      : Promise.resolve(notConnected()),
    connected("posthog") ? posthogItems(of("posthog"), connected("clerk")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("stripe") ? stripeItems(of("stripe")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("clerk") ? authItems("clerk", of("clerk")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    copilotItems(person).catch((e) => toFailed(e, emails)),
    apiCallItems(person, identity, { deferAnswers: opts.paged }).catch((e) => toFailed(e, emails)),
    billingItems(person).catch((e) => toFailed(e, emails)),
    transactionalItems(person).catch((e) => toFailed(e, emails)),
    onboardingItems(person, identity).catch((e) => toFailed(e, emails)),
    csvRead,
    activityItems(person).catch((e) => toFailed(e, emails)),
  ]);
  const bySource: Record<PeopleSource, SourceResult> = { gmail, instantly, matrix, gohighlevel, posthog, stripe, clerk, copilot, api, billing, transactional, onboarding, csv, activity };
  // A Gmail copy of a transactional email we sent (a staff mailbox holds it) is that email: shown once, as ours.
  if (bySource.gmail.items.length && bySource.transactional.status === "ok") {
    bySource.gmail = { ...bySource.gmail, items: withoutTransactionalCopies(bySource.gmail.items, await transactionalSends(bySource.gmail.items)) };
  }
  // The check itself failed: no late-join source may pose as complete (its index items are still served).
  if (lateError) {
    for (const s of LATE_JOIN_SOURCES) {
      if (bySource[s].status === "not_connected") continue;
      bySource[s] = { ...bySource[s], status: "failed", error: bySource[s].error ? `${bySource[s].error}; ${lateError}` : lateError };
    }
  }

  // Background pass: lead-service campaign discovery (+ any thread the deadline left unread).
  storedRead
    .then((t) => {
      if (t.stale) {
        setImmediate(() => {
          t.refresh().catch((e) => console.error(`[crm-service] timeline refresh failed person=${person.personKey}:`, e));
        });
      }
    })
    .catch(() => undefined);

  const ourWhatsappSends = await automatedMatrixSends(bySource.matrix.items);
  for (const s of PEOPLE_SOURCES) for (const i of bySource[s].items) i.sentBy = sentByOf(i, ourWhatsappSends);
  const items = PEOPLE_SOURCES.flatMap((s) => bySource[s].items).sort((a, b) => {
    if (a.at === null && b.at === null) return 0;
    if (a.at === null) return 1; // undated last
    if (b.at === null) return -1;
    return new Date(a.at).getTime() - new Date(b.at).getTime();
  });

  return {
    sources: PEOPLE_SOURCES.map((s) => ({
      source: s,
      status: bySource[s].status,
      items: bySource[s].items.length,
      error: bySource[s].error,
      asked: bySource[s].asked,
      servedFrom: s === "gmail" || s === "instantly" ? ("store" as const) : ("mirror" as const),
      readAt: bySource[s].readAt ?? null,
      refreshing: bySource[s].refreshing ?? false,
      joinedAtRead: late.filter((p) => p.source === s).map((p) => p.sourceRef),
    })),
    items,
    indexCurrent: late.length === 0 && lateError === null,
  };
}

// ─── one page of the thread (DASH-LATENCY-1014) ────────────────────────────

/**
 * A person's thread can hold thousands of items (6,963 and 10.7 MB for one staff person):
 * the Unibox shows the latest first and loads older ones on demand. A page is read off
 * the same merged thread, in ONE total order: date (undated last, as in the whole
 * thread), then the item's identity (`itemKey`), so a cursor names an exact position and
 * a new message never shifts what "older than this" means.
 */
export function itemKey(i: TimelineItem): string {
  // `factId` is attached after paging (UNIBOX-FACT-ID-1019): never part of a position.
  const { factId: _factId, ...ref } = i.ref ?? {};
  return `${i.source}|${i.channel}|${i.kind}|${i.direction ?? ""}|${i.event?.step ?? ""}|${JSON.stringify(ref)}`;
}

interface Position {
  at: number | null;
  key: string;
}

const positionOf = (i: TimelineItem): Position => {
  const t = i.at === null ? NaN : new Date(i.at).getTime();
  return { at: Number.isNaN(t) ? null : t, key: itemKey(i) };
};

/** PURE: the thread's total order (oldest first, undated last). */
export function comparePositions(a: Position, b: Position): number {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at - b.at;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function encodeCursor(p: Position): string {
  return Buffer.from(JSON.stringify({ at: p.at, k: p.key }), "utf8").toString("base64url");
}

/** null = not a cursor this service minted. */
export function decodeCursor(cursor: string): Position | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; k?: unknown };
    if (typeof raw.k !== "string" || !(raw.at === null || typeof raw.at === "number")) return null;
    return { at: raw.at, key: raw.k };
  } catch {
    return null;
  }
}

export interface TimelinePage {
  /** The page, oldest first (like the whole thread). */
  items: TimelineItem[];
  /** Items of the whole thread. */
  totalItems: number;
  /** Items older than this page exist. */
  hasOlder: boolean;
  /** Pass as `before` to read the page just older than this one; null when none. */
  olderCursor: string | null;
}

/** PURE: the `limit` latest items strictly older than `before` (absent = the latest of the thread). */
export function pageOf(items: TimelineItem[], limit: number, before: Position | null): TimelinePage {
  const positioned = items.map((item) => ({ item, pos: positionOf(item) }));
  positioned.sort((a, b) => comparePositions(a.pos, b.pos));
  let end = positioned.length;
  if (before) {
    let lo = 0;
    let hi = positioned.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comparePositions(positioned[mid].pos, before) < 0) lo = mid + 1;
      else hi = mid;
    }
    end = lo;
  }
  const start = Math.max(0, end - limit);
  const page = positioned.slice(start, end);
  return {
    items: page.map((p) => p.item),
    totalItems: positioned.length,
    hasOlder: start > 0,
    olderCursor: start > 0 && page.length ? encodeCursor(page[0].pos) : null,
  };
}
