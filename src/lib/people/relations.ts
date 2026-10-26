/**
 * RELATIONS — a human x capacity: the grain of a Unibox row (PERSON-RELATIONS-1017).
 *
 * Owner 2026-10-17: « Chaque ligne de unibox n'est pas un Human, c'est un Human x Organisation » / « Adam est
 * un ami. Je ne veux pas voir nos conv perso. Mais si tu lui as trouvé un num pro, ou des conversations ou
 * events pro dans son lien avec des orgs, oui » / « pas de cas particulier : une généralisation dans l'infra ».
 *
 * The reading moves down from the person to each CONTACT POINT (a presence: an address, a number, a thread,
 * a CRM / Stripe / Clerk / PostHog record, `presenceStableKey`):
 *   - CAPACITY from the point's own connection tags: `professional_to_brand` wins (business with the brand,
 *     even with a friend); else personal when any personal tag; else `professional_not_to_brand`; no tag =
 *     not judged yet (in no relation).
 *   - COMPANY (professional points): evidence (its own email domain, its CRM website, people/organizations.ts)
 *     > Jev reading the point's OWN content with the person's known companies as the options: a professional
 *     point speaks for the person's known work unless its content shows ANOTHER company (WA-SPLIT-RELATION-1026:
 *     a WhatsApp / Telegram / LinkedIn thread rarely names its company, so "nothing names it" filed every such
 *     chat under the company-less relation, blind to the company row's leads and follow-ups); several known
 *     companies and nothing tells which = the point joins each of them (`contact_point_org_verdicts`, judged
 *     once, re-asked when the point moves or the options change)
 *     > the user's correction (people/corrections.ts, `contactPoint` on organization_add / _remove; a person-
 *     level organization_add claims every professional point of unknown company).
 * A RELATION = the person's points with the same reading: `rel:<personId>:personal`, `rel:<personId>:org:<id>`
 * or `rel:<personId>:pro` (professional, company unknown). It carries ONLY its points' emails, phones, keys
 * and tags; the thread read by `relationKey` serves only its points.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contactPointOrgVerdicts, conversationVerdicts, type PeopleCorrection } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { judgeChoices, type ChoiceQuestion } from "../judgments-client.js";
import { CONNECTION_TAGS, presenceConnectionTags, type ConnectionTag, type PersonConnectionTag, type TagLookups } from "./connection-tags.js";
import { presenceStableKey } from "./facts.js";
import type { Presence } from "./identity.js";
import {
  domainOfEmail,
  domainOfWebsite,
  ORGANIZATION_MIN_CONFIDENCE,
  presenceDomains,
  type DomainKind,
} from "./organizations.js";
import { clip, threadWindow } from "./relevance.js";
import { mapLimit, type SiblingIdentity } from "./siblings.js";

export type Capacity = "personal" | "professional";

const PERSONAL = new Set<ConnectionTag>(["personal_to_user", "personal_not_to_user"]);

/** PURE: a point's capacity from its own tags (null = not judged yet). */
export function capacityOf(tags: ConnectionTag[]): Capacity | null {
  if (tags.includes("professional_to_brand")) return "professional";
  if (tags.some((t) => PERSONAL.has(t))) return "personal";
  if (tags.includes("professional_not_to_brand")) return "professional";
  return null;
}

export interface PointCompany {
  companyId: string;
  domain: string;
  /** evidence = its own domain / CRM website; jev = Jev read its content; user = a correction. */
  basis: "evidence" | "jev" | "user";
}

export interface ContactPointReading {
  id: string;
  source: string;
  capacity: Capacity | null;
  tags: PersonConnectionTag[];
  companies: PointCompany[];
  /** The point's most recently active presence (its record as Jev reads it). */
  presence: Presence;
  /**
   * EVERY presence of the point: one WhatsApp contact can hold several threads (a LID chat and a phone chat,
   * same `channelHandle`). Keeping only the last one read hid MARTIAN's 2026-10-22 thread (WA-SPLIT-RELATION-1026).
   */
  presences: Presence[];
}

export interface PersonRelation {
  relationKey: string;
  capacity: Capacity;
  companyId: string | null;
  domain: string | null;
  tags: PersonConnectionTag[];
  contactPoints: { id: string; source: string; companyBasis: PointCompany["basis"] | null }[];
  emails: string[];
  phones: string[];
  /** Other identity keys of its points (messaging handles, the brand's user ids). */
  keys: string[];
}

export const relationKeyOf = (personId: string, capacity: Capacity, companyId: string | null) =>
  capacity === "personal" ? `rel:${personId}:personal` : companyId ? `rel:${personId}:org:${companyId}` : `rel:${personId}:pro`;

/** PURE: `rel:<personId>:...` -> its person id; null when not a relation key. */
export function personIdOfRelationKey(key: string): string | null {
  const m = /^rel:([0-9a-f-]{36}):(personal|pro|org:[0-9a-f-]{36})$/.exec(key);
  return m ? m[1] : null;
}

/** PURE: the companies a point's own evidence names. */
export function evidenceCompanies(
  p: Presence,
  kinds: Map<string, { kind: DomainKind; confidence: number }>,
  companyOf: Map<string, string>,
  websiteOf: (p: { source: string; detail: Record<string, unknown> }) => string | null,
): PointCompany[] {
  const out = new Map<string, PointCompany>();
  for (const ev of presenceDomains(p, websiteOf)) {
    const d = ev.kind === "email" ? domainOfEmail(ev.value) : domainOfWebsite(ev.value);
    if (!d) continue;
    const k = kinds.get(d);
    if (!k || k.kind !== "organization" || k.confidence < ORGANIZATION_MIN_CONFIDENCE) continue;
    const companyId = companyOf.get(d);
    if (companyId && !out.has(companyId)) out.set(companyId, { companyId, domain: d, basis: "evidence" });
  }
  return [...out.values()];
}

// ─── Jev: which known company does a point without evidence belong to ───────

export const POINT_ORG_CRITERIA_VERSION = 2;
/** The content shows a company the person is not known at: the point stays in the company-less relation. */
export const ANOTHER_COMPANY = "another_company";
/** Several known companies and nothing tells which: the point speaks for each. */
export const ANY_KNOWN = "any_known";

/**
 * PURE: the question Jev answers for one professional point without a company of its own. The default is
 * the person's known work; only content showing another company keeps the point off it. MECE options:
 * one known company / any of them (offered only with two or more) / another company.
 */
export function pointOrgQuestion(known: PointCompany[]): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const k of known) criteria[k.companyId] = `the person speaks for their work at ${k.domain}`;
  if (known.length > 1) {
    criteria[ANY_KNOWN] = "the person speaks for their own work, and nothing in it tells which of these companies";
  }
  criteria[ANOTHER_COMPANY] =
    "the person's own words or record show they speak for a company not in this list (another employer, a side business), never the business that wrote the outbound messages";
  return {
    type: "choice",
    instructions:
      "This contact point (an address, a number, a chat thread, an account) belongs to a person already judged to use it " +
      "in a professional capacity. Their other contact points place them at the companies listed. The same person " +
      "writing from a phone or a chat app about the same work rarely names their company: a sign-up, a payment, pricing, " +
      "a meeting, questions about the offer are that same work. So the point speaks for their known company UNLESS its " +
      "own content (a signature, a company name, what the work is about) shows a different company. Outbound messages " +
      "are written by the business the person reached: that business's own name in them is never the person's company.",
    criteria,
  };
}

/** PURE: the companies a stored or fresh answer gives the point (null = none: another company, or unsure). */
export function pointOrgAnswer(choice: string, confidence: number, known: PointCompany[]): PointCompany[] | null {
  if (confidence < ORGANIZATION_MIN_CONFIDENCE) return null;
  if (choice === ANY_KNOWN) return known.length > 1 ? known.map((k) => ({ companyId: k.companyId, domain: k.domain, basis: "jev" })) : null;
  const k = known.find((x) => x.companyId === choice);
  return k ? [{ companyId: k.companyId, domain: k.domain, basis: "jev" }] : null;
}

export interface PointToJudge {
  id: string;
  /** Re-judged when this moves (the thread's watermark, or the record's digest). */
  judgedThrough: string;
  content: unknown;
}

/** The point's own content Jev reads: its thread (as recorded for the tag judgment) or its record. */
async function pointContents(identity: SiblingIdentity, points: { reading: ContactPointReading; convKeys: string[] }[]): Promise<Map<string, PointToJudge>> {
  const keys = [...new Set(points.flatMap((p) => p.convKeys))];
  const conv = new Map<string, { input: unknown; judgedThrough: string }>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await db
      .select({ key: conversationVerdicts.conversationKey, input: conversationVerdicts.input, judgedThrough: conversationVerdicts.judgedThrough })
      .from(conversationVerdicts)
      .where(
        and(
          eq(conversationVerdicts.orgId, identity.orgId),
          eq(conversationVerdicts.brandId, identity.brandId),
          inArray(conversationVerdicts.conversationKey, keys.slice(i, i + 500)),
        ),
      );
    for (const r of rows) conv.set(r.key, { input: r.input, judgedThrough: r.judgedThrough });
  }
  const out = new Map<string, PointToJudge>();
  for (const { reading, convKeys } of points) {
    const p = reading.presence;
    const record = {
      source: p.source,
      name: p.displayName ? clip(p.displayName) : null,
      company: p.company ? clip(p.company) : null,
      emails: p.emails,
      phones: p.phones,
    };
    const threads = convKeys.map((k) => conv.get(k)).filter((c): c is { input: unknown; judgedThrough: string } => !!c);
    if (threads.length) {
      // Every thread of the point, one timeline (a single thread reads exactly as before).
      const messages = threads
        .flatMap((c) => (c.input as { messages?: { at: string | null; direction: string; subject?: string | null; text: string }[] })?.messages ?? [])
        .map((m) => ({ at: m.at, direction: m.direction, subject: m.subject ? clip(m.subject) : null, text: clip(m.text) }))
        .sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? -1 : (a.at ?? "") > (b.at ?? "") ? 1 : 0));
      const through = threads.map((c) => c.judgedThrough).sort().join(",");
      out.set(reading.id, { id: reading.id, judgedThrough: `conv:${through}`, content: { record, messages: threadWindow(messages) } });
    } else {
      const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16);
      out.set(reading.id, { id: reading.id, judgedThrough: `rec:${digest}`, content: { record } });
    }
  }
  return out;
}

export interface PointOrgSummary {
  status: "ok" | "failed";
  candidates: number;
  reused: number;
  judged: number;
  error: string | null;
}

/**
 * For every professional point of a person with no company of its own while the person holds known
 * companies: Jev says which one(s) it speaks for (the known work by default), or another company. Recorded;
 * re-asked only when the point moves
 * or the options change. Fail-soft: a failure leaves the point unknown this build.
 */
export async function resolvePointCompanies(
  identity: SiblingIdentity,
  persons: { readings: ContactPointReading[]; known: PointCompany[] }[],
): Promise<{ answers: Map<string, PointCompany[] | null>; summary: PointOrgSummary }> {
  const todo: { reading: ContactPointReading; known: PointCompany[]; convKeys: string[] }[] = [];
  for (const { readings, known } of persons) {
    if (known.length === 0) continue;
    for (const r of readings) {
      if (r.capacity !== "professional" || r.companies.length > 0) continue;
      todo.push({ reading: r, known, convKeys: pointConversationKeys(r) });
    }
  }
  const answers = new Map<string, PointCompany[] | null>();
  const summary: PointOrgSummary = { status: "ok", candidates: todo.length, reused: 0, judged: 0, error: null };
  if (todo.length === 0) return { answers, summary };

  const contents = await pointContents(identity, todo);
  const optionsHash = (known: PointCompany[]) => [...known.map((k) => k.companyId)].sort().join(",");
  const stored = new Map<string, typeof contactPointOrgVerdicts.$inferSelect>();
  const ids = todo.map((t) => t.reading.id);
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db
      .select()
      .from(contactPointOrgVerdicts)
      .where(
        and(
          eq(contactPointOrgVerdicts.orgId, identity.orgId),
          eq(contactPointOrgVerdicts.brandId, identity.brandId),
          inArray(contactPointOrgVerdicts.contactPoint, ids.slice(i, i + 1000)),
        ),
      );
    for (const r of rows) stored.set(r.contactPoint, r);
  }
  const toJudge = todo.filter((t) => {
    const s = stored.get(t.reading.id);
    const through = contents.get(t.reading.id)!.judgedThrough;
    if (s && s.judgedThrough === through && s.optionsHash === optionsHash(t.known) && s.criteriaVersion === POINT_ORG_CRITERIA_VERSION) {
      answers.set(t.reading.id, pointOrgAnswer(s.choice, s.confidence, t.known));
      summary.reused++;
      return false;
    }
    return true;
  });
  const tracking: ChatTrackingHeaders = { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [identity.brandId] };
  const errors: string[] = [];
  await mapLimit(toJudge, 4, async (t) => {
    try {
      const question = pointOrgQuestion(t.known);
      const criteria = question.criteria;
      const content = contents.get(t.reading.id)!;
      const result = await judgeChoices({ contactPoint: content.content, knownCompanies: t.known.map((k) => k.domain) }, { point: question }, tracking);
      const a = result.answers.point;
      if (!a || !(a.choice in criteria) || typeof a.confidence !== "number") throw new Error(`no company answer for ${t.reading.id}`);
      const values = {
        orgId: identity.orgId,
        brandId: identity.brandId,
        contactPoint: t.reading.id,
        choice: a.choice,
        confidence: a.confidence,
        probabilities: a.probabilities ?? {},
        optionsHash: optionsHash(t.known),
        judgedThrough: content.judgedThrough,
        criteriaVersion: POINT_ORG_CRITERIA_VERSION,
        input: content.content,
        model: result.model,
        runId: identity.runId,
        judgedAt: new Date(),
      };
      const { orgId: _o, brandId: _b, contactPoint: _c, ...set } = values;
      await db
        .insert(contactPointOrgVerdicts)
        .values(values)
        .onConflictDoUpdate({ target: [contactPointOrgVerdicts.orgId, contactPointOrgVerdicts.brandId, contactPointOrgVerdicts.contactPoint], set });
      answers.set(t.reading.id, pointOrgAnswer(a.choice, a.confidence, t.known));
      summary.judged++;
    } catch (err) {
      if (errors.length < 3) errors.push((err as Error).message.slice(0, 300));
    }
  });
  if (errors.length) {
    summary.status = "failed";
    summary.error = errors.join(" | ");
  }
  return { answers, summary };
}

// ─── readings and relations (pure) ───────────────────────────────────────────

/** PURE: the recorded conversation keys of every thread of a point (as the tag judgment keyed them). */
export function pointConversationKeys(r: ContactPointReading): string[] {
  const out = new Set<string>();
  for (const p of r.presences) {
    if (p.source === "gmail" && p.emails[0]) out.add(`gmail:${p.emails[0]}`);
    else if (p.source === "matrix" && typeof p.detail.conversationId === "string") out.add(`matrix:${p.detail.conversationId}`);
  }
  return [...out];
}

/** PURE: every point's capacity, tags and evidence companies. */
export function readPoints(
  presences: Presence[],
  x: TagLookups,
  kinds: Map<string, { kind: DomainKind; confidence: number }>,
  companyOf: Map<string, string>,
  websiteOf: (p: { source: string; detail: Record<string, unknown> }) => string | null,
): ContactPointReading[] {
  const byId = new Map<string, ContactPointReading>();
  for (const p of presences) {
    const id = presenceStableKey(p);
    let tags = presenceConnectionTags(p, x);
    // An automated sender's address is a machine of a company, never a friend.
    if (x.automated && p.source === "gmail" && tags.length === 0) {
      tags = [{ tag: "professional_not_to_brand", userIds: [], brandId: x.brandId, basis: [{ kind: "automated_sender", ref: "sender_verdicts", probability: null }] }];
    }
    const capacity = capacityOf(tags.map((t) => t.tag));
    // Evidence is read on every point: a correction can make a point professional later.
    const companies = evidenceCompanies(p, kinds, companyOf, websiteOf);
    const held = byId.get(id);
    if (!held) {
      byId.set(id, { id, source: p.source, capacity, tags, companies, presence: p, presences: [p] });
      continue;
    }
    // Another thread of the same point: one reading over all of them (tags and companies unioned).
    held.presences.push(p);
    if ((p.lastActivityAt ?? "") > (held.presence.lastActivityAt ?? "")) held.presence = p;
    for (const t of tags) {
      const h = held.tags.find((x) => x.tag === t.tag);
      if (!h) held.tags.push({ ...t, userIds: [...t.userIds], basis: [...t.basis] });
      else {
        for (const u of t.userIds) if (!h.userIds.includes(u)) h.userIds.push(u);
        for (const b of t.basis) if (!h.basis.some((x) => x.kind === b.kind && x.ref === b.ref)) h.basis.push(b);
      }
    }
    for (const c of companies) if (!held.companies.some((x) => x.companyId === c.companyId)) held.companies.push(c);
  }
  for (const r of byId.values()) {
    if (r.presences.length < 2) continue;
    r.tags = CONNECTION_TAGS.filter((t) => r.tags.some((x) => x.tag === t)).map((t) => r.tags.find((x) => x.tag === t)!);
    r.capacity = capacityOf(r.tags.map((t) => t.tag));
  }
  return [...byId.values()];
}

/**
 * PURE: the users' tag corrections applied to the points (in the order stated): with `contactPoint`, that
 * point only; without, every point of the person (a tag removed from the person leaves all its points). A
 * point's capacity is re-read after.
 */
export function correctPointTags(readings: ContactPointReading[], corrections: PeopleCorrection[], brandId: string): ContactPointReading[] {
  const out = readings.map((r) => ({ ...r, tags: r.tags.map((t) => ({ ...t, basis: [...t.basis] })) }));
  for (const c of corrections) {
    if (c.kind !== "tag_add" && c.kind !== "tag_remove") continue;
    const t = c.target as { tag?: ConnectionTag; contactPoint?: string };
    if (!t.tag) continue;
    const tag = t.tag;
    for (const r of out) {
      if (t.contactPoint && r.id !== t.contactPoint) continue;
      if (c.kind === "tag_remove") r.tags = r.tags.filter((x) => x.tag !== tag);
      else if (!r.tags.some((x) => x.tag === tag)) {
        r.tags.push({
          tag,
          userIds: PERSONAL.has(tag) ? [c.statedByUserId] : [],
          brandId: PERSONAL.has(tag) ? null : brandId,
          basis: [{ kind: "user_correction", ref: c.id, probability: null }],
        });
      }
    }
  }
  for (const r of out) {
    r.tags = CONNECTION_TAGS.filter((t) => r.tags.some((x) => x.tag === t)).map((t) => r.tags.find((x) => x.tag === t)!);
    r.capacity = capacityOf(r.tags.map((t) => t.tag));
  }
  return out;
}

/** PURE: the companies a person's points name by evidence (the options Jev chooses among). */
export const knownCompanies = (readings: ContactPointReading[]): PointCompany[] => {
  const out = new Map<string, PointCompany>();
  for (const r of readings) if (r.capacity === "professional") for (const c of r.companies) if (!out.has(c.companyId)) out.set(c.companyId, c);
  return [...out.values()];
};

/**
 * PURE: the person's relations. Each point's company: evidence, else Jev's answer, then the user's
 * corrections in the order stated (`contactPoint` set = that point; unset organization_add = every
 * professional point of unknown company; organization_remove = the company leaves those points).
 */
export function personRelations(
  personId: string,
  readings: ContactPointReading[],
  jev: Map<string, PointCompany[] | null>,
  corrections: PeopleCorrection[],
): PersonRelation[] {
  const companiesOf = new Map<string, PointCompany[]>();
  for (const r of readings) {
    if (r.capacity !== "professional") continue;
    const j = jev.get(r.id);
    companiesOf.set(r.id, r.companies.length ? [...r.companies] : j ? [...j] : []);
  }
  for (const c of corrections) {
    const t = c.target as { companyId?: string; domain?: string; contactPoint?: string };
    if (!t.companyId) continue;
    const targets = readings.filter((r) => r.capacity === "professional" && (t.contactPoint ? r.id === t.contactPoint : true));
    for (const r of targets) {
      const list = companiesOf.get(r.id) ?? [];
      if (c.kind === "organization_add") {
        if (!t.contactPoint && list.length > 0) continue;
        if (!list.some((x) => x.companyId === t.companyId)) list.push({ companyId: t.companyId, domain: t.domain ?? "", basis: "user" });
        companiesOf.set(r.id, list);
      }
      if (c.kind === "organization_remove") companiesOf.set(r.id, list.filter((x) => x.companyId !== t.companyId));
    }
  }
  const relations = new Map<string, PersonRelation & { tagMap: Map<ConnectionTag, PersonConnectionTag> }>();
  const join = (key: string, capacity: Capacity, company: PointCompany | null, r: ContactPointReading) => {
    const rel =
      relations.get(key) ??
      ({
        relationKey: key,
        capacity,
        companyId: company?.companyId ?? null,
        domain: company?.domain || null,
        tags: [],
        contactPoints: [],
        emails: [],
        phones: [],
        keys: [],
        tagMap: new Map(),
      } as PersonRelation & { tagMap: Map<ConnectionTag, PersonConnectionTag> });
    rel.contactPoints.push({ id: r.id, source: r.source, companyBasis: company?.basis ?? null });
    for (const pr of r.presences) {
      for (const e of pr.emails) if (!rel.emails.includes(e)) rel.emails.push(e);
      for (const p of pr.phones) if (!rel.phones.includes(p)) rel.phones.push(p);
      for (const k of pr.keys ?? []) if (!rel.keys.includes(k)) rel.keys.push(k);
    }
    for (const t of r.tags) {
      const held = rel.tagMap.get(t.tag);
      if (!held) rel.tagMap.set(t.tag, { ...t, userIds: [...t.userIds], basis: [...t.basis] });
      else {
        for (const u of t.userIds) if (!held.userIds.includes(u)) held.userIds.push(u);
        for (const b of t.basis) if (!held.basis.some((h) => h.kind === b.kind && h.ref === b.ref)) held.basis.push(b);
      }
    }
    relations.set(key, rel);
  };
  for (const r of readings) {
    if (r.capacity === null) continue;
    if (r.capacity === "personal") {
      join(relationKeyOf(personId, "personal", null), "personal", null, r);
      continue;
    }
    const list = companiesOf.get(r.id) ?? [];
    if (list.length === 0) join(relationKeyOf(personId, "professional", null), "professional", null, r);
    for (const c of list) join(relationKeyOf(personId, "professional", c.companyId), "professional", c, r);
  }
  return [...relations.values()]
    .map(({ tagMap, ...rel }) => ({
      ...rel,
      tags: CONNECTION_TAGS.filter((t) => tagMap.has(t)).map((t) => tagMap.get(t)!),
      emails: rel.emails.sort(),
      phones: rel.phones.sort(),
      keys: rel.keys.sort(),
    }))
    .sort((a, b) => (a.relationKey < b.relationKey ? -1 : 1));
}
