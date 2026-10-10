/**
 * One person's whole exchange, every channel merged into ONE thread, oldest
 * first. Gmail and cold email are served from crm-service's message store
 * (people/search.ts), refreshed in the background, so a read never waits on a
 * slow sibling; every other source is crm-service's own mirror, read in place:
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
 *
 * Every source record that brought the person in also adds ONE entry event,
 * dated by the source (`entryItems`): GoHighLevel `added_to_crm` (contact
 * created), CSV `added_to_crm` (file uploaded), PostHog `signup` (person
 * created), Stripe `became_customer` (customer created). A record whose source
 * gives no date adds nothing: a date is never invented, never the build time.
 * So a person is never an empty thread while any of their records is dated.
 *
 * Gmail and cold-email items carry `servedFrom: "store"` and `readAt` (the
 * oldest read they come from). The freshness watch (people/freshness.ts) re-reads
 * a stored thread within about a minute of its source moving, and an open that
 * finds a thread stored before a known move re-reads it first, so a message that
 * exists is in the thread on the first open. A store older than
 * TIMELINE_REFRESH_MS is also re-read in the background after the answer. Each source answers a status, so "not connected",
 * "connected, nothing with this person" and "could not read it" never collapse
 * into an empty thread.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  contactUploads,
  conversations,
  matrixConnections,
  matrixRawEvents,
  people,
  posthogActivities,
  stripeTransactions,
  type PeopleScope,
  type Person,
} from "../../db/schema.js";
import { majorAmount } from "../stripe/records.js";
import { readFunnelEvents, type FunnelEvent } from "../gohighlevel/funnel-events.js";
import type { BuildSummary } from "./build.js";
import { PEOPLE_SOURCES, type PeopleSource, type Presence } from "./identity.js";
import type { SiblingIdentity } from "./siblings.js";
import { readStoredTimeline, type StoredTimeline } from "./search.js";
import { lookupLeadStanding } from "./sources.js";

export const TIMELINE_SOURCE_STATUSES = ["ok", "empty", "not_connected", "failed"] as const;
export type TimelineSourceStatus = (typeof TIMELINE_SOURCE_STATUSES)[number];

export interface TimelineItem {
  /** ISO time the message was sent / the event happened; null when the source gave none. */
  at: string | null;
  /** `csv` only on the entry event of a contact imported from an uploaded file. */
  source: PeopleSource | "csv";
  /** email | whatsapp | telegram | discord | crm | web | payment */
  channel: string;
  kind: "message" | "event";
  /** inbound = the person wrote; outbound = the brand did; null for an event. */
  direction: "inbound" | "outbound" | "other" | null;
  subject: string | null;
  text: string | null;
  from: string | null;
  to: string[];
  /** The source's own ids for this item (thread, message, campaign, contact...). */
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
}

interface SourceResult {
  status: TimelineSourceStatus;
  items: TimelineItem[];
  error: string | null;
  asked: string[];
  readAt?: string | null;
}

const notConnected = (asked: string[] = []): SourceResult => ({ status: "not_connected", items: [], error: null, asked });

// ─── matrix ─────────────────────────────────────────────────────────────────

async function matrixItems(presences: Presence[]): Promise<SourceResult> {
  const conversationIds = presences
    .map((p) => p.detail.conversationId)
    .filter((c): c is string => typeof c === "string");
  if (conversationIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const convs = await db
    .select({
      id: conversations.id,
      roomId: conversations.roomId,
      channel: conversations.channel,
      connectionId: conversations.connectionId,
      ownMxid: matrixConnections.matrixUserId,
    })
    .from(conversations)
    .innerJoin(matrixConnections, eq(matrixConnections.id, conversations.connectionId))
    .where(inArray(conversations.id, conversationIds));
  const items: TimelineItem[] = [];
  for (const c of convs) {
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
        direction: e.sender === c.ownMxid ? "outbound" : "inbound",
        subject: null,
        text: typeof content?.body === "string" ? content.body : null,
        from: e.sender,
        to: [],
        ref: { eventId: e.eventId, roomId: e.roomId, conversationId: c.id },
        textClean: null,
        outreachFact: null,
        event: null,
      });
    }
  }
  return { status: items.length ? "ok" : "empty", items, error: null, asked: conversationIds };
}

// ─── entry events: how the person entered each source record ───────────────

const ENTRY: Record<"gohighlevel" | "posthog" | "stripe", { step: string; dateBasis: string; channel: string }> = {
  gohighlevel: { step: "added_to_crm", dateBasis: "contact_created_at", channel: "crm" },
  posthog: { step: "signup", dateBasis: "person_created_at", channel: "web" },
  stripe: { step: "became_customer", dateBasis: "customer_created_at", channel: "payment" },
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
      leadSource: contacts.leadSource,
      originMedium: contacts.originMedium,
      contactType: contacts.contactType,
    })
    .from(contacts)
    .where(and(inArray(contacts.id, ids), eq(contacts.source, source)));
  const { step, dateBasis, channel } = ENTRY[source];
  return rows
    .filter((r) => r.createdAt !== null)
    .map((r) =>
      entryEvent(
        source,
        channel,
        r.createdAt!,
        { contactId: r.id, externalContactId: r.externalId },
        step,
        dateBasis,
        source === "gohighlevel"
          ? { leadSource: r.leadSource, originMedium: r.originMedium, contactType: r.contactType }
          : {},
      ),
    );
}

/**
 * The person imported from the brand's uploaded files: one `added_to_crm` per
 * CSV contact holding one of their addresses or phones, dated by the upload.
 * CSV contacts make nobody a person; they only say when the client imported one.
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
    })
    .from(contacts)
    .innerJoin(contactUploads, eq(contactUploads.id, contacts.sourceUploadId))
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
    entryEvent("csv", "file", r.uploadedAt, { contactId: r.id, uploadId: r.uploadId }, "added_to_crm", "uploaded_at", {
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

async function posthogItems(presences: Presence[]): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const rows = await db.select().from(posthogActivities).where(inArray(posthogActivities.contactId, contactIds));
  const items: TimelineItem[] = (await entryItems("posthog", presences)).concat(rows.map((a): TimelineItem => ({
    at: a.occurredAt.toISOString(),
    source: "posthog",
    channel: "web",
    kind: "event",
    direction: null,
    subject: null,
    text: a.name,
    from: null,
    to: [],
    ref: { contactId: a.contactId, externalId: a.externalId, externalPersonId: a.externalPersonId },
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

// ─── stripe ─────────────────────────────────────────────────────────────────

const STRIPE_STEP: Record<string, string> = { payment: "payment", refund: "refund", subscription: "subscription_started" };

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
      ref: { contactId: t.contactId, externalId: t.externalId, externalCustomerId: t.externalCustomerId },
    };
    items.push({
      ...base,
      at: t.occurredAt.toISOString(),
      text: t.description,
      event: { step: STRIPE_STEP[t.kind], dateBasis: t.kind === "subscription" ? "start_date" : "created", detail: { ...money, ...detail } },
    });
    if (t.kind === "subscription" && typeof detail.canceledAt === "string") {
      items.push({
        ...base,
        at: detail.canceledAt,
        text: t.description,
        event: { step: "subscription_canceled", dateBasis: "canceled_at", detail: { ...money, ...detail } },
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

const toFailed = (err: unknown, asked: string[] = []): SourceResult => ({
  status: "failed",
  items: [],
  error: (err as Error).message,
  asked,
});

export async function readTimeline(
  scope: PeopleScope,
  person: Person,
  sourceReads: BuildSummary | null,
  identity: SiblingIdentity,
): Promise<{ sources: TimelineSource[]; items: TimelineItem[] }> {
  const presences = person.presences as Presence[];
  const of = (s: PeopleSource) => presences.filter((p) => p.source === s);
  const connected = (s: PeopleSource) =>
    sourceReads?.sources.find((r) => r.source === s)?.status !== "not_connected";
  const emails = person.emails as string[];

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
  );
  const fromStore = (pick: (t: StoredTimeline) => StoredTimeline["gmail"]) =>
    storedRead.then((t): SourceResult => pick(t)).catch((e) => toFailed(e, emails));

  const [gmail, instantly, matrix, gohighlevel, posthog, stripe] = await Promise.all([
    connected("gmail") ? fromStore((t) => t.gmail) : Promise.resolve(notConnected()),
    fromStore((t) => t.instantly),
    connected("matrix") ? matrixItems(of("matrix")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("gohighlevel")
      ? ghlItems(person, of("gohighlevel")).catch((e) => toFailed(e))
      : Promise.resolve(notConnected()),
    connected("posthog") ? posthogItems(of("posthog")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("stripe") ? stripeItems(of("stripe")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
  ]);
  const bySource: Record<PeopleSource, SourceResult> = { gmail, instantly, matrix, gohighlevel, posthog, stripe };
  // CSV is no people source (it has no status row); its import dates ride in the thread.
  const csv = await csvEntryItems(person);

  // Stale store: re-read in the background; this read is answered from what is stored.
  storedRead
    .then((t) => {
      if (t.stale) {
        setImmediate(() => {
          t.refresh().catch((e) => console.error(`[crm-service] timeline refresh failed person=${person.personKey}:`, e));
        });
      }
    })
    .catch(() => undefined);

  const items = [...PEOPLE_SOURCES.flatMap((s) => bySource[s].items), ...csv].sort((a, b) => {
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
    })),
    items,
  };
}
