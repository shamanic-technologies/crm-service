/**
 * One person's whole exchange, every channel merged into ONE thread, oldest
 * first — read live, at request time, from where each exchange lives:
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
 * Nothing is copied: the messages stay in their source and are fetched for the
 * person being read. Each source answers a status, so "not connected",
 * "connected, nothing with this person" and "could not read it" never collapse
 * into an empty thread.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  conversations,
  matrixConnections,
  matrixRawEvents,
  people,
  posthogActivities,
  stripeTransactions,
  type Person,
} from "../../db/schema.js";
import { majorAmount } from "../stripe/records.js";
import { readFunnelEvents, type FunnelEvent } from "../gohighlevel/funnel-events.js";
import type { BuildSummary } from "./build.js";
import { PEOPLE_SOURCES, type PeopleSource, type Presence } from "./identity.js";
import { siblingGet, type SiblingIdentity } from "./siblings.js";
import { lookupLeadStanding } from "./sources.js";

export const TIMELINE_SOURCE_STATUSES = ["ok", "empty", "not_connected", "failed"] as const;
export type TimelineSourceStatus = (typeof TIMELINE_SOURCE_STATUSES)[number];

export interface TimelineItem {
  /** ISO time the message was sent / the event happened; null when the source gave none. */
  at: string | null;
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
  /** The source's own ids for this item (thread, message, campaign, contact...). */
  ref: Record<string, string | null>;
  /**
   * Events only: the step and its evidence, as the source states it. GoHighLevel
   * carries its funnel-event detail; PostHog `visit` / `event` and Stripe
   * `payment` / `refund` / `subscription_started` / `subscription_canceled`
   * carry their own (page, pageviews; amount, currency, status).
   */
  event: { step: string; dateBasis: string; detail: FunnelEvent["detail"] | Record<string, unknown> } | null;
}

export interface TimelineSource {
  source: PeopleSource;
  status: TimelineSourceStatus;
  items: number;
  error: string | null;
  /** What was asked (addresses, campaigns, contacts) so an empty answer is auditable. */
  asked: string[];
}

interface SourceResult {
  status: TimelineSourceStatus;
  items: TimelineItem[];
  error: string | null;
  asked: string[];
}

const notConnected = (asked: string[] = []): SourceResult => ({ status: "not_connected", items: [], error: null, asked });

// ─── gmail ──────────────────────────────────────────────────────────────────

interface GmailConversation {
  threads: {
    threadId: string;
    messages: {
      gmailMessageId: string;
      threadId: string;
      direction: "inbound" | "outbound" | "other";
      fromEmail: string | null;
      to: string[];
      subject: string | null;
      snippet: string | null;
      sentAt: string | null;
      bodyText: string | null;
      bodyStatus: string;
    }[];
  }[];
}

async function gmailItems(identity: SiblingIdentity, emails: string[]): Promise<SourceResult> {
  if (emails.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const items: TimelineItem[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const r = await siblingGet("google", `/orgs/google/conversation?email=${encodeURIComponent(email)}&limit=500`, identity);
    const reason = (r.body as { reason?: string } | null)?.reason;
    if (r.status === 404 && reason === "no_google_account_connected") return notConnected(emails);
    if (r.status === 404 && reason === "no_messages") continue;
    if (r.status !== 200) {
      return {
        status: "failed",
        items: [],
        error: `google-service conversation for ${email} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
        asked: emails,
      };
    }
    for (const thread of (r.body as GmailConversation).threads) {
      for (const m of thread.messages) {
        if (seen.has(m.gmailMessageId)) continue; // a message to two of the person's addresses
        seen.add(m.gmailMessageId);
        items.push({
          at: m.sentAt,
          source: "gmail",
          channel: "email",
          kind: "message",
          direction: m.direction,
          subject: m.subject,
          text: m.bodyStatus === "ok" ? m.bodyText : m.snippet,
          from: m.fromEmail,
          to: m.to,
          ref: { gmailMessageId: m.gmailMessageId, threadId: m.threadId, bodyStatus: m.bodyStatus },
          event: null,
        });
      }
    }
  }
  return { status: items.length ? "ok" : "empty", items, error: null, asked: emails };
}

// ─── instantly ──────────────────────────────────────────────────────────────

interface InstantlyConversation {
  conversation: {
    campaignId: string;
    messages: {
      direction: "inbound" | "outbound";
      from: string;
      to: string;
      at: string;
      subject: string;
      text: string;
      campaignId: string;
      instantlyCampaignId: string;
    }[];
  };
}

async function instantlyItems(identity: SiblingIdentity, pairs: { email: string; campaignId: string }[]): Promise<SourceResult> {
  const asked = pairs.map((p) => `${p.campaignId}:${p.email}`);
  if (pairs.length === 0) return { status: "empty", items: [], error: null, asked };
  const items: TimelineItem[] = [];
  for (const { email, campaignId } of pairs) {
    const r = await siblingGet(
      "instantly",
      `/orgs/conversations?campaign_id=${encodeURIComponent(campaignId)}&email=${encodeURIComponent(email)}`,
      identity,
    );
    // Documented: this org has no record of that (campaign, lead) — nothing was exchanged there.
    if (r.status === 404) continue;
    if (r.status !== 200) {
      return {
        status: "failed",
        items: [],
        error: `instantly-service conversation ${campaignId}/${email} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
        asked,
      };
    }
    for (const m of (r.body as InstantlyConversation).conversation.messages) {
      items.push({
        at: m.at || null,
        source: "instantly",
        channel: "email",
        kind: "message",
        direction: m.direction,
        subject: m.subject || null,
        text: m.text,
        from: m.from,
        to: m.to ? [m.to] : [],
        ref: { campaignId: m.campaignId, instantlyCampaignId: m.instantlyCampaignId },
        event: null,
      });
    }
  }
  return { status: items.length ? "ok" : "empty", items, error: null, asked };
}

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
        event: null,
      });
    }
  }
  return { status: items.length ? "ok" : "empty", items, error: null, asked: conversationIds };
}

// ─── gohighlevel ────────────────────────────────────────────────────────────

async function ghlItems(person: Person, presences: Presence[]): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const items: TimelineItem[] = [];
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
  const items: TimelineItem[] = rows.map((a) => ({
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
  }));
  return { status: items.length ? "ok" : "empty", items, error: null, asked: contactIds };
}

// ─── stripe ─────────────────────────────────────────────────────────────────

const STRIPE_STEP: Record<string, string> = { payment: "payment", refund: "refund", subscription: "subscription_started" };

async function stripeItems(presences: Presence[]): Promise<SourceResult> {
  const contactIds = presences.map((p) => p.sourceRef);
  if (contactIds.length === 0) return { status: "empty", items: [], error: null, asked: [] };
  const rows = await db.select().from(stripeTransactions).where(inArray(stripeTransactions.contactId, contactIds));
  const items: TimelineItem[] = [];
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
  person: Person,
  sourceReads: BuildSummary | null,
  identity: SiblingIdentity,
): Promise<{ sources: TimelineSource[]; items: TimelineItem[] }> {
  const presences = person.presences as Presence[];
  const of = (s: PeopleSource) => presences.filter((p) => p.source === s);
  const connected = (s: PeopleSource) =>
    sourceReads?.sources.find((r) => r.source === s)?.status !== "not_connected";
  const emails = person.emails as string[];

  const instantlyPairs = async () => {
    const pairs = new Map<string, { email: string; campaignId: string }>();
    for (const p of of("instantly")) {
      for (const c of (p.detail.campaignIds as string[]) ?? []) pairs.set(`${c}:${p.sourceRef}`, { email: p.sourceRef, campaignId: c });
    }
    // Every campaign the address is a lead on, engaged or not — read from lead-service.
    for (const email of emails) {
      const lead = await lookupLeadStanding(identity, email);
      if (lead.found) for (const c of lead.campaignIds) pairs.set(`${c}:${email}`, { email, campaignId: c });
    }
    return [...pairs.values()];
  };

  const [gmail, instantly, matrix, gohighlevel, posthog, stripe] = await Promise.all([
    connected("gmail") ? gmailItems(identity, emails).catch((e) => toFailed(e, emails)) : Promise.resolve(notConnected()),
    instantlyPairs()
      .then((pairs) => instantlyItems(identity, pairs))
      .catch((e) => toFailed(e, emails)),
    connected("matrix") ? matrixItems(of("matrix")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("gohighlevel")
      ? ghlItems(person, of("gohighlevel")).catch((e) => toFailed(e))
      : Promise.resolve(notConnected()),
    connected("posthog") ? posthogItems(of("posthog")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
    connected("stripe") ? stripeItems(of("stripe")).catch((e) => toFailed(e)) : Promise.resolve(notConnected()),
  ]);
  const bySource: Record<PeopleSource, SourceResult> = { gmail, instantly, matrix, gohighlevel, posthog, stripe };

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
    })),
    items,
  };
}
