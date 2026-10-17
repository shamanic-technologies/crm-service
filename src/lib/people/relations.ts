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
 *     > Jev reading the point's OWN content with the person's known companies as the options, else unknown
 *     (`contact_point_org_verdicts`, judged once, re-asked when the point moves or the options change)
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
  presence: Presence;
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

export const POINT_ORG_CRITERIA_VERSION = 1;
export const UNKNOWN = "unknown";

export interface PointToJudge {
  id: string;
  /** Re-judged when this moves (the thread's watermark, or the record's digest). */
  judgedThrough: string;
  content: unknown;
}

/** The point's own content Jev reads: its thread (as recorded for the tag judgment) or its record. */
async function pointContents(identity: SiblingIdentity, points: { reading: ContactPointReading; convKey: string | null }[]): Promise<Map<string, PointToJudge>> {
  const keys = points.map((p) => p.convKey).filter((k): k is string => !!k);
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
  for (const { reading, convKey } of points) {
    const p = reading.presence;
    const record = {
      source: p.source,
      name: p.displayName ? clip(p.displayName) : null,
      company: p.company ? clip(p.company) : null,
      emails: p.emails,
      phones: p.phones,
    };
    const c = convKey ? conv.get(convKey) : undefined;
    if (c) {
      const messages = ((c.input as { messages?: { at: string | null; direction: string; subject?: string | null; text: string }[] })?.messages ?? []).map(
        (m) => ({ at: m.at, direction: m.direction, subject: m.subject ? clip(m.subject) : null, text: clip(m.text) }),
      );
      out.set(reading.id, { id: reading.id, judgedThrough: `conv:${c.judgedThrough}`, content: { record, messages: threadWindow(messages) } });
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
 * companies: Jev says which one it speaks for, or unknown. Recorded; re-asked only when the point moves
 * or the options change. Fail-soft: a failure leaves the point unknown this build.
 */
export async function resolvePointCompanies(
  identity: SiblingIdentity,
  persons: { readings: ContactPointReading[]; known: PointCompany[] }[],
): Promise<{ answers: Map<string, PointCompany | null>; summary: PointOrgSummary }> {
  const todo: { reading: ContactPointReading; known: PointCompany[]; convKey: string | null }[] = [];
  for (const { readings, known } of persons) {
    if (known.length === 0) continue;
    for (const r of readings) {
      if (r.capacity !== "professional" || r.companies.length > 0) continue;
      const p = r.presence;
      const convKey =
        p.source === "gmail" && p.emails[0]
          ? `gmail:${p.emails[0]}`
          : p.source === "matrix" && typeof p.detail.conversationId === "string"
            ? `matrix:${p.detail.conversationId}`
            : null;
      todo.push({ reading: r, known, convKey });
    }
  }
  const answers = new Map<string, PointCompany | null>();
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
  const answerOf = (choice: string, confidence: number, known: PointCompany[]): PointCompany | null => {
    if (choice === UNKNOWN || confidence < ORGANIZATION_MIN_CONFIDENCE) return null;
    const k = known.find((x) => x.companyId === choice);
    return k ? { companyId: k.companyId, domain: k.domain, basis: "jev" } : null;
  };
  const toJudge = todo.filter((t) => {
    const s = stored.get(t.reading.id);
    const through = contents.get(t.reading.id)!.judgedThrough;
    if (s && s.judgedThrough === through && s.optionsHash === optionsHash(t.known) && s.criteriaVersion === POINT_ORG_CRITERIA_VERSION) {
      answers.set(t.reading.id, answerOf(s.choice, s.confidence, t.known));
      summary.reused++;
      return false;
    }
    return true;
  });
  const tracking: ChatTrackingHeaders = { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [identity.brandId] };
  const errors: string[] = [];
  await mapLimit(toJudge, 4, async (t) => {
    try {
      const criteria: Record<string, string> = {};
      t.known.forEach((k) => {
        criteria[k.companyId] = `the person uses this contact point for their work at ${k.domain}`;
      });
      criteria[UNKNOWN] = "nothing in it says which of these companies, or it is about another one";
      const question: ChoiceQuestion = {
        type: "choice",
        instructions:
          "A person reached a business through several contact points (addresses, numbers, threads, accounts). Read THIS " +
          "contact point's own content (its record and messages: a signature, a company name, what the work is about): " +
          "for which of the person's companies does it speak?",
        criteria,
      };
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
      answers.set(t.reading.id, answerOf(a.choice, a.confidence, t.known));
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
    byId.set(id, { id, source: p.source, capacity, tags, companies, presence: p });
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
  jev: Map<string, PointCompany | null>,
  corrections: PeopleCorrection[],
): PersonRelation[] {
  const companiesOf = new Map<string, PointCompany[]>();
  for (const r of readings) {
    if (r.capacity !== "professional") continue;
    const j = jev.get(r.id);
    companiesOf.set(r.id, r.companies.length ? [...r.companies] : j ? [j] : []);
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
    for (const e of r.presence.emails) if (!rel.emails.includes(e)) rel.emails.push(e);
    for (const p of r.presence.phones) if (!rel.phones.includes(p)) rel.phones.push(p);
    for (const k of r.presence.keys ?? []) if (!rel.keys.includes(k)) rel.keys.push(k);
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
