/**
 * WHAT JEV READS TO JUDGE A BURST (JEV-WHOLE-THREAD-1109, owner 2026-11-09: « attention aux cas particuliers.
 * Juste donne tout le fil et le maximum d'information, dans la limite du context window pour Jev »).
 *
 * Before, Jev read the person's new words ALONE, without even the business's name. Chaim Tesser (a client of
 * Distribute.you) replied-all to HIS prospect Mario in his own campaign's thread ("Hi Mario, ... happy to scope
 * it"); Jev, blind to who it was written to, read "interested" at 0.89 and a Lead event made us email Chaim to take
 * over replies we already handle for him (2026-11-08, report ec74987e).
 *
 * Now Jev reads, in ONE state: the business (name, website, description, active offers as created, the owner's
 * other brands), what the brand's own tools know about the person, and the WHOLE conversation we hold, every
 * message with who wrote it and to whom (From / To / Cc as stored), the new ones marked. No rule of ours decides who
 * a message is written to: Jev answers it (`not_to_business` in `REPLY_KINDS`). The thread is cut only to fit Jev's
 * context (32k tokens per question, docs.typesafe.ai/models.md): the oldest messages go first, the new ones never.
 */
import { clipEnds } from "../people/relevance.js";
import type { BrandContext, PersonView } from "../people/relevance.js";

/** One message of the conversation as Jev reads it. */
export interface BurstThreadLine {
  at: string | null;
  /** The person wrote it (their address / account), else someone else did (the business, its mailbox, a third party). */
  byThePerson: boolean;
  /** Email: the addresses as the mail states them. Chat: absent (a one-to-one thread). */
  from?: string | null;
  to?: string[];
  cc?: string[];
  subject?: string | null;
  text: string;
  /** One of the new messages being judged. */
  new?: boolean;
}

export interface BurstContext {
  business: BrandContext;
  person: { name?: string | null; email?: string | null; phone?: string | null; knownBy?: PersonView | null };
  /** Oldest first, the whole conversation we hold. */
  thread: BurstThreadLine[];
}

/** One message at most this many characters (its head and its tail: the answer and the signature). */
export const BURST_LINE_CHARS = 4000;
/**
 * The whole thread at most this many characters: ~18k tokens, under Jev's 32k-token per-question context with the
 * business, the question and its criteria (docs.typesafe.ai/models.md, read 2026-11-09).
 */
export const BURST_THREAD_CHAR_BUDGET = 60_000;

/** PURE: the thread cut to the budget: every new message kept, then the latest older ones; the count dropped said. */
export function fitThread(lines: BurstThreadLine[], budget: number = BURST_THREAD_CHAR_BUDGET): { lines: BurstThreadLine[]; olderOmitted: number } {
  const clipped = lines.map((l) => ({ ...l, text: clipEnds(l.text, BURST_LINE_CHARS - 1000, 1000) }));
  const size = (l: BurstThreadLine) => l.text.length + (l.subject?.length ?? 0) + 200;
  let used = clipped.filter((l) => l.new).reduce((s, l) => s + size(l), 0);
  const keep = new Set<number>(clipped.flatMap((l, i) => (l.new ? [i] : [])));
  for (let i = clipped.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    if (used + size(clipped[i]) > budget) continue;
    used += size(clipped[i]);
    keep.add(i);
  }
  const kept = clipped.filter((_, i) => keep.has(i));
  return { lines: kept, olderOmitted: clipped.length - kept.length };
}

/** PURE: the state Jev is shown (the judge and the replay eval share it). */
export function burstJudgeState(channel: string, ctx: BurstContext): Record<string, unknown> {
  const { lines, olderOmitted } = fitThread(ctx.thread);
  const b = ctx.business;
  return {
    context:
      `The business below receives messages on ${channel}. "thread" is the whole conversation we hold with this ` +
      "person, oldest first: who wrote each message and, for email, to whom (from, to, cc). The messages marked " +
      '"new": true are the ones being judged: what the person wrote since the business last wrote. Read the whole ' +
      "thread to know who the person is, who each message is addressed to, and what it answers.",
    business: {
      name: b.brand.name,
      website: b.brand.website,
      description: b.brand.description,
      offers: b.offers.map((o) => ({ name: o.name, whatWeOffer: o.whatWeOffer })),
      otherBrandsOfTheSameOwner: b.otherBrandsOfTheSameOwner,
    },
    person: {
      name: ctx.person.name ?? null,
      email: ctx.person.email ?? null,
      phone: ctx.person.phone ?? null,
      knownByTheBusinessTools: ctx.person.knownBy?.knownBy ?? [],
      company: ctx.person.knownBy?.company ?? null,
    },
    ...(olderOmitted > 0 ? { olderMessagesOmitted: olderOmitted } : {}),
    thread: lines.map((l) => ({
      at: l.at,
      writtenBy: l.byThePerson ? "the person" : "not the person",
      ...(l.from !== undefined ? { from: l.from } : {}),
      ...(l.to ? { to: l.to } : {}),
      ...(l.cc && l.cc.length > 0 ? { cc: l.cc } : {}),
      ...(l.subject ? { subject: l.subject } : {}),
      text: l.text,
      ...(l.new ? { new: true } : {}),
    })),
  };
}

// ─── the thread, per channel (pure) ─────────────────────────────────────────

/** One stored mail of the person's conversation (gmail.ts `storedConversation`). */
export interface StoredMailLine {
  messageKey: string;
  at: Date | null;
  direction: string | null;
  from?: string | null;
  to: string[];
  cc?: string[];
  subject: string | null;
  text: string | null;
}

/** PURE: every stored mail of the conversation, oldest first; `byThePerson` = the mirror's inbound. */
export function emailThreadLines(mails: StoredMailLine[], newKeys: ReadonlySet<string>): BurstThreadLine[] {
  return [...mails]
    .filter((m) => (m.text ?? "").trim() || (m.subject ?? "").trim())
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) || (a.messageKey < b.messageKey ? -1 : 1))
    .map((m) => ({
      at: m.at ? m.at.toISOString() : null,
      byThePerson: m.direction === "inbound",
      from: m.from ?? null,
      to: m.to,
      ...(m.cc && m.cc.length > 0 ? { cc: m.cc } : {}),
      subject: m.subject,
      text: (m.text ?? "").trim(),
      ...(newKeys.has(m.messageKey) ? { new: true } : {}),
    }));
}

/** One chat message already folded and worded (events.ts `foldEdits` + `messageWords`). */
export interface ChatLine {
  eventId: string;
  at: number;
  byThePerson: boolean;
  text: string;
}

/** PURE: every worded chat message of the thread, oldest first. */
export function chatThreadLines(messages: ChatLine[], newIds: ReadonlySet<string>): BurstThreadLine[] {
  return [...messages]
    .filter((m) => m.text.trim())
    .sort((a, b) => a.at - b.at || (a.eventId < b.eventId ? -1 : 1))
    .map((m) => ({
      at: new Date(m.at).toISOString(),
      byThePerson: m.byThePerson,
      text: m.text.trim(),
      ...(newIds.has(m.eventId) ? { new: true } : {}),
    }));
}
