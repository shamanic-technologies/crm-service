/**
 * ONE HUMAN, TWO ADDRESSES: two people of a brand sharing a full name (SAME-HUMAN-TWO-LEADS-1022).
 *
 * Owner 2026-10-22: Lukas Stankevicius was two leads on Distribute.you, lukas@stankamera.com (he booked a call)
 * and lukstan14@gmail.com ("Perfect, talk soon in 25min", same call). No record states both addresses, so the
 * sources never join them (identity.ts: positive evidence only). lead-service used to ask Jev "same person?"
 * and stopped on 2026-10-17 when merges moved here and to human-service; nobody asked since.
 *
 * Here, at the START of every people build, over the people the PREVIOUS build wrote:
 *  - candidates = two people of the brand carrying the same FULL name (2+ words) on any record, not one human
 *    for human-service yet. Retrieval, never the answer: a shared name is only why we ask. A name more than
 *    `MAX_TWIN_GROUP` people carry is too common to say anything (skipped, counted). Prod 2026-10-22: 47 pairs
 *    fleet-wide (Distribute.you 5, all five real; Doc Dinners 42 over 17 names, ~5 real, the rest CRM junk
 *    names like "support page" that Jev turns down).
 *  - ONE Jev `choice` per pair (`same_human | different_humans`), a short card per side: names, addresses,
 *    phones, company, sources, activity dates, its latest 3 stored messages (500 chars each). Never whole threads:
 *    lead-service's old matcher sent up to 100k chars a pair, 120 pairs a tick, ~20M tokens in 1.5 h, and
 *    emptied the credit every Jev caller shares (2026-10-14).
 *  - Recorded once per pair (`same_person_verdicts`), asked again only when a `different` pair's identity keys or
 *    name move (never on a new message). P(same) >= 0.5 = same (owner 2026-10-14: merge from 50%, undo in one click).
 *  - A `same` verdict is EVIDENCE (`name_twin`) of the same build: stated to human-service as an org-scoped
 *    `same` link like a stated merge (people/humans.ts), so lead-service and the Unibox follow the human.
 *  - "Not the same person" (`rejectTwinVerdict`) rejects it for good: the next build withdraws the link and the
 *    two are two people again.
 *
 * Fail-soft: Jev / chat-service down = nothing judged this build (`status: failed`), retried next build; the
 * people build never fails on it.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { people, peopleMessageTexts, samePersonVerdicts, type PeopleScope, type SamePersonVerdict } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceAnswer, type ChoiceQuestion } from "../judgments-client.js";
import type { Evidence } from "./identity.js";
import { mapLimit, siblingGetOk, type SiblingIdentity } from "./siblings.js";

/** A name more people carry than this says nothing about who they are (a common name, a CRM junk label). */
export const MAX_TWIN_GROUP = 5;
/** P(same human) at or above which two people are one (owner 2026-10-14: from 50%). */
export const TWIN_SAME_AT = 0.5;
/** Questions per build at most: a first pass on a big CRM spreads over a few builds. */
const MAX_PER_BUILD = Number(process.env.NAME_TWIN_MAX_PER_BUILD) || 40;
const CONCURRENCY = 3;
const MESSAGES_PER_SIDE = 3;
const MESSAGE_CHARS = 500;

export interface TwinPerson {
  personKey: string;
  humanId: string | null;
  identityKeys: string[];
  displayName: string | null;
  company: string | null;
  emails: string[];
  phones: string[];
  sources: string[];
  /** Every name a record of this person states. */
  presenceNames: string[];
  automated: boolean;
  groupOnly: boolean;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

export interface TwinPair {
  name: string;
  /** `a.personKey` < `b.personKey`. */
  a: TwinPerson;
  b: TwinPerson;
}

export interface TwinMessage {
  at: string | null;
  direction: string | null;
  subject: string | null;
  text: string;
}

export interface NameTwinSummary {
  status: "ok" | "failed";
  candidates: number;
  commonNamesSkipped: number;
  judged: number;
  reused: number;
  /** Pairs left for the next build (per-build cap). */
  pending: number;
  same: number;
  error: string | null;
}

// ─── pure ────────────────────────────────────────────────────────────────────

/**
 * PURE: a FULL name (2+ words), accents folded, lower-cased, spaces collapsed; null when the text is no person's
 * full name (one word, an address, a number, a "(WA)" label, a domain).
 */
export function twinName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const folded = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!folded || /[@0-9()[\]]|\.\w/.test(folded)) return null;
  if (/^visitor from /.test(folded)) return null;
  return folded.split(" ").length >= 2 ? folded : null;
}

/** PURE: every pair of people sharing a full name, not one human yet. Too common a name is skipped. */
export function nameTwinPairs(pool: TwinPerson[]): { pairs: TwinPair[]; commonNamesSkipped: number } {
  const byName = new Map<string, Map<string, TwinPerson>>();
  for (const p of pool) {
    if (p.automated || p.groupOnly) continue;
    const names = new Set([p.displayName, ...p.presenceNames].map(twinName).filter((n): n is string => !!n));
    for (const n of names) {
      const group = byName.get(n) ?? new Map<string, TwinPerson>();
      group.set(p.personKey, p);
      byName.set(n, group);
    }
  }
  const seen = new Set<string>();
  const pairs: TwinPair[] = [];
  let commonNamesSkipped = 0;
  for (const [name, group] of [...byName.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (group.size < 2) continue;
    if (group.size > MAX_TWIN_GROUP) {
      commonNamesSkipped++;
      continue;
    }
    const members = [...group.values()].sort((x, y) => (x.personKey < y.personKey ? -1 : 1));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = [members[i], members[j]];
        if (a.humanId && a.humanId === b.humanId) continue;
        const id = `${a.personKey}|${b.personKey}`;
        if (seen.has(id)) continue;
        seen.add(id);
        pairs.push({ name, a, b });
      }
    }
  }
  return { pairs, commonNamesSkipped };
}

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const card = (p: TwinPerson, messages: TwinMessage[]) => ({
  names: [...new Set([p.displayName, ...p.presenceNames].filter((n): n is string => !!n))],
  addresses: p.emails,
  phones: p.phones,
  company: p.company,
  seenOn: p.sources,
  firstActivity: p.firstActivityAt,
  lastActivity: p.lastActivityAt,
  latestMessages: messages,
});

/** PURE: the question for one pair, and the hash keying its recorded answer (who the two are, never their messages). */
export function sameHumanQuestion(
  pair: TwinPair,
  messages: { a: TwinMessage[]; b: TwinMessage[] },
  brandName: string | null,
): { state: unknown; question: ChoiceQuestion; hash: string } {
  return {
    state: { business: brandName, sharedName: pair.name, personA: card(pair.a, messages.a), personB: card(pair.b, messages.b) },
    question: {
      type: "choice",
      instructions:
        "The business below knows two contacts, A and B, carrying the same full name. Are they the SAME HUMAN using " +
        "two addresses or channels (very common: a work address and a personal Gmail, a CRM record and a WhatsApp " +
        "chat), or two different people who share a name? Judge on the person: the same company or role, the same " +
        "conversation or meeting going on with both, one answering what was said to the other, a signature, matching " +
        "timing. A shared name alone is weak when the name is common. Messages direction: inbound = the contact wrote " +
        "to the business, outbound = the business wrote to them.",
      criteria: {
        same_human: "A and B are one person reaching the business from two addresses or channels",
        different_humans: "A and B are two different people who happen to share a name",
      },
    },
    hash: sha({ v: 1, name: pair.name, a: [...pair.a.identityKeys].sort(), b: [...pair.b.identityKeys].sort() }),
  };
}

/** PURE: same from 50% sure. */
export const twinVerdict = (answer: ChoiceAnswer): "same" | "different" =>
  (answer.probabilities.same_human ?? 0) >= TWIN_SAME_AT ? "same" : "different";

const sideOf = (keys: string[]) => ({
  emails: keys.filter((k) => k.startsWith("email:")).map((k) => k.slice(6)),
  phones: keys.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6)),
});

/** PURE: a `same` verdict as build evidence: a judgment by Jev tying every key both people held. */
export function twinEvidence(v: Pick<SamePersonVerdict, "id" | "keysA" | "keysB">): Evidence {
  const keysA = v.keysA as string[];
  const keysB = v.keysB as string[];
  const keys = [...new Set([...keysA, ...keysB])].sort();
  return {
    kind: "name_twin",
    ref: v.id,
    displayName: null,
    company: null,
    ...sideOf(keys),
    keys,
    sides: [sideOf(keysA), sideOf(keysB)],
    judgedBy: "jev",
  };
}

// ─── reads / writes ──────────────────────────────────────────────────────────

/** The people the previous build wrote, as the judge reads them. */
async function previousPeople(scope: PeopleScope): Promise<TwinPerson[]> {
  const rows = await db
    .select({
      personKey: people.personKey,
      humanId: people.humanId,
      identityKeys: people.identityKeys,
      displayName: people.displayName,
      company: people.company,
      emails: people.emails,
      phones: people.phones,
      sources: people.sources,
      // Only the names of its records (a person's presences can be large).
      presenceNames: sql<(string | null)[]>`jsonb_path_query_array(${people.presences}, '$[*].displayName')`,
      automated: people.automated,
      groupOnly: people.groupOnly,
      firstActivityAt: people.firstActivityAt,
      lastActivityAt: people.lastActivityAt,
    })
    .from(people)
    .where(and(eq(people.scopeId, scope.id), eq(people.automated, false), eq(people.groupOnly, false)));
  return rows.map((r) => ({
    personKey: r.personKey,
    humanId: r.humanId,
    identityKeys: r.identityKeys as string[],
    displayName: r.displayName,
    company: r.company,
    emails: r.emails as string[],
    phones: r.phones as string[],
    sources: r.sources as string[],
    presenceNames: (r.presenceNames ?? []).filter((n): n is string => typeof n === "string" && n.length > 0),
    automated: r.automated,
    groupOnly: r.groupOnly,
    firstActivityAt: r.firstActivityAt?.toISOString() ?? null,
    lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
  }));
}

/** The latest stored Gmail / cold email messages of a person's addresses (our store, no sibling call). */
async function latestMessages(scopeId: string, emails: string[]): Promise<TwinMessage[]> {
  if (emails.length === 0) return [];
  const rows = await db
    .select({ at: peopleMessageTexts.at, direction: peopleMessageTexts.direction, subject: peopleMessageTexts.subject, body: peopleMessageTexts.body })
    .from(peopleMessageTexts)
    .where(and(eq(peopleMessageTexts.scopeId, scopeId), inArray(peopleMessageTexts.address, emails)))
    .orderBy(desc(peopleMessageTexts.at))
    .limit(MESSAGES_PER_SIDE);
  return rows.map((r) => ({
    at: r.at?.toISOString() ?? null,
    direction: r.direction,
    subject: r.subject,
    text: [...(r.body ?? "")].slice(0, MESSAGE_CHARS).join(""),
  }));
}

/**
 * Judge every new pair of the brand's people sharing a full name (bounded per build). Returns the summary;
 * never throws (a failure is recorded in it and retried next build).
 */
export async function judgeNameTwins(scope: PeopleScope, identity: SiblingIdentity): Promise<NameTwinSummary> {
  const summary: NameTwinSummary = { status: "ok", candidates: 0, commonNamesSkipped: 0, judged: 0, reused: 0, pending: 0, same: 0, error: null };
  try {
    const { pairs, commonNamesSkipped } = nameTwinPairs(await previousPeople(scope));
    summary.candidates = pairs.length;
    summary.commonNamesSkipped = commonNamesSkipped;
    if (pairs.length === 0) return summary;
    const recorded = await db
      .select()
      .from(samePersonVerdicts)
      .where(and(eq(samePersonVerdicts.orgId, scope.orgId), eq(samePersonVerdicts.brandId, scope.brandId)));
    const byPair = new Map(recorded.map((r) => [`${r.keyA}|${r.keyB}`, r]));
    const todo: TwinPair[] = [];
    for (const p of pairs) {
      const prior = byPair.get(`${p.a.personKey}|${p.b.personKey}`);
      // Rejected by a user = never again; same = they merge (the pair goes); different = asked again only if they moved.
      if (prior && (prior.rejectedAt || prior.verdict === "same" || prior.inputHash === sameHumanQuestion(p, { a: [], b: [] }, null).hash)) {
        summary.reused++;
        continue;
      }
      todo.push(p);
    }
    if (todo.length === 0) return summary;
    const batch = todo.slice(0, MAX_PER_BUILD);
    summary.pending = todo.length - batch.length;
    const brand = await siblingGetOk<{ brand: { name: string } }>("brand", `/internal/brands/${encodeURIComponent(scope.brandId)}`, identity);
    const tracking: ChatTrackingHeaders = { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [identity.brandId] };
    let firstError: string | null = null;
    await mapLimit(batch, CONCURRENCY, async (pair) => {
      try {
        const messages = { a: await latestMessages(scope.id, pair.a.emails), b: await latestMessages(scope.id, pair.b.emails) };
        const { state, question, hash } = sameHumanQuestion(pair, messages, brand.brand.name);
        const result = await judgeChoices(state, { same: question }, tracking);
        const answer = result.answers.same;
        if (!answer || answer.type !== "choice" || typeof answer.probabilities?.same_human !== "number") {
          throw new Error(`[crm-service][name-twins] no same_human probability for ${pair.a.personKey} / ${pair.b.personKey}`);
        }
        const verdict = twinVerdict(answer);
        const row = {
          orgId: scope.orgId,
          brandId: scope.brandId,
          keyA: pair.a.personKey,
          keyB: pair.b.personKey,
          name: pair.name,
          keysA: pair.a.identityKeys,
          keysB: pair.b.identityKeys,
          inputHash: hash,
          verdict,
          probabilitySame: answer.probabilities.same_human,
          model: result.model,
          runId: identity.runId,
          judgedAt: new Date(),
        };
        // A rejected pair is never re-judged (filtered above), so the update never touches a user's statement.
        await db
          .insert(samePersonVerdicts)
          .values(row)
          .onConflictDoUpdate({
            target: [samePersonVerdicts.orgId, samePersonVerdicts.brandId, samePersonVerdicts.keyA, samePersonVerdicts.keyB],
            set: { name: row.name, keysA: row.keysA, keysB: row.keysB, inputHash: hash, verdict, probabilitySame: row.probabilitySame, model: row.model, runId: row.runId, judgedAt: row.judgedAt },
            setWhere: isNull(samePersonVerdicts.rejectedAt),
          });
        summary.judged++;
        if (verdict === "same") summary.same++;
      } catch (err) {
        firstError ??= (err as Error).message.slice(0, 1000);
      }
    });
    if (firstError) {
      summary.status = summary.judged > 0 ? "ok" : "failed";
      summary.error = firstError;
      console.warn(`[crm-service] name twins scope=${scope.id}: ${firstError}`);
    }
  } catch (err) {
    summary.status = "failed";
    summary.error = (err as Error).message.slice(0, 1000);
    console.error(`[crm-service] name twins failed scope=${scope.id}:`, err);
  }
  return summary;
}

/** Every `same` verdict of the brand nobody rejected, as build evidence. */
export async function readNameTwinEvidence(orgId: string, brandId: string) {
  const rows = await db
    .select({ id: samePersonVerdicts.id, keysA: samePersonVerdicts.keysA, keysB: samePersonVerdicts.keysB })
    .from(samePersonVerdicts)
    .where(
      and(
        eq(samePersonVerdicts.orgId, orgId),
        eq(samePersonVerdicts.brandId, brandId),
        eq(samePersonVerdicts.verdict, "same"),
        isNull(samePersonVerdicts.rejectedAt),
      ),
    );
  return { kind: "name_twin" as const, status: "ok" as const, error: null, evidence: rows.map(twinEvidence) };
}

export interface TwinVerdictView {
  verdictId: string;
  name: string;
  verdict: "same" | "different";
  probabilitySame: number;
  keysA: string[];
  keysB: string[];
  judgedAt: string;
  rejected: { at: string; byUserId: string | null; reason: string | null } | null;
}

export const twinVerdictView = (v: SamePersonVerdict): TwinVerdictView => ({
  verdictId: v.id,
  name: v.name,
  verdict: v.verdict as "same" | "different",
  probabilitySame: v.probabilitySame,
  keysA: v.keysA as string[],
  keysB: v.keysB as string[],
  judgedAt: v.judgedAt.toISOString(),
  rejected: v.rejectedAt ? { at: v.rejectedAt.toISOString(), byUserId: v.rejectedByUserId, reason: v.rejectedReason } : null,
});

/** Every verdict of the brand, newest first. */
export async function listTwinVerdicts(orgId: string, brandId: string): Promise<SamePersonVerdict[]> {
  return db
    .select()
    .from(samePersonVerdicts)
    .where(and(eq(samePersonVerdicts.orgId, orgId), eq(samePersonVerdicts.brandId, brandId)))
    .orderBy(desc(samePersonVerdicts.judgedAt), desc(samePersonVerdicts.id));
}

/** "Not the same person": the verdict is rejected for good (idempotent). null = no such verdict on the brand. */
export async function rejectTwinVerdict(input: {
  orgId: string;
  brandId: string;
  verdictId: string;
  userId: string;
  reason: string | null;
}): Promise<{ verdict: SamePersonVerdict; duplicate: boolean } | null> {
  const where = and(
    eq(samePersonVerdicts.id, input.verdictId),
    eq(samePersonVerdicts.orgId, input.orgId),
    eq(samePersonVerdicts.brandId, input.brandId),
  );
  const [row] = await db.select().from(samePersonVerdicts).where(where);
  if (!row) return null;
  if (row.rejectedAt) return { verdict: row, duplicate: true };
  const [updated] = await db
    .update(samePersonVerdicts)
    .set({ rejectedAt: new Date(), rejectedByUserId: input.userId, rejectedReason: input.reason })
    .where(and(where, isNull(samePersonVerdicts.rejectedAt)))
    .returning();
  return updated ? { verdict: updated, duplicate: false } : { verdict: row, duplicate: true };
}
