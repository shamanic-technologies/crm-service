/**
 * Is an address a HUMAN the brand is in conversation with, or an AUTOMATED
 * sender (a LinkedIn "X just messaged you" digest, a Stripe receipt, a calendar
 * notification, a newsletter, a no-reply)?
 *
 * Jev decides — TypeSafe's judgment model through chat-service
 * `POST /orgs/judgments`, which declares the cost against the build's org run
 * (input tokens only). Nothing in code decides it: no regex on the local part,
 * no header sniff. What the mail already carries (the address, the names it
 * signs with, how many messages went each way, a few recent subjects and
 * snippets) is the INPUT Jev reads; the verdict is Jev's.
 *
 * An address does not change nature, so it is judged ONCE per (org, address)
 * and the verdict is recorded with Jev's confidence and exactly what Jev was
 * shown (`sender_verdicts`). Every later build reads the record: the cost is
 * one small judgment per NEW address, never one per page read or per rebuild.
 *
 * WHO is judged: only a person known from Gmail ALONE, and only an address
 * that actually SENT the mailbox something. Every other source is itself a
 * recorded human relationship (a cold-email lead who replied or clicked, a
 * signup, a paying customer, a CRM contact, a WhatsApp thread), and an address
 * that never wrote is not a sender. Judged blind (no mail to read), Jev called
 * real prospects automated at 0.5-0.8 on the first prod build — so they are
 * not asked at all.
 *
 * A person is hidden as automated only when Jev judged EVERY one of their
 * addresses automated with at least AUTOMATED_MIN_CONFIDENCE, they carry no
 * phone, and Gmail is their only source. An address never judged (Jev failed,
 * its sample could not be read) is a human until judged — nobody disappears
 * without Jev saying so.
 *
 * A CHAT account is judged the same way (OWN-BOT-HOT-LEAD-1103, 2026-11-03: our
 * own Telegram alert bot posted 330 visit recaps / daily briefs into the
 * owner's bridged Telegram, was judged "about the brand" and became a hot lead
 * 11+ times). A person known ONLY from one-to-one Matrix threads (WhatsApp,
 * Telegram, LinkedIn...) is asked once per thread counterpart, key
 * `matrix:<contactId>` in `sender_verdicts` (the column is named `email` for
 * history; it holds the sender key), input = the latest messages the account
 * sent and the latest the owner sent it, read from our own mirror. Every
 * thread automated >= AUTOMATED_MIN_CONFIDENCE = automated (a phone held by
 * the thread's own ghost does not save it: it is the bot's number). A group
 * member, or anyone another source knows, is never asked.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { readMailboxThreads } from "../mailbox/thread.js";
import { db } from "../../db/index.js";
import { contacts, conversations, matrixRawEvents, senderVerdicts } from "../../db/schema.js";
import { foldEdits, humanText } from "../matrix/events.js";
import type { MatrixEvent } from "../matrix/client.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import type { PersonCluster } from "./identity.js";
import { mapLimit, siblingGet, type SiblingIdentity } from "./siblings.js";

export const SENDER_VERDICTS = ["human", "automated"] as const;
export type SenderVerdict = (typeof SENDER_VERDICTS)[number];

/**
 * Below this confidence an `automated` verdict is recorded but does NOT hide
 * the person: the no-go is hiding a real person Jev was unsure about. On a
 * two-option choice 0.5 is a coin flip. Measured on the first brand (216
 * senders): the real people Jev leaned `automated` on (an out-of-office, a
 * human support agent) sat at 0.52-0.74; bulk senders at 0.80-1.0.
 */
export const AUTOMATED_MIN_CONFIDENCE = 0.75;

/** Addresses per judgments call — keeps one request well inside Jev's token budget. */
const ADDRESSES_PER_CALL = 40;
const SAMPLE_CONCURRENCY = 6;
const SAMPLE_MESSAGES = 3;
const SNIPPET_CHARS = 240;

const CRITERIA: Record<SenderVerdict, string> = {
  human:
    "the address belongs to a real person writing in their own name or for their company: a prospect, a " +
    "client, a partner, a supplier's or vendor's staff member answering in person. A role address (sales@, " +
    "info@, support@, hello@) is still human when a person writes the messages. A personal address is " +
    "human even when the only mail it sent was generated on the person's behalf: a calendar response " +
    "(\"Accepted:\", \"Declined:\", \"Proposed new time:\"), an out-of-office or vacation auto-reply. " +
    "An address the owner writes real, personal messages to (messagesOwnerSent) is read by someone: human, " +
    "even when what it sends is notifications.",
  automated:
    "the address belongs to a machine sending on its own, with nobody behind it to talk to: notification or digest emails (\"X just messaged you\", " +
    "\"new comment\"), receipts and invoices, account and security alerts, calendar or booking notifications, " +
    "no-reply addresses, newsletters and marketing blasts, ticket-system auto-acknowledgements. On a chat app " +
    "(WhatsApp, Telegram, LinkedIn): a bot or alert line posting reports, recaps, briefs, visit or event " +
    "notifications on its own, that nobody types and nobody answers.",
};

export interface SenderSample {
  subject: string | null;
  snippet: string | null;
  direction: string;
}

/** What Jev is shown about one address (or one chat account). */
export interface SenderInput {
  /** The sender key: the email address, or `matrix:<contactId>` for a chat account. */
  email: string;
  /** A chat account: its network (whatsapp, telegram, linkedin...). Absent for an email address. */
  chatChannel?: string;
  names: string[];
  /** Where the address appears, with message counts when the source has them. */
  appearsOn: { source: string; inbound: number | null; outbound: number | null }[];
  /** A few recent messages the address SENT (Gmail), newest first. */
  recentMessages: SenderSample[];
  /**
   * A few recent messages the brand owner sent TO the address, newest first.
   * An address the owner writes real messages to is read by someone (a
   * client's info@ that also relays lead notifications).
   */
  messagesOwnerSent?: SenderSample[];
}

export interface RecordedVerdict {
  verdict: SenderVerdict;
  confidence: number;
}

export interface SenderVerdictSummary {
  status: "ok" | "failed";
  /** Addresses that already had a verdict. */
  reused: number;
  /** Addresses judged by this build. */
  judged: number;
  /** Addresses still without a verdict (Jev or their sample failed): shown as human. */
  pending: number;
  /** People hidden as automated by this build. */
  automatedPeople: number;
  model: string | null;
  error: string | null;
}

interface GmailConversation {
  threads: {
    messages: { direction: string; fromEmail: string | null; subject: string | null; snippet: string | null; sentAt: string | null }[];
  }[];
}

/**
 * The latest messages `email` itself sent to the org's mailbox, and the latest
 * the owner sent to it, via google-service. Kept apart: a notification WE sent
 * about them (a booking confirmation) says nothing about what they send.
 */
async function gmailSample(
  identity: SiblingIdentity,
  email: string,
): Promise<{ sent: SenderSample[]; ownerSent: SenderSample[] }> {
  const r = await siblingGet("google", `/orgs/google/conversation?email=${encodeURIComponent(email)}&limit=20`, identity);
  const reason = (r.body as { reason?: string } | null)?.reason;
  if (r.status === 404 && (reason === "no_messages" || reason === "no_google_account_connected")) return { sent: [], ownerSent: [] };
  if (r.status !== 200) {
    throw new Error(`google-service conversation for ${email} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const messages = (r.body as GmailConversation).threads
    .flatMap((t) => t.messages)
    .sort((a, b) => ((a.sentAt ?? "") < (b.sentAt ?? "") ? 1 : -1));
  const sample = (ms: typeof messages) =>
    ms.slice(0, SAMPLE_MESSAGES).map((m) => ({
      subject: m.subject,
      snippet: m.snippet ? m.snippet.slice(0, SNIPPET_CHARS) : null,
      direction: m.direction,
    }));
  return {
    sent: sample(messages.filter((m) => m.direction === "inbound" && m.fromEmail?.toLowerCase() === email)),
    ownerSent: sample(messages.filter((m) => m.direction === "outbound")),
  };
}

/**
 * Mail sources Jev may judge a sender on: the owner's Gmail, and the threads of our sending mailboxes for anyone but
 * the sequence's lead (EVERY-PERSON-ON-THE-THREAD-1109). Every other source is a recorded human relationship.
 */
export const JUDGED_MAIL_SOURCES = new Set(["gmail", "sending_mailbox"]);

/** A person Jev may judge: known from mail sources alone (Gmail, our sending mailboxes). */
export function isGmailOnly(person: { presences: { source: string }[] }): boolean {
  return person.presences.length > 0 && person.presences.every((p) => JUDGED_MAIL_SOURCES.has(p.source));
}

/**
 * The latest messages `email` sent our sending mailboxes for the brand, and the latest we sent it, from our own
 * bronze (lib/mailbox/thread.ts). Same shape as the Gmail sample.
 */
async function mailboxSample(orgId: string, brandId: string, email: string): Promise<{ sent: SenderSample[]; ownerSent: SenderSample[] }> {
  const messages = (await readMailboxThreads(orgId, brandId, [email])).reverse();
  const sample = (ms: typeof messages, direction: string) =>
    ms.slice(0, SAMPLE_MESSAGES).map((m) => ({ subject: m.subject, snippet: m.text ? m.text.slice(0, SNIPPET_CHARS) : null, direction }));
  return {
    sent: sample(messages.filter((m) => m.direction === "in" && m.from === email), "inbound"),
    ownerSent: sample(messages.filter((m) => m.direction === "out" && (m.to.includes(email) || m.cc.includes(email) || m.bcc.includes(email))), "outbound"),
  };
}

/** The `sender_verdicts` key of a chat account (one Matrix contact = one counterpart on one linked account). */
export const matrixSenderKey = (contactId: string) => `matrix:${contactId}`;

type PresenceLike = { source: string; inboundCount?: number | null; detail: Record<string, unknown> };

/** A person Jev may judge on chat: known from one-to-one Matrix threads ALONE (never a group member, never another source). */
export function isMatrixDmOnly(person: { presences: PresenceLike[] }): boolean {
  return person.presences.length > 0 && person.presences.every((p) => p.source === "matrix" && p.detail.kind === "dm");
}

/** PURE: the sender keys of a Matrix-only person's threads in which the account WROTE. */
export function matrixSenderKeys(person: { presences: PresenceLike[] }): string[] {
  if (!isMatrixDmOnly(person)) return [];
  return person.presences
    .filter((p) => (p.inboundCount ?? 0) > 0 && typeof p.detail.contactId === "string")
    .map((p) => matrixSenderKey(p.detail.contactId as string));
}

/**
 * What Jev is shown about each address to judge (no sample fetched yet): the
 * addresses of Gmail-only people that sent the mailbox at least one message,
 * and the chat accounts of Matrix-only people that wrote at least once.
 */
export function senderInputs(clusters: PersonCluster[]): Map<string, SenderInput> {
  const inputs = new Map<string, SenderInput>();
  for (const c of clusters) {
    for (const p of c.presences) {
      if (!isMatrixDmOnly(c) || (p.inboundCount ?? 0) === 0 || typeof p.detail.contactId !== "string") continue;
      const key = matrixSenderKey(p.detail.contactId);
      inputs.set(key, {
        email: key,
        chatChannel: typeof p.detail.channel === "string" ? p.detail.channel : "chat",
        names: p.displayName ? [p.displayName] : [],
        appearsOn: [{ source: `${typeof p.detail.channel === "string" ? p.detail.channel : "chat"} (one-to-one thread)`, inbound: p.inboundCount, outbound: p.outboundCount }],
        recentMessages: [],
      });
    }
    if (!isGmailOnly(c)) continue;
    for (const email of c.emails) {
      const wrote = c.presences.some((p) => p.emails.includes(email) && (p.inboundCount ?? 0) > 0);
      if (!wrote) continue;
      const input = inputs.get(email) ?? { email, names: [], appearsOn: [], recentMessages: [] };
      for (const p of c.presences) {
        if (!p.emails.includes(email)) continue;
        if (p.displayName && !input.names.includes(p.displayName)) input.names.push(p.displayName);
        input.appearsOn.push({ source: p.source, inbound: p.inboundCount, outbound: p.outboundCount });
      }
      inputs.set(email, input);
    }
  }
  return inputs;
}

/**
 * The latest messages a chat account sent in its thread, and the latest the owner sent it, from our own mirror
 * (edits folded, human words only). Same shape as the Gmail sample.
 */
async function matrixSample(contactId: string): Promise<{ sent: SenderSample[]; ownerSent: SenderSample[] }> {
  const [thread] = await db
    .select({ connectionId: conversations.connectionId, roomId: conversations.roomId, ghost: contacts.channelHandle })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.contactId, contactId));
  if (!thread) return { sent: [], ownerSent: [] };
  const rows = await db
    .select({ eventId: matrixRawEvents.eventId, sender: matrixRawEvents.sender, at: matrixRawEvents.originServerTs, payload: matrixRawEvents.payload })
    .from(matrixRawEvents)
    .where(and(eq(matrixRawEvents.connectionId, thread.connectionId), eq(matrixRawEvents.roomId, thread.roomId), eq(matrixRawEvents.eventType, "m.room.message")))
    .orderBy(desc(matrixRawEvents.originServerTs))
    .limit(60);
  const events = rows.map(
    (r) =>
      ({
        event_id: r.eventId,
        sender: r.sender,
        type: "m.room.message",
        origin_server_ts: r.at.getTime(),
        content: ((r.payload as { content?: Record<string, unknown> }).content ?? {}) as Record<string, unknown>,
      }) as MatrixEvent,
  );
  const words = foldEdits(events)
    .map((e) => ({ sender: e.sender, at: e.origin_server_ts, text: humanText(e.content) }))
    .filter((m) => m.text)
    .sort((a, b) => b.at - a.at);
  const sample = (ms: typeof words, direction: string) =>
    ms.slice(0, SAMPLE_MESSAGES).map((m) => ({ subject: null, snippet: m.text.slice(0, SNIPPET_CHARS), direction }));
  return {
    sent: sample(words.filter((m) => m.sender === thread.ghost), "inbound"),
    ownerSent: sample(words.filter((m) => m.sender !== thread.ghost), "outbound"),
  };
}

/** One judgments call: one `choice` question per address. Fails loud on a malformed answer. */
export async function judgeSenders(
  inputs: SenderInput[],
  tracking: ChatTrackingHeaders,
): Promise<{ verdicts: { verdict: SenderVerdict; confidence: number; probabilities: Record<string, number> }[]; model: string }> {
  const senders: Record<string, SenderInput> = {};
  const questions: Record<string, ChoiceQuestion> = {};
  inputs.forEach((input, i) => {
    senders[`a${i}`] = input;
    questions[`a${i}`] = {
      type: "choice",
      instructions: input.chatChannel
        ? `Read senders.a${i} in the state: a ${input.chatChannel} account, the names it shows, where it appears, ` +
          "the latest messages it sent and the latest the owner sent to it. Judge WHO IS BEHIND the account, not the form of one message: is it a " +
          "real human the brand owner is in conversation with, or an automated sender (a bot, an alert line)?"
        : `Read senders.a${i} in the state: the address ${input.email}, the names it signs with, where it appears, ` +
          "the latest messages it sent and the latest the owner sent to it. Judge WHO OWNS the address, not the form of one message: is it a " +
          "real human the brand owner is in conversation with, or an automated sender?",
      criteria: CRITERIA,
    };
  });
  const state = {
    context:
      "Everyone a brand owner exchanged email or messages with. The owner wants to see only the real people " +
      "(prospects, clients, partners) and not the automated senders that mail them.",
    senders,
  };
  const result = await judgeChoices(state, questions, tracking);
  const verdicts = inputs.map((_, i) => {
    const answer = result.answers?.[`a${i}`];
    if (!answer) throw new Error(`[crm-service][people] sender verdicts: no answer for a${i}`);
    if (!(SENDER_VERDICTS as readonly string[]).includes(answer.choice)) {
      throw new Error(`[crm-service][people] sender verdicts: unknown verdict "${answer.choice}"`);
    }
    if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
      throw new Error(`[crm-service][people] sender verdicts: a${i} came back without a confidence`);
    }
    return {
      verdict: answer.choice as SenderVerdict,
      confidence: answer.confidence,
      probabilities: answer.probabilities ?? {},
    };
  });
  return { verdicts, model: result.model };
}

/**
 * The verdict of every address of `clusters`: the recorded ones, plus a fresh
 * judgment for every address never judged. A failure (a sample read, a Jev
 * call) leaves the addresses it touched without a verdict and is reported in
 * the summary — the build goes on and they read as human until the next build.
 */
export async function resolveSenderVerdicts(
  clusters: PersonCluster[],
  identity: SiblingIdentity,
  gmailReadable: boolean,
): Promise<{ verdicts: Map<string, RecordedVerdict>; summary: Omit<SenderVerdictSummary, "automatedPeople"> }> {
  const inputs = senderInputs(clusters);
  const emails = [...inputs.keys()];
  // An address the person holds on Gmail is sampled there; one known only from our sending mailboxes, from our bronze.
  const onGmail = new Set(clusters.flatMap((c) => c.presences.filter((p) => p.source === "gmail").flatMap((p) => p.emails)));
  const verdicts = new Map<string, RecordedVerdict>();
  for (let i = 0; i < emails.length; i += 1000) {
    const rows = await db
      .select({ email: senderVerdicts.email, verdict: senderVerdicts.verdict, confidence: senderVerdicts.confidence })
      .from(senderVerdicts)
      .where(and(eq(senderVerdicts.orgId, identity.orgId), inArray(senderVerdicts.email, emails.slice(i, i + 1000))));
    for (const r of rows) verdicts.set(r.email, { verdict: r.verdict as SenderVerdict, confidence: r.confidence });
  }
  const reused = verdicts.size;
  const toJudge = emails.filter((e) => !verdicts.has(e));

  const errors: string[] = [];
  const ready: SenderInput[] = [];
  await mapLimit(toJudge, SAMPLE_CONCURRENCY, async (email) => {
    const input = inputs.get(email)!;
    const fromGmail = !input.chatChannel && onGmail.has(email);
    if (fromGmail && !gmailReadable) return; // judged on a later build, once its mail can be read
    try {
      const sample = input.chatChannel
        ? await matrixSample(email.slice("matrix:".length))
        : fromGmail
          ? await gmailSample(identity, email)
          : await mailboxSample(identity.orgId, identity.brandId, email);
      input.recentMessages = sample.sent;
      input.messagesOwnerSent = sample.ownerSent;
    } catch (err) {
      if (errors.length < 3) errors.push((err as Error).message);
      return;
    }
    ready.push(input);
  });
  ready.sort((a, b) => (a.email < b.email ? -1 : 1));

  const tracking: ChatTrackingHeaders = {
    orgId: identity.orgId,
    userId: identity.userId,
    runId: identity.runId,
    brandIds: [identity.brandId],
  };
  let judged = 0;
  let model: string | null = null;
  let jevFailed = false;
  for (let i = 0; i < ready.length; i += ADDRESSES_PER_CALL) {
    const batch = ready.slice(i, i + ADDRESSES_PER_CALL);
    try {
      const result = await judgeSenders(batch, tracking);
      model = result.model;
      await db
        .insert(senderVerdicts)
        .values(
          batch.map((input, k) => ({
            orgId: identity.orgId,
            email: input.email,
            verdict: result.verdicts[k].verdict,
            confidence: result.verdicts[k].confidence,
            probabilities: result.verdicts[k].probabilities,
            input,
            model: result.model,
            runId: identity.runId,
          })),
        )
        .onConflictDoNothing({ target: [senderVerdicts.orgId, senderVerdicts.email] });
      batch.forEach((input, k) =>
        verdicts.set(input.email, { verdict: result.verdicts[k].verdict, confidence: result.verdicts[k].confidence }),
      );
      judged += batch.length;
    } catch (err) {
      jevFailed = true;
      errors.unshift((err as Error).message);
      break; // the rest is judged on the next build
    }
  }

  return {
    verdicts,
    summary: {
      status: jevFailed || errors.length ? "failed" : "ok",
      reused,
      judged,
      pending: emails.length - verdicts.size,
      model,
      error: errors.length ? errors.join(" | ").slice(0, 1000) : null,
    },
  };
}

/**
 * True when the person is Gmail-only, holds no phone, and Jev judged every address automated, confidently;
 * or Matrix-DM-only and Jev judged every thread they wrote in automated, confidently.
 */
export function isAutomatedPerson(
  person: { emails: string[]; phones: string[]; presences: PresenceLike[] },
  verdicts: Map<string, RecordedVerdict>,
): boolean {
  const confident = (key: string) => {
    const v = verdicts.get(key);
    return v?.verdict === "automated" && v.confidence >= AUTOMATED_MIN_CONFIDENCE;
  };
  if (isMatrixDmOnly(person)) {
    const keys = matrixSenderKeys(person);
    return keys.length > 0 && keys.every(confident);
  }
  if (person.emails.length === 0 || person.phones.length > 0 || !isGmailOnly(person)) return false;
  return person.emails.every(confident);
}

/** The verdicts that decided a person, stored on the person row. */
export function personVerdicts(emails: string[], verdicts: Map<string, RecordedVerdict>) {
  return emails.map((email) => ({ email, ...(verdicts.get(email) ?? { verdict: null, confidence: null }) }));
}
