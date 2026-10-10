/**
 * Is a conversation from the owner's PERSONAL channels about THIS brand?
 *
 * A brand owner connects their own Gmail and their own WhatsApp (any
 * Matrix-bridged channel). Those inboxes hold family, friends, doctors,
 * landlords, and the owner's OTHER companies. The owner wants to see only the
 * conversations about this brand, and never wants their private life read as
 * sales data. So every such conversation is judged on three levels, in ONE Jev
 * call (chat-service `POST /orgs/judgments`, input tokens only, billed to the
 * org run the caller forwards):
 *
 *   1-2. `topic` (choice): personal | other_business | this_brand
 *        (the brand's name, website and offers, and the org's other brands, are
 *        in the state, read from brand-service);
 *   3.   one `noul` per ACTIVE offer of the brand: is the conversation about it?
 *
 * Nothing in code decides it: no keyword list, no domain sniff. The verdict is
 * Jev's, recorded with its probabilities and exactly what Jev was shown
 * (`conversation_verdicts`). A conversation is judged ONCE and re-judged only
 * when it moved (a new message: `judged_through`) or the brand's context
 * changed (`context_hash`: an offer added or renamed).
 *
 * HIDDEN = Jev gives "about this brand" a probability below
 * BRAND_MIN_PROBABILITY. A conversation never judged (Jev down, its messages
 * unreadable) is SHOWN: nothing disappears without Jev saying so.
 *
 * WHO is hidden is decided in people/build.ts: only a person known from
 * personal channels ALONE. A person also known from a business source (our
 * cold email, a lead, the CRM, Stripe) is never hidden by this.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contacts, conversations, conversationVerdicts, matrixConnections, matrixRawEvents } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeQuestions, type ChoiceQuestion, type NoulQuestion } from "../judgments-client.js";
import type { MatrixEvent } from "../matrix/client.js";
import { renderThread } from "../matrix/events.js";
import { mapLimit, siblingGet, siblingGetOk, type SiblingIdentity } from "./siblings.js";

export const TOPICS = ["personal", "other_business", "this_brand"] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * A conversation is hidden only when Jev puts "about this brand" BELOW this
 * probability, i.e. Jev is at least 75% sure it is personal or another
 * business. Hiding a real prospect is the expensive mistake, so a hesitant
 * verdict keeps the conversation visible.
 */
export const BRAND_MIN_PROBABILITY = 0.25;
/** An offer is tagged when Jev's yes-probability reaches this. */
export const OFFER_MIN_PROBABILITY = 0.5;

const CONCURRENCY = 4;
const MAX_MESSAGES = 10;
const MESSAGE_CHARS = 400;

const TOPIC_CRITERIA: Record<Topic, string> = {
  personal:
    "the owner's private life, nothing a company does: family, partner, friends, dating, health and doctors, " +
    "housing and landlords, personal shopping and admin, personal travel, social plans and small talk.",
  other_business:
    "work, but NOT for the brand: a company or project other than the brand (one of otherBrandsOfTheSameOwner, " +
    "or any other company the owner runs, works for or invests in), the owner's job search, or professionals " +
    "handling the owner's own affairs unrelated to the brand.",
  this_brand:
    "about the brand or what it sells: a prospect, client, user, partner, reseller, supplier, investor, " +
    "advisor, journalist or job candidate talking with the owner about the brand, its product, its offers, " +
    "its fundraising, its hiring or its operations.",
};

export interface BrandContext {
  brand: { name: string; website: string | null };
  offers: { offerId: string; name: string; description: string | null }[];
  otherBrandsOfTheSameOwner: { name: string; website: string | null }[];
  hash: string;
}

/** The brand, its active offers and the org's other brands, from brand-service. Fails loud. */
export async function readBrandContext(identity: SiblingIdentity): Promise<BrandContext> {
  const id = encodeURIComponent(identity.brandId);
  const [brand, offers, orgBrands] = await Promise.all([
    siblingGetOk<{ brand: { name: string; domain: string | null; url: string | null } }>("brand", `/internal/brands/${id}`, identity),
    siblingGetOk<{ offers: { offerId: string; name: string; description: string | null; status: string }[] }>(
      "brand",
      `/internal/brands/${id}/offers`,
      identity,
    ),
    siblingGetOk<{ brands: { id: string; name: string | null; domain: string | null }[] }>("brand", "/orgs/brands", identity),
  ]);
  const ctx = {
    brand: { name: brand.brand.name, website: brand.brand.domain ?? brand.brand.url },
    offers: offers.offers
      .filter((o) => o.status === "active")
      .map((o) => ({ offerId: o.offerId, name: o.name, description: o.description }))
      .sort((a, b) => (a.offerId < b.offerId ? -1 : 1)),
    otherBrandsOfTheSameOwner: orgBrands.brands
      .filter((b) => b.id !== identity.brandId)
      .map((b) => ({ name: b.name ?? b.domain ?? "unnamed", website: b.domain }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
  return { ...ctx, hash: createHash("sha256").update(JSON.stringify(ctx)).digest("hex").slice(0, 32) };
}

export interface ConversationMessage {
  at: string | null;
  direction: string;
  subject?: string | null;
  text: string;
}

/** What Jev is shown about one conversation. */
export interface ConversationInput {
  key: string;
  source: "gmail" | "matrix";
  judgedThrough: string;
  channel: string;
  counterpart: { names: string[]; email: string | null; phone: string | null };
  /** Oldest first, the latest MAX_MESSAGES. */
  messages: ConversationMessage[];
}

export interface Verdict {
  topic: Topic;
  confidence: number;
  probabilities: Record<string, number>;
  brandProbability: number;
  offerScores: Record<string, number>;
  offerIds: string[];
}

export interface RecordedVerdict {
  topic: Topic;
  confidence: number;
  brandProbability: number;
  offerIds: string[];
}

/** PURE: the conversation is about something else than the brand, confidently. */
export function hidesConversation(v: { brandProbability: number }): boolean {
  return v.brandProbability < BRAND_MIN_PROBABILITY;
}

const clip = (s: string) => (s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS)}…` : s);

/** One Jev call: the topic choice plus one yes/no per active offer. Fails loud on a malformed answer. */
export async function judgeConversation(
  input: ConversationInput,
  context: BrandContext,
  tracking: ChatTrackingHeaders,
): Promise<Verdict & { model: string }> {
  const state = {
    task:
      "A business owner connected their own inbox. It mixes their private life, their other businesses, and " +
      "conversations about the brand below. Judge what this one conversation is about.",
    brand: context.brand,
    offers: context.offers.map((o, k) => ({ key: `o${k}`, name: o.name, description: o.description })),
    otherBrandsOfTheSameOwner: context.otherBrandsOfTheSameOwner,
    conversation: {
      channel: input.channel,
      counterpart: input.counterpart,
      messages: input.messages.map((m) => ({ ...m, text: clip(m.text) })),
    },
  };
  const questions: Record<string, ChoiceQuestion | NoulQuestion> = {
    topic: {
      type: "choice",
      instructions:
        `Read the conversation between the owner (outbound) and the counterpart (inbound). Is it about the brand ` +
        `${context.brand.name}, about another business, or about the owner's private life? Judge the relationship ` +
        "the whole conversation shows, not one polite or logistical message.",
      criteria: TOPIC_CRITERIA,
    },
  };
  context.offers.forEach((o, k) => {
    questions[`o${k}`] = {
      type: "noul",
      instructions:
        `Is the conversation about the offer offers.o${k} ("${o.name}") of ${context.brand.name}: the counterpart ` +
        "asks about it, buys it, uses it, sells it, invests in it or negotiates it?",
    };
  });
  const result = await judgeQuestions(state, questions, tracking);

  const topic = result.answers.topic;
  if (!topic || topic.type !== "choice") throw new Error(`[crm-service][relevance] ${input.key}: no topic answer`);
  if (!(TOPICS as readonly string[]).includes(topic.choice)) {
    throw new Error(`[crm-service][relevance] ${input.key}: unknown topic "${topic.choice}"`);
  }
  const brandProbability = topic.probabilities?.this_brand;
  if (typeof brandProbability !== "number" || !Number.isFinite(brandProbability) || typeof topic.confidence !== "number") {
    throw new Error(`[crm-service][relevance] ${input.key}: topic came back without its probabilities`);
  }
  const offerScores: Record<string, number> = {};
  context.offers.forEach((o, k) => {
    const a = result.answers[`o${k}`];
    if (!a || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) {
      throw new Error(`[crm-service][relevance] ${input.key}: no answer for offer ${o.offerId}`);
    }
    offerScores[o.offerId] = a.noul;
  });
  const verdict: Verdict = {
    topic: topic.choice as Topic,
    confidence: topic.confidence,
    probabilities: topic.probabilities,
    brandProbability,
    offerScores,
    offerIds: [],
  };
  // An offer is only ever tagged on a conversation that is about the brand.
  verdict.offerIds = hidesConversation(verdict)
    ? []
    : context.offers.filter((o) => offerScores[o.offerId] >= OFFER_MIN_PROBABILITY).map((o) => o.offerId);
  return { ...verdict, model: result.model };
}

// ─── loading what Jev reads ─────────────────────────────────────────────────

interface GmailConversation {
  threads: {
    messages: {
      direction: string;
      fromEmail: string | null;
      subject: string | null;
      snippet: string | null;
      bodyText?: string | null;
      bodyStatus?: string;
      sentAt: string | null;
    }[];
  }[];
}

export interface GmailPlan {
  email: string;
  names: string[];
  judgedThrough: string;
}

/** The latest messages of the org's mailbox with `email`, via google-service. Null = no message to read. */
export async function gmailConversationInput(identity: SiblingIdentity, plan: GmailPlan): Promise<ConversationInput | null> {
  const r = await siblingGet("google", `/orgs/google/conversation?email=${encodeURIComponent(plan.email)}&limit=20`, identity);
  const reason = (r.body as { reason?: string } | null)?.reason;
  if (r.status === 404 && (reason === "no_messages" || reason === "no_google_account_connected")) return null;
  if (r.status !== 200) {
    throw new Error(`google-service conversation for ${plan.email} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const messages = (r.body as GmailConversation).threads
    .flatMap((t) => t.messages)
    .sort((a, b) => ((a.sentAt ?? "") < (b.sentAt ?? "") ? -1 : 1))
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      at: m.sentAt,
      direction: m.direction,
      subject: m.subject,
      text: (m.bodyStatus === "ok" && m.bodyText ? m.bodyText : m.snippet) ?? "",
    }));
  if (messages.length === 0) return null;
  return {
    key: `gmail:${plan.email}`,
    source: "gmail",
    judgedThrough: plan.judgedThrough,
    channel: "email",
    counterpart: { names: plan.names, email: plan.email, phone: null },
    messages,
  };
}

/** Each Matrix conversation's current watermark (its last event id). */
export async function matrixMarkers(conversationIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < conversationIds.length; i += 1000) {
    const rows = await db
      .select({ id: conversations.id, lastEventId: conversations.lastEventId })
      .from(conversations)
      .where(inArray(conversations.id, conversationIds.slice(i, i + 1000)));
    for (const r of rows) out.set(r.id, r.lastEventId);
  }
  return out;
}

/** What Jev reads about one Matrix conversation, from our own bronze (no Matrix call). Null = vanished. */
export async function matrixConversationInput(conversationId: string): Promise<ConversationInput | null> {
  const [row] = await db
    .select({
      conversation: conversations,
      contact: { fullName: contacts.fullName, phone: contacts.phoneE164 },
      ownMxid: matrixConnections.matrixUserId,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(matrixConnections, eq(matrixConnections.id, conversations.connectionId))
    .where(eq(conversations.id, conversationId));
  if (!row) return null;
  const events = await db
    .select({ payload: matrixRawEvents.payload })
    .from(matrixRawEvents)
    .where(and(eq(matrixRawEvents.connectionId, row.conversation.connectionId), eq(matrixRawEvents.roomId, row.conversation.roomId)))
    .orderBy(asc(matrixRawEvents.originServerTs), asc(matrixRawEvents.eventId));
  const lines = renderThread(
    events.map((e) => e.payload as unknown as MatrixEvent),
    row.ownMxid,
    MAX_MESSAGES,
  );
  return {
    key: `matrix:${conversationId}`,
    source: "matrix",
    judgedThrough: row.conversation.lastEventId,
    channel: row.conversation.channel,
    counterpart: { names: row.contact.fullName ? [row.contact.fullName] : [], email: null, phone: row.contact.phone },
    messages: lines.map((l) => ({ at: l.at, direction: l.direction, text: l.body })),
  };
}

// ─── the record ─────────────────────────────────────────────────────────────

export interface StoredVerdict extends RecordedVerdict {
  judgedThrough: string;
  contextHash: string;
}

export async function storedVerdicts(orgId: string, brandId: string, keys: string[]): Promise<Map<string, StoredVerdict>> {
  const out = new Map<string, StoredVerdict>();
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await db
      .select()
      .from(conversationVerdicts)
      .where(
        and(
          eq(conversationVerdicts.orgId, orgId),
          eq(conversationVerdicts.brandId, brandId),
          inArray(conversationVerdicts.conversationKey, keys.slice(i, i + 1000)),
        ),
      );
    for (const r of rows) {
      out.set(r.conversationKey, {
        topic: r.topic as Topic,
        confidence: r.confidence,
        brandProbability: r.brandProbability,
        offerIds: r.offerIds as string[],
        judgedThrough: r.judgedThrough,
        contextHash: r.contextHash,
      });
    }
  }
  return out;
}

/** PURE: a conversation is (re)judged when never judged, when it moved, or when the brand's context changed. */
export function needsJudgment(stored: StoredVerdict | undefined, judgedThrough: string, contextHash: string): boolean {
  return !stored || stored.judgedThrough !== judgedThrough || stored.contextHash !== contextHash;
}

/**
 * Conversations found with nothing to read at this watermark (a correspondent
 * google-service holds no message for): not asked again until they move.
 * In-process only; a restart asks once more.
 */
const nothingToRead = new Map<string, string>();

export interface JudgePassSummary {
  status: "ok" | "failed";
  reused: number;
  judged: number;
  /** Conversations still without a verdict (shown until judged). */
  pending: number;
  model: string | null;
  error: string | null;
}

/**
 * Judge every planned conversation that needs it and record the verdicts.
 * `load` produces what Jev reads (null = nothing to read: left unjudged).
 * A failure leaves that conversation on its previous verdict (or none) and is
 * reported; the rest go on.
 */
export async function judgeAndRecord<P>(
  identity: SiblingIdentity,
  context: BrandContext,
  plans: { key: string; judgedThrough: string; plan: P }[],
  load: (plan: P) => Promise<ConversationInput | null>,
): Promise<{ verdicts: Map<string, RecordedVerdict>; summary: JudgePassSummary }> {
  const stored = await storedVerdicts(identity.orgId, identity.brandId, plans.map((p) => p.key));
  const verdicts = new Map<string, RecordedVerdict>();
  const todo = plans.filter(
    (p) =>
      needsJudgment(stored.get(p.key), p.judgedThrough, context.hash) &&
      nothingToRead.get(`${identity.orgId}|${identity.brandId}|${p.key}`) !== p.judgedThrough,
  );
  for (const p of plans) {
    const s = stored.get(p.key);
    if (s) verdicts.set(p.key, s);
  }
  const todoKeys = new Set(todo.map((p) => p.key));
  const reused = plans.filter((p) => stored.has(p.key) && !todoKeys.has(p.key)).length;
  const tracking: ChatTrackingHeaders = {
    orgId: identity.orgId,
    userId: identity.userId,
    runId: identity.runId,
    brandIds: [identity.brandId],
  };
  const errors: string[] = [];
  let judged = 0;
  let model: string | null = null;
  await mapLimit(todo, CONCURRENCY, async (p) => {
    try {
      const input = await load(p.plan);
      if (!input) {
        nothingToRead.set(`${identity.orgId}|${identity.brandId}|${p.key}`, p.judgedThrough);
        return;
      }
      const v = await judgeConversation(input, context, tracking);
      model = v.model;
      const values = {
        orgId: identity.orgId,
        brandId: identity.brandId,
        conversationKey: p.key,
        source: input.source,
        topic: v.topic,
        confidence: v.confidence,
        probabilities: v.probabilities,
        brandProbability: v.brandProbability,
        offerScores: v.offerScores,
        offerIds: v.offerIds,
        contextHash: context.hash,
        judgedThrough: p.judgedThrough,
        input,
        model: v.model,
        runId: identity.runId,
        judgedAt: new Date(),
      };
      const { orgId: _o, brandId: _b, conversationKey: _k, ...set } = values;
      await db
        .insert(conversationVerdicts)
        .values(values)
        .onConflictDoUpdate({
          target: [conversationVerdicts.orgId, conversationVerdicts.brandId, conversationVerdicts.conversationKey],
          set,
        });
      verdicts.set(p.key, { topic: v.topic, confidence: v.confidence, brandProbability: v.brandProbability, offerIds: v.offerIds });
      judged++;
    } catch (err) {
      if (errors.length < 3) errors.push(`${p.key}: ${(err as Error).message}`);
    }
  });
  const pending = plans.filter((p) => !verdicts.has(p.key)).length;
  return {
    verdicts,
    summary: {
      status: errors.length ? "failed" : "ok",
      reused,
      judged,
      pending,
      model,
      error: errors.length ? errors.join(" | ").slice(0, 1000) : null,
    },
  };
}

// ─── the person layer ───────────────────────────────────────────────────────

/** Sources a brand owner connects as THEMSELVES: their own mailbox, their own messaging accounts. */
export const PERSONAL_CHANNEL_SOURCES = new Set(["gmail", "matrix"]);
/** Evidence that the person is a business relationship of record. */
const BUSINESS_EVIDENCE = new Set(["gohighlevel_contact", "csv_contact", "lead_pairing", "stripe_customer"]);

interface PersonLike {
  presences: { source: string; emails: string[]; displayName: string | null; lastActivityAt: string | null; messageCount: number | null; detail: Record<string, unknown> }[];
  evidence?: { kind: string }[];
}

/** PURE: the conversation keys a person's personal-channel presences carry. */
export function conversationKeysOf(person: PersonLike): string[] {
  const keys = new Set<string>();
  for (const p of person.presences) {
    if (p.source === "gmail") for (const e of p.emails) keys.add(`gmail:${e}`);
    if (p.source === "matrix" && typeof p.detail.conversationId === "string") keys.add(`matrix:${p.detail.conversationId}`);
  }
  return [...keys];
}

/**
 * PURE: the person is known from personal channels ALONE: no cold email, no
 * CRM / CSV / Stripe / PostHog record, no lead-service lead. Only such a person
 * may be hidden by this filter.
 */
export function isPersonalChannelOnly(person: PersonLike, isOurLead: boolean): boolean {
  if (isOurLead || person.presences.length === 0) return false;
  if (!person.presences.every((p) => PERSONAL_CHANNEL_SOURCES.has(p.source))) return false;
  return !(person.evidence ?? []).some((e) => BUSINESS_EVIDENCE.has(e.kind));
}

export interface PersonRelevance {
  notBusiness: boolean;
  offerIds: string[];
  relevance: {
    conversation: string;
    topic: Topic | null;
    confidence: number | null;
    brandProbability: number | null;
    offerIds: string[];
  }[] | null;
}

/**
 * PURE: hidden when the person is personal-channel-only and Jev judged EVERY
 * one of their conversations not about the brand. One unjudged conversation
 * keeps them visible.
 */
export function personRelevance(person: PersonLike, verdicts: Map<string, RecordedVerdict>, isOurLead: boolean): PersonRelevance {
  const keys = conversationKeysOf(person);
  if (keys.length === 0) return { notBusiness: false, offerIds: [], relevance: null };
  const relevance = keys.map((k) => {
    const v = verdicts.get(k);
    return v
      ? { conversation: k, topic: v.topic, confidence: v.confidence, brandProbability: v.brandProbability, offerIds: v.offerIds }
      : { conversation: k, topic: null, confidence: null, brandProbability: null, offerIds: [] };
  });
  const notBusiness =
    isPersonalChannelOnly(person, isOurLead) &&
    keys.every((k) => {
      const v = verdicts.get(k);
      return !!v && hidesConversation(v);
    });
  const offerIds = [...new Set(relevance.flatMap((r) => r.offerIds))].sort();
  return { notBusiness, offerIds, relevance };
}

export interface RelevanceSummary extends JudgePassSummary {
  conversations: number;
  topics: Record<Topic, number>;
  /** People hidden as not about the brand by this build. */
  notBusinessPeople: number;
  contextHash: string | null;
}

/**
 * The verdict of every personal-channel conversation of `persons`: recorded
 * ones reused, the new / moved ones judged now. Gmail is only read when the
 * mailbox is readable; brand-service down = judge nothing, keep the record.
 */
export async function resolvePeopleRelevance(
  identity: SiblingIdentity,
  persons: PersonLike[],
  gmailReadable: boolean,
): Promise<{ verdicts: Map<string, RecordedVerdict>; summary: Omit<RelevanceSummary, "notBusinessPeople"> }> {
  const gmail = new Map<string, GmailPlan>();
  const matrixIds = new Set<string>();
  for (const person of persons) {
    for (const p of person.presences) {
      if (p.source === "gmail") {
        for (const email of p.emails) {
          const plan = gmail.get(email) ?? { email, names: [], judgedThrough: `${p.lastActivityAt ?? ""}|${p.messageCount ?? 0}` };
          if (p.displayName && !plan.names.includes(p.displayName)) plan.names.push(p.displayName);
          gmail.set(email, plan);
        }
      }
      if (p.source === "matrix" && typeof p.detail.conversationId === "string") matrixIds.add(p.detail.conversationId);
    }
  }
  const keys = [...[...gmail.keys()].map((e) => `gmail:${e}`), ...[...matrixIds].map((id) => `matrix:${id}`)];
  const topicsOf = (verdicts: Map<string, RecordedVerdict>) => {
    const topics = Object.fromEntries(TOPICS.map((t) => [t, 0])) as Record<Topic, number>;
    for (const v of verdicts.values()) topics[v.topic] += 1;
    return topics;
  };
  if (keys.length === 0) {
    return {
      verdicts: new Map(),
      summary: { status: "ok", reused: 0, judged: 0, pending: 0, model: null, error: null, conversations: 0, topics: topicsOf(new Map()), contextHash: null },
    };
  }

  let context: BrandContext;
  try {
    context = await readBrandContext(identity);
  } catch (err) {
    const verdicts = new Map<string, RecordedVerdict>(await storedVerdicts(identity.orgId, identity.brandId, keys));
    return {
      verdicts,
      summary: {
        status: "failed",
        reused: verdicts.size,
        judged: 0,
        pending: keys.length - verdicts.size,
        model: null,
        error: `brand context: ${(err as Error).message}`.slice(0, 1000),
        conversations: keys.length,
        topics: topicsOf(verdicts),
        contextHash: null,
      },
    };
  }

  const markers = await matrixMarkers([...matrixIds]);
  type Plan = { kind: "gmail"; gmail: GmailPlan } | { kind: "matrix"; id: string };
  // An unreadable mailbox judges no Gmail thread: its recorded verdicts still apply.
  const plans: { key: string; judgedThrough: string; plan: Plan }[] = [
    ...[...gmail.values()].filter(() => gmailReadable).map((g) => ({ key: `gmail:${g.email}`, judgedThrough: g.judgedThrough, plan: { kind: "gmail" as const, gmail: g } })),
    ...[...matrixIds]
      .filter((id) => markers.has(id))
      .map((id) => ({ key: `matrix:${id}`, judgedThrough: markers.get(id)!, plan: { kind: "matrix" as const, id } })),
  ];
  const { verdicts, summary } = await judgeAndRecord(identity, context, plans, (plan) =>
    plan.kind === "gmail" ? gmailConversationInput(identity, plan.gmail) : matrixConversationInput(plan.id),
  );
  if (!gmailReadable && gmail.size > 0) {
    const recorded = await storedVerdicts(identity.orgId, identity.brandId, [...gmail.keys()].map((e) => `gmail:${e}`));
    for (const [k, v] of recorded) verdicts.set(k, v);
    summary.pending = keys.filter((k) => !verdicts.has(k)).length;
  }
  return {
    verdicts,
    summary: { ...summary, conversations: keys.length, topics: topicsOf(verdicts), contextHash: context.hash },
  };
}
