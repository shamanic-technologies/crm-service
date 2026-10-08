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
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { senderVerdicts } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import type { PersonCluster } from "./identity.js";
import { mapLimit, siblingGet, type SiblingIdentity } from "./siblings.js";

export const SENDER_VERDICTS = ["human", "automated"] as const;
export type SenderVerdict = (typeof SENDER_VERDICTS)[number];

/**
 * Below this confidence an `automated` verdict is recorded but does NOT hide
 * the person: the no-go is hiding a real person Jev was unsure about.
 */
export const AUTOMATED_MIN_CONFIDENCE = 0.5;

/** Addresses per judgments call — keeps one request well inside Jev's token budget. */
const ADDRESSES_PER_CALL = 40;
const SAMPLE_CONCURRENCY = 6;
const SAMPLE_MESSAGES = 3;
const SNIPPET_CHARS = 240;

const CRITERIA: Record<SenderVerdict, string> = {
  human:
    "a real person writing in their own name or for their company: a prospect, a client, a partner, " +
    "a supplier's or vendor's staff member answering in person. A role address (sales@, info@, support@, " +
    "hello@) is still human when a person writes the messages.",
  automated:
    "a machine sending on its own, nobody to talk to: notification or digest emails (\"X just messaged you\", " +
    "\"new comment\"), receipts and invoices, account and security alerts, calendar or booking notifications, " +
    "no-reply addresses, newsletters and marketing blasts, ticket-system auto-acknowledgements.",
};

export interface SenderSample {
  subject: string | null;
  snippet: string | null;
  direction: string;
}

/** What Jev is shown about one address. */
export interface SenderInput {
  email: string;
  names: string[];
  /** Where the address appears, with message counts when the source has them. */
  appearsOn: { source: string; inbound: number | null; outbound: number | null }[];
  /** A few recent messages the address SENT (Gmail), newest first. */
  recentMessages: SenderSample[];
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

/** The latest messages `email` itself sent to the org's mailbox, via google-service. */
async function gmailSample(identity: SiblingIdentity, email: string): Promise<SenderSample[]> {
  const r = await siblingGet("google", `/orgs/google/conversation?email=${encodeURIComponent(email)}&limit=20`, identity);
  const reason = (r.body as { reason?: string } | null)?.reason;
  if (r.status === 404 && (reason === "no_messages" || reason === "no_google_account_connected")) return [];
  if (r.status !== 200) {
    throw new Error(`google-service conversation for ${email} returned ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  // Only what the address wrote: a notification WE sent about them (a booking
  // confirmation) says nothing about who they are.
  return (r.body as GmailConversation).threads
    .flatMap((t) => t.messages)
    .filter((m) => m.direction === "inbound" && m.fromEmail?.toLowerCase() === email)
    .sort((a, b) => ((a.sentAt ?? "") < (b.sentAt ?? "") ? 1 : -1))
    .slice(0, SAMPLE_MESSAGES)
    .map((m) => ({
      subject: m.subject,
      snippet: m.snippet ? m.snippet.slice(0, SNIPPET_CHARS) : null,
      direction: m.direction,
    }));
}

/** A person Jev may judge: known from Gmail alone (every other source is a recorded human relationship). */
export function isGmailOnly(person: { presences: { source: string }[] }): boolean {
  return person.presences.length > 0 && person.presences.every((p) => p.source === "gmail");
}

/**
 * What Jev is shown about each address to judge (no sample fetched yet): the
 * addresses of Gmail-only people that sent the mailbox at least one message.
 */
export function senderInputs(clusters: PersonCluster[]): Map<string, SenderInput> {
  const inputs = new Map<string, SenderInput>();
  for (const c of clusters) {
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
      instructions:
        `Read senders.a${i} in the state: the address ${input.email}, the names it signs with, where it appears ` +
        "and the latest messages it sent. Is it a real human the brand owner is in conversation with, or an " +
        "automated sender?",
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
    if (!gmailReadable) return; // judged on a later build, once its mail can be read
    try {
      input.recentMessages = await gmailSample(identity, email);
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

/** True when the person is Gmail-only, holds no phone, and Jev judged every address automated, confidently. */
export function isAutomatedPerson(
  person: { emails: string[]; phones: string[]; presences: { source: string }[] },
  verdicts: Map<string, RecordedVerdict>,
): boolean {
  if (person.emails.length === 0 || person.phones.length > 0 || !isGmailOnly(person)) return false;
  return person.emails.every((e) => {
    const v = verdicts.get(e);
    return v?.verdict === "automated" && v.confidence >= AUTOMATED_MIN_CONFIDENCE;
  });
}

/** The verdicts that decided a person, stored on the person row. */
export function personVerdicts(emails: string[], verdicts: Map<string, RecordedVerdict>) {
  return emails.map((email) => ({ email, ...(verdicts.get(email) ?? { verdict: null, confidence: null }) }));
}
