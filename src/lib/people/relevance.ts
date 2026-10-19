/**
 * Is a conversation from the owner's PERSONAL channels with a SALES LEAD of THIS brand?
 *
 * A brand owner connects their own Gmail and their own WhatsApp (any
 * Matrix-bridged channel). Those inboxes hold family, friends, doctors,
 * landlords, suppliers, the accountant, and the owner's OTHER companies. The
 * owner wants to see only the brand's sales leads (prospects, clients, users,
 * referral partners), and never wants their private life read as sales data. So every such conversation is judged on three levels, in ONE Jev
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
 * BRAND_MIN_PROBABILITY. A conversation never judged (Jev down, brand-service
 * down) is SHOWN: nothing disappears because a sibling failed.
 *
 * A third case is recorded, not judged: NO CONTENT. Once the bridge's own
 * notices ("Old photo. Media will be requested…", "Failed to bridge voice
 * message…") and uncaptioned media are dropped (matrix/events.ts `humanText`,
 * on the event's structure) and empty mails are dropped, nothing a person
 * wrote is left. Shown to Jev, such a thread came back "this brand" at
 * 0.47-0.83 for lack of anything else to say (2026-10-10: ~9 of 15 sampled
 * WhatsApp threads between 0.15 and 0.85). Nothing to read is no evidence the
 * conversation is about the brand, so it is recorded `content = 'none'`
 * without a Jev call and never keeps a personal-channel-only person visible.
 *
 * WA-LEAD-RELEVANCE-1016 (2026-10-16): an owner runs SEVERAL activities from one
 * personal WhatsApp (residency help, co-living rooms, teaching, coaching) and
 * vendors pitch them there. Asked only "a lead of this brand?", Jev read every
 * deal the owner discussed as the brand's (Brazil visa 0.81, co-living 0.50,
 * a no2bounce vendor pitch 0.87). The question now makes Jev name what is
 * traded and who sells to whom, and the criteria name suppliers selling to the
 * owner and the owner's other activities as other work.
 *
 * WHO is hidden is decided in people/build.ts: only a person known from
 * personal channels ALONE. A person also known from a business source (our
 * cold email, a lead, the CRM, Stripe) is never hidden by this.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contacts, conversations, conversationVerdicts, matrixConnections, matrixRawEvents } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeQuestions, type ChoiceQuestion, type NoulQuestion } from "../judgments-client.js";
import type { MatrixEvent } from "../matrix/client.js";
import { renderThread } from "../matrix/events.js";
import { overlayVoiceTranscripts } from "../matrix/voice-notes.js";
import { mapLimit, siblingGet, siblingGetOk, type SiblingIdentity } from "./siblings.js";
import { accountUserView, readAccountUsers, userIdsOf, type AccountUserView, type AccountUsers } from "./account-users.js";
import { CONNECTION_TAGS, tagQuestionText, tagsFromScores, type ConnectionTag, type TagScores } from "./connection-tags.js";

export const TOPICS = ["personal", "other_business", "this_brand"] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * A conversation is hidden when Jev puts "about this brand" BELOW this
 * probability: Jev finds personal life or another business more likely.
 * Owner, 2026-10-10: "Seuil Jev a 50% non?" (was 0.15 in v0.29.2, which kept
 * 113 of 268 WhatsApp-only people of the first brand visible on thin threads).
 */
export const BRAND_MIN_PROBABILITY = 0.5;
/** An offer is tagged when Jev's yes-probability reaches this. */
export const OFFER_MIN_PROBABILITY = 0.5;

const CONCURRENCY = 4;
/**
 * What Jev reads of a long thread: its FIRST messages (where a deal's subject is
 * usually stated: a visa named 20 messages before "Fast track") and its LATEST
 * ones (where the relationship stands now). The latest 10 alone read Faysal's
 * Brazil residency as a lead (WA-LEAD-RELEVANCE-1016).
 */
const FIRST_MESSAGES = 10;
const LAST_MESSAGES = 20;
const MESSAGE_CHARS = 400;

/**
 * The owner keeps ONE kind of conversation: a SALES LEAD of the brand (owner,
 * 2026-10-10: "je veux que mes sales lead"). Every other work thread (supplier,
 * accountant, mentor, investor, press, candidate) is `other_business` and is
 * hidden like private life. This replaces v0.29.2's rule that kept suppliers,
 * the accountant and mentors visible. The keys stay as served (`this_brand`
 * now reads "a sales lead of this brand").
 */
const TOPIC_CRITERIA: Record<Topic, string> = {
  personal:
    "the owner's PRIVATE life: family, partner, friends, dating, health, housing, personal shopping and " +
    "admin, personal travel, social plans, small talk, community or hobby groups.",
  other_business:
    "work that is NOT a sale of this brand's offers. (1) The counterpart is the SELLER and the owner the " +
    "buyer: a supplier, software tool, agency or vendor pitching or selling ITS OWN product or service to " +
    "the owner, even a product in the brand's own field (an email tool, a lead list, a marketing agency " +
    "pitching the owner is a supplier, not a lead). (2) The owner's OTHER activities: anything the owner " +
    "sells, rents, teaches, organises or recruits for that is not one of this brand's offers (for example " +
    "residency or visa help, housing, rooms or co-living, courses, coaching or training, a job or community " +
    "they recruit for), even when money, a deal or a contract is discussed. (3) The accountant, lawyer, " +
    "bank and the company's own admin; mentors, advisors, investors, journalists and press, candidates, " +
    "networking contacts; and work inside another company the owner runs or is employed by.",
  this_brand:
    "the counterpart is a SALES LEAD of the brand: someone the owner sells THIS brand's offers to, or who " +
    "buys, uses, asks about, tries or negotiates THEM: a prospect, a client, a user, or a partner who refers " +
    "or resells clients to the brand. A CLIENT or user stays a sales lead while the owner delivers the " +
    "brand's offers to them: their account, campaigns, credits, billing, results, feature requests, advice " +
    "on their own sales, a pause or a churn. The test is what is traded: it must be what this brand sells " +
    "(its description and offers), shown in the words. A deal about something else the owner does is not a " +
    "lead of this brand, and a thread with nothing about buying or using the brand (greetings, emojis, " +
    "\"ok\") is not a sales lead.",
};

export interface BrandContext {
  brand: { name: string; website: string | null; description: string | null };
  offers: { offerId: string; name: string; description: string | null; profile?: Record<string, string> | null }[];
  otherBrandsOfTheSameOwner: { name: string; website: string | null }[];
  hash: string;
}

/** The brand, its active offers and the org's other brands, from brand-service. Fails loud. */
export async function readBrandContext(identity: SiblingIdentity): Promise<BrandContext> {
  const id = encodeURIComponent(identity.brandId);
  const [brand, offers, orgBrands, fields] = await Promise.all([
    siblingGetOk<{ brand: { name: string; domain: string | null; url: string | null } }>("brand", `/internal/brands/${id}`, identity),
    siblingGetOk<{ offers: { offerId: string; name: string; description: string | null; status: string }[] }>(
      "brand",
      `/internal/brands/${id}/offers`,
      identity,
    ),
    siblingGetOk<{ brands: { id: string; name: string | null; domain: string | null }[] }>("brand", "/orgs/brands", identity),
    siblingGetOk<{ fields: { key: string; value: unknown }[] }>("brand", `/internal/brands/${id}/extracted-fields`, identity),
  ]);
  const overview = fields.fields.find((f) => f.key === "companyOverview")?.value;
  const active = offers.offers.filter((o) => o.status === "active");
  const profiles = await Promise.all(active.map((o) => readOfferProfile(identity, o.offerId)));
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
  // The description is re-extracted every few days in different words: it is shown to
  // Jev but kept OUT of the hash, so a re-extraction never re-judges every conversation.
  // The offers' profiles too: what each offer IS, worded like the description (re-extracted, out of the hash).
  const profileOf = new Map(active.map((o, k) => [o.offerId, profiles[k]]));
  return {
    ...ctx,
    brand: { ...ctx.brand, description: typeof overview === "string" && overview.trim() ? overview.trim() : null },
    offers: ctx.offers.map((o) => ({ ...o, profile: profileOf.get(o.offerId) ?? null })),
    // v6 (2026-10-10): sales leads only. v7 (WA-LEAD-RELEVANCE-1016): the owner's other
    // activities and suppliers selling to the owner are other work. Each bump re-judges once.
    // v8 (CONNECTION-TAGS-1017): the four connection tags + who the user is.
    hash: createHash("sha256").update(JSON.stringify(["v8", ctx])).digest("hex").slice(0, 32),
  };
}

const PROFILE_FIELD_CHARS = 600;

/**
 * What ONE offer sells, in the brand's own words: brand-service's brand profile
 * for that offer (the confirmed fields over the extracted ones). Without it Jev
 * judged "a lead of Distribute.you" knowing only the brand name and an offer
 * called "Product-led", so any deal the owner discussed read as the brand's
 * (WA-LEAD-RELEVANCE-1016). Null = brand-service holds no profile. Fails loud.
 */
async function readOfferProfile(identity: SiblingIdentity, offerId: string): Promise<Record<string, string> | null> {
  const body = await siblingGetOk<{ brandProfile: { fields: Record<string, string | string[]> } | null }>(
    "brand",
    `/internal/brands/${encodeURIComponent(identity.brandId)}/runtime-context?offerId=${encodeURIComponent(offerId)}`,
    identity,
  );
  const fields = body.brandProfile?.fields;
  if (!fields) return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    const v = fields[key];
    const text = (Array.isArray(v) ? v.join("; ") : String(v ?? "")).trim();
    if (text) out[key] = clipTo(text, PROFILE_FIELD_CHARS);
  }
  return Object.keys(out).length ? out : null;
}

export interface ConversationMessage {
  at: string | null;
  direction: string;
  subject?: string | null;
  text: string;
}

/** What the brand's own tools already know about the counterpart (no model). */
export interface PersonView {
  /** The brand's sources holding the person: gohighlevel, stripe, clerk, posthog, instantly... */
  knownBy: string[];
  company: string | null;
  emailDomains: string[];
}

/** What Jev is shown about one conversation. */
export interface ConversationInput {
  key: string;
  source: "gmail" | "matrix";
  judgedThrough: string;
  channel: string;
  /** A one-to-one thread on the user's own account (groups are judged in people/group-tags.ts). */
  kind?: "direct";
  counterpart: { names: string[]; email: string | null; phone: string | null };
  /** The user who connected the account: who "personal to user" is about (CONNECTION-TAGS-1017). */
  user?: AccountUserView | null;
  /** The user ids behind `user`, recorded on the verdict (never shown to Jev). */
  userIds?: string[];
  person?: PersonView | null;
  /** Oldest first, `threadWindow` of the messages holding words a person wrote. Empty = nothing to judge. */
  messages: ConversationMessage[];
}

/** PURE: the first FIRST_MESSAGES and the last LAST_MESSAGES of a thread, oldest first, none twice. */
export function threadWindow<T>(messages: T[]): T[] {
  if (messages.length <= FIRST_MESSAGES + LAST_MESSAGES) return messages;
  return [...messages.slice(0, FIRST_MESSAGES), ...messages.slice(-LAST_MESSAGES)];
}

export interface Verdict {
  topic: Topic;
  confidence: number;
  probabilities: Record<string, number>;
  brandProbability: number;
  offerScores: Record<string, number>;
  offerIds: string[];
  tagScores: TagScores;
  tags: ConnectionTag[];
}

export type Content = "readable" | "none";

/** `content = 'none'`: nothing a person wrote to judge, so no topic, confidence or probability. */
export interface RecordedVerdict {
  content: Content;
  topic: Topic | null;
  confidence: number | null;
  brandProbability: number | null;
  offerIds: string[];
  /** CONNECTION-TAGS-1017. Null on a verdict recorded before the tags (re-judged on the next pass). */
  tags: ConnectionTag[] | null;
  tagScores: TagScores | null;
  userIds: string[];
}

/**
 * PURE: the conversation is no evidence the person is about the brand: Jev
 * judged it more likely personal or another business, or there is nothing a
 * person wrote in it to judge.
 */
export function hidesConversation(v: { content?: Content; brandProbability: number | null }): boolean {
  if (v.content === "none") return true;
  return v.brandProbability !== null && v.brandProbability < BRAND_MIN_PROBABILITY;
}

/**
 * PURE: at most MESSAGE_CHARS characters, cut on a code point (never inside an
 * emoji's surrogate pair) and well-formed: Jev refuses a request holding a lone
 * surrogate ("invalid Unicode text", 2 WhatsApp threads on the first backfill).
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function clip(s: string): string {
  return clipTo(s, MESSAGE_CHARS);
}
function clipTo(s: string, max: number): string {
  const chars = Array.from(s.replace(LONE_SURROGATE, "\uFFFD"));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** One Jev call: the topic choice plus one yes/no per active offer. Fails loud on a malformed answer. */
export async function judgeConversation(
  input: ConversationInput,
  context: BrandContext,
  tracking: ChatTrackingHeaders,
): Promise<Verdict & { model: string }> {
  const state = {
    task:
      "A business owner connected their own inbox. It mixes their private life, the suppliers who sell to " +
      "them, their OTHER activities (the owner often runs several: services, rentals, teaching, jobs), and " +
      "conversations with the sales leads of the brand below. Judge whether the counterpart in this one " +
      "conversation is a sales lead of THIS brand: someone who could buy, or buys, what this brand sells.",
    brand: context.brand,
    offers: context.offers.map((o, k) => ({ key: `o${k}`, name: o.name, description: o.description, whatItSells: o.profile ?? null })),
    otherBrandsOfTheSameOwner: context.otherBrandsOfTheSameOwner,
    user: input.user ?? null,
    counterpartKnownByTheBrand: input.person ?? null,
    conversation: {
      kind: "direct, one to one, on the user's own account",
      channel: input.channel,
      counterpart: { ...input.counterpart, names: input.counterpart.names.map(clip) },
      messages: input.messages.map((m) => ({ ...m, subject: m.subject ? clip(m.subject) : m.subject, text: clip(m.text) })),
    },
  };
  const questions: Record<string, ChoiceQuestion | NoulQuestion> = {
    topic: {
      type: "choice",
      instructions:
        "Read the conversation between the owner (outbound) and the counterpart (inbound): who pays whom, " +
        `for what? A counterpart who buys, uses, tries or is offered what ${context.brand.name} sells (its ` +
        "description and offers in the state) is its sales lead, and a client stays one while the owner runs " +
        "their account, campaigns, credits or billing, whatever else they chat about (tools, ideas, small " +
        "talk). A counterpart selling to the owner, or a deal about something this brand does not sell (another " +
        "activity of the owner), is other work, even when the owner writes first or money is discussed; " +
        "accountant, mentor, investor and press are other work too; the owner's private life is personal. " +
        "Judge the whole conversation, not one polite or logistical message.",
      criteria: TOPIC_CRITERIA,
    },
  };
  for (const tag of CONNECTION_TAGS) {
    questions[`t_${tag}`] = { type: "noul", instructions: tagQuestionText(tag, context.brand.name) };
  }
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
  const tagScores = readTagScores(result.answers, input.key);
  const verdict: Verdict = {
    topic: topic.choice as Topic,
    confidence: topic.confidence,
    probabilities: topic.probabilities,
    brandProbability,
    offerScores,
    offerIds: [],
    tagScores,
    tags: tagsFromScores(tagScores),
  };
  // An offer is only ever tagged on a conversation that is about the brand.
  verdict.offerIds = hidesConversation(verdict)
    ? []
    : context.offers.filter((o) => offerScores[o.offerId] >= OFFER_MIN_PROBABILITY).map((o) => o.offerId);
  return { ...verdict, model: result.model };
}

/** The four `t_<tag>` yes-probabilities of a judgment. Fails loud on a missing or malformed one. */
export function readTagScores(answers: Record<string, unknown>, key: string): TagScores {
  const out = {} as TagScores;
  for (const tag of CONNECTION_TAGS) {
    const a = answers[`t_${tag}`] as { type?: string; noul?: unknown } | undefined;
    if (!a || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) {
      throw new Error(`[crm-service][connection-tags] ${key}: no answer for tag ${tag}`);
    }
    out[tag] = a.noul;
  }
  return out;
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

/**
 * The latest messages of the org's mailbox with `email`, via google-service.
 * Null = google-service holds no message; a message with neither subject nor
 * text is dropped, so `messages: []` = messages exist, no words in them.
 */
export async function gmailConversationInput(identity: SiblingIdentity, plan: GmailPlan): Promise<ConversationInput | null> {
  const r = await siblingGet("google", `/orgs/google/conversation?email=${encodeURIComponent(plan.email)}&limit=20`, identity);
  const reason = (r.body as { reason?: string } | null)?.reason;
  if (r.status === 404 && (reason === "no_messages" || reason === "no_google_account_connected")) return null;
  if (r.status !== 200) {
    throw new Error(`google-service conversation for ${plan.email} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const all = (r.body as GmailConversation).threads.flatMap((t) => t.messages);
  if (all.length === 0) return null;
  const messages = all
    .sort((a, b) => ((a.sentAt ?? "") < (b.sentAt ?? "") ? -1 : 1))
    .map((m) => ({
      at: m.sentAt,
      direction: m.direction,
      subject: m.subject,
      text: ((m.bodyStatus === "ok" && m.bodyText ? m.bodyText : m.snippet) ?? "").trim(),
    }))
    .filter((m) => m.text || m.subject?.trim());
  return {
    key: `gmail:${plan.email}`,
    source: "gmail",
    judgedThrough: plan.judgedThrough,
    channel: "email",
    kind: "direct",
    counterpart: { names: plan.names, email: plan.email, phone: null },
    messages: threadWindow(messages),
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
export async function matrixConversationInput(conversationId: string): Promise<(ConversationInput & { connectionId: string }) | null> {
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
  const lines = threadWindow(
    renderThread(
      await overlayVoiceTranscripts(events.map((e) => e.payload as unknown as MatrixEvent)),
      row.ownMxid,
      Number.POSITIVE_INFINITY,
    ),
  );
  return {
    key: `matrix:${conversationId}`,
    source: "matrix",
    judgedThrough: row.conversation.lastEventId,
    channel: row.conversation.channel,
    kind: "direct",
    connectionId: row.conversation.connectionId,
    counterpart: { names: row.contact.fullName ? [row.contact.fullName] : [], email: null, phone: row.contact.phone },
    messages: lines.map((l) => ({ at: l.at, direction: l.direction, text: l.body })),
  };
}

/**
 * The Matrix conversations to judge, keyed and hashed the SAME way by every caller (the people
 * build and the Matrix sync's lead-reading gate): two hashes would re-judge each thread on
 * every pass, one caller undoing the other.
 */
export function matrixPlans(
  ids: string[],
  markers: Map<string, string>,
  context: BrandContext,
  users: AccountUsers,
): { key: string; judgedThrough: string; plan: string; contextHash: string }[] {
  return ids
    .filter((id) => markers.has(id))
    .map((id) => ({ key: `matrix:${id}`, judgedThrough: markers.get(id)!, plan: id, contextHash: `${context.hash}|${users.hash.matrix}` }));
}

/** What Jev reads about one Matrix conversation: the thread, the account's user, what the brand knows of the person. */
export function matrixLoader(users: AccountUsers, views: Map<string, PersonView>) {
  return async (conversationId: string): Promise<ConversationInput | null> => {
    const input = await matrixConversationInput(conversationId);
    if (!input) return null;
    const { connectionId, ...rest } = input;
    const acc = users.matrix.get(connectionId);
    return {
      ...rest,
      user: acc ? accountUserView(acc.channel, acc.account, [acc.user]) : null,
      userIds: acc ? userIdsOf([acc.user]) : [],
      person: views.get(input.key) ?? null,
    };
  };
}

/** What the brand's tools know about the people holding these Matrix conversations, from the last people build. */
export async function personViewsOfConversations(orgId: string, brandId: string, ids: string[]): Promise<Map<string, PersonView>> {
  const out = new Map<string, PersonView>();
  for (const id of ids) {
    const rows = (await db.execute(sql`
      SELECT presences, merge_evidence FROM people
      WHERE org_id = ${orgId} AND brand_id = ${brandId}
        AND presences @> ${JSON.stringify([{ detail: { conversationId: id } }])}::jsonb
      LIMIT 1
    `)) as unknown as { presences: PersonLike["presences"]; merge_evidence: { kind: string }[] | null }[];
    if (rows[0]) out.set(`matrix:${id}`, personView({ presences: rows[0].presences, evidence: rows[0].merge_evidence ?? [] }));
  }
  return out;
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
        content: r.content as Content,
        topic: r.topic as Topic | null,
        confidence: r.confidence,
        brandProbability: r.brandProbability,
        offerIds: r.offerIds as string[],
        tags: (r.tags as ConnectionTag[] | null) ?? null,
        tagScores: (r.tagScores as TagScores | null) ?? null,
        userIds: (r.accountUserIds as string[] | null) ?? [],
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
  /** Of `judged`'s pass: conversations recorded with nothing a person wrote (no Jev call). */
  noContent: number;
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
  plans: { key: string; judgedThrough: string; plan: P; contextHash?: string }[],
  load: (plan: P) => Promise<ConversationInput | null>,
): Promise<{ verdicts: Map<string, RecordedVerdict>; summary: JudgePassSummary; nothingToRead: Set<string> }> {
  const stored = await storedVerdicts(identity.orgId, identity.brandId, plans.map((p) => p.key));
  const verdicts = new Map<string, RecordedVerdict>();
  const hashOf = (p: { contextHash?: string }) => p.contextHash ?? context.hash;
  const todo = plans.filter(
    (p) =>
      needsJudgment(stored.get(p.key), p.judgedThrough, hashOf(p)) &&
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
  let noContent = 0;
  let model: string | null = null;
  await mapLimit(todo, CONCURRENCY, async (p) => {
    try {
      const input = await load(p.plan);
      if (!input) {
        nothingToRead.set(`${identity.orgId}|${identity.brandId}|${p.key}`, p.judgedThrough);
        return;
      }
      if (input.messages.length === 0) {
        // Nothing a person wrote: recorded as such, no Jev call (see the header).
        const values = {
          orgId: identity.orgId,
          brandId: identity.brandId,
          conversationKey: p.key,
          source: input.source,
          content: "none" as const,
          topic: null,
          confidence: null,
          probabilities: null,
          brandProbability: null,
          offerScores: null,
          offerIds: [],
          tagScores: null,
          tags: null,
          accountUserIds: input.userIds ?? [],
          contextHash: hashOf(p),
          judgedThrough: p.judgedThrough,
          input,
          model: null,
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
        verdicts.set(p.key, {
          content: "none",
          topic: null,
          confidence: null,
          brandProbability: null,
          offerIds: [],
          tags: null,
          tagScores: null,
          userIds: input.userIds ?? [],
        });
        noContent++;
        return;
      }
      const v = await judgeConversation(input, context, tracking);
      model = v.model;
      const values = {
        orgId: identity.orgId,
        brandId: identity.brandId,
        conversationKey: p.key,
        source: input.source,
        content: "readable" as const,
        topic: v.topic,
        confidence: v.confidence,
        probabilities: v.probabilities,
        brandProbability: v.brandProbability,
        offerScores: v.offerScores,
        offerIds: v.offerIds,
        tagScores: v.tagScores,
        tags: v.tags,
        accountUserIds: input.userIds ?? [],
        contextHash: hashOf(p),
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
      verdicts.set(p.key, {
        content: "readable",
        topic: v.topic,
        confidence: v.confidence,
        brandProbability: v.brandProbability,
        offerIds: v.offerIds,
        tags: v.tags,
        tagScores: v.tagScores,
        userIds: input.userIds ?? [],
      });
      judged++;
    } catch (err) {
      if (errors.length < 3) errors.push(`${p.key}: ${(err as Error).message}`);
    }
  });
  const pending = plans.filter((p) => !verdicts.has(p.key)).length;
  return {
    // Unjudged because the sibling holds no message at this watermark (not a failure).
    nothingToRead: new Set(
      plans.filter((p) => !verdicts.has(p.key) && nothingToRead.get(`${identity.orgId}|${identity.brandId}|${p.key}`) === p.judgedThrough).map((p) => p.key),
    ),
    verdicts,
    summary: {
      status: errors.length ? "failed" : "ok",
      reused,
      judged,
      noContent,
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
  presences: {
    source: string;
    emails: string[];
    displayName: string | null;
    company?: string | null;
    lastActivityAt: string | null;
    messageCount: number | null;
    detail: Record<string, unknown>;
  }[];
  evidence?: { kind: string }[];
}

/** PURE: what the brand's own tools know about a person, shown to Jev beside the conversation. */
export function personView(person: PersonLike): PersonView {
  const knownBy = new Set<string>();
  for (const p of person.presences) if (!PERSONAL_CHANNEL_SOURCES.has(p.source)) knownBy.add(p.source);
  for (const e of person.evidence ?? []) if (e.kind === "csv_contact") knownBy.add("csv");
  const domains = new Set<string>();
  for (const p of person.presences) for (const e of p.emails) domains.add(e.slice(e.indexOf("@") + 1));
  return {
    knownBy: [...knownBy].sort(),
    company: person.presences.map((p) => p.company ?? null).find((c) => !!c?.trim()) ?? null,
    emailDomains: [...domains].sort(),
  };
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
    /** null = not judged yet. */
    content: Content | null;
    topic: Topic | null;
    confidence: number | null;
    brandProbability: number | null;
    offerIds: string[];
  }[] | null;
}

/**
 * PURE: hidden when the person is personal-channel-only and EVERY one of their
 * conversations is either judged not about the brand or holds nothing a person
 * wrote. One unjudged conversation keeps them visible.
 */
export function personRelevance(person: PersonLike, verdicts: Map<string, RecordedVerdict>, isOurLead: boolean): PersonRelevance {
  const keys = conversationKeysOf(person);
  if (keys.length === 0) return { notBusiness: false, offerIds: [], relevance: null };
  const relevance = keys.map((k) => {
    const v = verdicts.get(k);
    return v
      ? { conversation: k, content: v.content, topic: v.topic, confidence: v.confidence, brandProbability: v.brandProbability, offerIds: v.offerIds }
      : { conversation: k, content: null, topic: null, confidence: null, brandProbability: null, offerIds: [] };
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
  /** Recorded verdicts with nothing a person wrote in the conversation (all of them, not only this pass). */
  contentFree: number;
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
): Promise<{
  verdicts: Map<string, RecordedVerdict>;
  summary: Omit<RelevanceSummary, "notBusinessPeople">;
  /** What the pass judged against; null when it could not be read (nothing judged). */
  context: BrandContext | null;
  /** Conversations with no message to read (a Gmail correspondent google-service holds nothing for). */
  nothingToRead: Set<string>;
  users: AccountUsers | null;
}> {
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
    for (const v of verdicts.values()) if (v.topic) topics[v.topic] += 1;
    return topics;
  };
  const contentFreeOf = (verdicts: Map<string, RecordedVerdict>) => [...verdicts.values()].filter((v) => v.content === "none").length;
  if (keys.length === 0) {
    return {
      context: null,
      users: null,
      nothingToRead: new Set(),
      verdicts: new Map(),
      summary: {
        status: "ok",
        reused: 0,
        judged: 0,
        noContent: 0,
        pending: 0,
        model: null,
        error: null,
        conversations: 0,
        topics: topicsOf(new Map()),
        contentFree: 0,
        contextHash: null,
      },
    };
  }

  let context: BrandContext;
  let users: AccountUsers;
  try {
    [context, users] = await Promise.all([readBrandContext(identity), readAccountUsers(identity, gmailReadable)]);
  } catch (err) {
    const verdicts = new Map<string, RecordedVerdict>(await storedVerdicts(identity.orgId, identity.brandId, keys));
    return {
      context: null,
      users: null,
      nothingToRead: new Set(),
      verdicts,
      summary: {
        status: "failed",
        reused: verdicts.size,
        judged: 0,
        noContent: 0,
        pending: keys.length - verdicts.size,
        model: null,
        error: `brand / user context: ${(err as Error).message}`.slice(0, 1000),
        conversations: keys.length,
        topics: topicsOf(verdicts),
        contentFree: contentFreeOf(verdicts),
        contextHash: null,
      },
    };
  }

  const markers = await matrixMarkers([...matrixIds]);
  // What the brand's own tools know about each conversation's counterpart.
  const views = new Map<string, PersonView>();
  for (const person of persons) {
    const view = personView(person);
    for (const k of conversationKeysOf(person)) views.set(k, view);
  }
  type Plan = { kind: "gmail"; gmail: GmailPlan } | { kind: "matrix"; id: string };
  // An unreadable mailbox judges no Gmail thread: its recorded verdicts still apply.
  const plans: { key: string; judgedThrough: string; plan: Plan; contextHash: string }[] = [
    ...[...gmail.values()].filter(() => gmailReadable).map((g) => ({
      key: `gmail:${g.email}`,
      judgedThrough: g.judgedThrough,
      plan: { kind: "gmail" as const, gmail: g },
      contextHash: `${context.hash}|${users.hash.gmail}`,
    })),
    ...matrixPlans([...matrixIds], markers, context, users).map((p) => ({ ...p, plan: { kind: "matrix" as const, id: p.plan } })),
  ];
  const gmailUsers = users.gmail.map((g) => g.user);
  const { verdicts, summary, nothingToRead } = await judgeAndRecord(identity, context, plans, async (plan) => {
    if (plan.kind === "gmail") {
      const input = await gmailConversationInput(identity, plan.gmail);
      if (!input) return null;
      const account = users.gmail.length === 1 ? users.gmail[0].mailbox : null;
      return {
        ...input,
        user: accountUserView("email", account, gmailUsers),
        userIds: userIdsOf(gmailUsers),
        person: views.get(input.key) ?? null,
      };
    }
    return matrixLoader(users, views)(plan.id);
  });
  if (!gmailReadable && gmail.size > 0) {
    const recorded = await storedVerdicts(identity.orgId, identity.brandId, [...gmail.keys()].map((e) => `gmail:${e}`));
    for (const [k, v] of recorded) verdicts.set(k, v);
    summary.pending = keys.filter((k) => !verdicts.has(k)).length;
  }
  return {
    context,
    users,
    nothingToRead,
    verdicts,
    summary: {
      ...summary,
      conversations: keys.length,
      topics: topicsOf(verdicts),
      contentFree: contentFreeOf(verdicts),
      contextHash: context.hash,
    },
  };
}
