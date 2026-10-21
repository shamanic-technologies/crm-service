/**
 * USER CORRECTIONS of what the registry worked out on its own (PEOPLE-CORRECTIONS-1017).
 *
 * Owner 2026-10-17: a user can correct the matching, whatever decided it (Jev, a domain verdict, a
 * source record). Same pattern as stated merges (people/merges.ts): a correction is a STATEMENT,
 * recorded with who / when / why, never deleted (undo sets `undone_at`), and every people build
 * applies it on top of the automatic answer: a human statement always wins, a model never overrides it.
 *
 * Kinds:
 *   tag_add / tag_remove                one of the four connection tags on a person
 *   organization_add / _remove          the person speaks / does not speak for a company
 *   domain_kind                         an email domain IS a public mailbox, or IS one organization's
 *                                       (overrides Jev's domain verdict for this brand's people)
 * A person is named by its personId; the statement keeps every identity key it held then, so it
 * follows the person through rebuilds (merges, new ids), like a stated merge.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { companyKeys, peopleCorrections, type PeopleCorrection, type Person } from "../../db/schema.js";
import { resolveCompanies } from "../companies/client.js";
import { CONNECTION_TAGS, type ConnectionTag, type PersonConnectionTag } from "./connection-tags.js";
import { domainOfWebsite, type DomainKind, type PersonOrganization } from "./organizations.js";
import { findPersonById } from "./person-id.js";
import { presenceStableKey } from "./facts.js";
import type { Presence } from "./identity.js";

export const CORRECTION_KINDS = ["tag_add", "tag_remove", "organization_add", "organization_remove", "domain_kind"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

const PERSONAL = new Set<ConnectionTag>(["personal_to_user", "personal_not_to_user"]);
/**
 * The tag a stated one contradicts: "to brand" vs "not to brand", "to user" vs "not to user".
 * A human stating one outranks the automatic answer holding the other (WHOLE-THREAD-JEV-1021:
 * drmorley carried Jev's professional_to_brand beside the user's professional_not_to_brand, and
 * lead-service read "to brand present" as a lead).
 */
const OPPOSITE: Record<ConnectionTag, ConnectionTag> = {
  personal_to_user: "personal_not_to_user",
  personal_not_to_user: "personal_to_user",
  professional_to_brand: "professional_not_to_brand",
  professional_not_to_brand: "professional_to_brand",
};
const isProfessional = (t: ConnectionTag) => !PERSONAL.has(t);

export interface CorrectionInput {
  orgId: string;
  brandId: string;
  userId: string;
  runId: string | null;
  kind: CorrectionKind;
  personId?: string;
  tag?: ConnectionTag;
  /** organization_add / domain_kind: a domain or a website. */
  domain?: string;
  /** organization_remove: brand-service's company id. */
  companyId?: string;
  /** domain_kind. */
  domainKind?: DomainKind;
  /** organization_add: how the person speaks for it (professional tags); default = their professional tags. */
  tags?: ConnectionTag[];
  /**
   * PERSON-RELATIONS-1017: one contact point of the person (`<source>:<id>`, as served on each relation's
   * `contactPoints`): the tag / company correction applies to that point only (its relation moves).
   */
  contactPoint?: string;
  reason?: string | null;
}

export type CorrectionRefusal =
  | { status: 400; reason: "invalid_correction"; error: string }
  | { status: 404; reason: "person_not_found"; error: string }
  | { status: 404; reason: "contact_point_not_found"; error: string }
  | { status: 422; reason: "company_unresolved"; error: string }
  | { status: 422; reason: "tags_required"; error: string }
  | { status: 404; reason: "correction_not_found"; error: string };

export type CorrectionOutcome = { ok: true; correction: PeopleCorrection; duplicate: boolean } | { ok: false; refusal: CorrectionRefusal };

const refuse = (r: CorrectionRefusal): CorrectionOutcome => ({ ok: false, refusal: r });

/** brand-service's company id for a domain (cached in `company_keys`, like the build's). */
async function companyOfDomain(domain: string): Promise<{ companyId: string; domain: string } | null> {
  const [known] = await db.select().from(companyKeys).where(eq(companyKeys.domain, domain));
  if (known) return known.companyId ? { companyId: known.companyId, domain } : null;
  const [a] = await resolveCompanies([{ ref: domain, domain }]);
  await db
    .insert(companyKeys)
    .values({ domain, companyId: a.brandId, companyDomain: a.domain, matchedBy: a.matchedBy, unresolvedReason: a.unresolvedReason, resolvedAt: new Date() })
    .onConflictDoNothing();
  return a.brandId ? { companyId: a.brandId, domain } : null;
}

/** PURE: what a correction states, keyed so the same statement twice is one (idempotency). */
export function correctionTarget(c: {
  kind: CorrectionKind;
  tag?: ConnectionTag;
  companyId?: string;
  domain?: string;
  domainKind?: DomainKind;
  contactPoint?: string;
}): string {
  const base = baseTarget(c);
  return c.contactPoint ? `${base}@${c.contactPoint}` : base;
}

function baseTarget(c: { kind: CorrectionKind; tag?: ConnectionTag; companyId?: string; domain?: string }): string {
  switch (c.kind) {
    case "tag_add":
    case "tag_remove":
      return `${c.kind}:${c.tag}`;
    case "organization_add":
    case "organization_remove":
      return `${c.kind}:${c.companyId}`;
    case "domain_kind":
      return `domain_kind:${c.domain}`;
  }
}

/** Record a correction (idempotent on person + what it states, while active). */
export async function stateCorrection(input: CorrectionInput): Promise<CorrectionOutcome> {
  const { kind } = input;
  let person: Person | null = null;
  if (kind !== "domain_kind") {
    if (!input.personId) return refuse({ status: 400, reason: "invalid_correction", error: `${kind} needs personId` });
    person = await findPersonById(input.orgId, input.brandId, input.personId);
    if (!person) return refuse({ status: 404, reason: "person_not_found", error: `no person ${input.personId} in this brand` });
  }
  const target: Record<string, unknown> = {};
  if (input.contactPoint) {
    if (kind === "domain_kind") return refuse({ status: 400, reason: "invalid_correction", error: "domain_kind takes no contactPoint" });
    const points = ((person!.presences as Presence[]) ?? []).map(presenceStableKey);
    if (!points.includes(input.contactPoint)) {
      return refuse({ status: 404, reason: "contact_point_not_found", error: `person ${input.personId} holds no contact point ${input.contactPoint}` });
    }
    target.contactPoint = input.contactPoint;
  }
  if (kind === "tag_add" || kind === "tag_remove") {
    if (!input.tag) return refuse({ status: 400, reason: "invalid_correction", error: `${kind} needs tag` });
    target.tag = input.tag;
  }
  if (kind === "organization_add" || kind === "domain_kind") {
    const domain = domainOfWebsite(input.domain ?? null);
    if (!domain) return refuse({ status: 400, reason: "invalid_correction", error: `${kind} needs a domain or website` });
    target.domain = domain;
  }
  if (kind === "domain_kind") {
    if (!input.domainKind) return refuse({ status: 400, reason: "invalid_correction", error: "domain_kind needs domainKind" });
    target.domainKind = input.domainKind;
  }
  if (kind === "organization_add" || (kind === "domain_kind" && input.domainKind === "organization")) {
    const company = await companyOfDomain(target.domain as string);
    if (!company) {
      return refuse({ status: 422, reason: "company_unresolved", error: `brand-service names no company for ${target.domain}` });
    }
    target.companyId = company.companyId;
  }
  if (kind === "organization_add") {
    const tags = input.tags?.length
      ? input.tags
      : ((person!.connectionTags as PersonConnectionTag[]) ?? []).map((t) => t.tag).filter(isProfessional);
    if (tags.length === 0 || tags.some((t) => !isProfessional(t))) {
      return refuse({ status: 422, reason: "tags_required", error: "say how the person speaks for it: professional_to_brand and/or professional_not_to_brand" });
    }
    target.tags = [...new Set(tags)].sort();
  }
  if (kind === "organization_remove") {
    if (!input.companyId) return refuse({ status: 400, reason: "invalid_correction", error: "organization_remove needs companyId" });
    target.companyId = input.companyId;
  }
  const targetKey = correctionTarget({
    kind,
    tag: input.tag,
    companyId: target.companyId as string | undefined,
    domain: target.domain as string | undefined,
    contactPoint: input.contactPoint,
  });
  const personKeys = person ? ((person.identityKeys as string[]) ?? []) : [];
  const existing = (
    await db
      .select()
      .from(peopleCorrections)
      .where(
        and(
          eq(peopleCorrections.orgId, input.orgId),
          eq(peopleCorrections.brandId, input.brandId),
          eq(peopleCorrections.targetKey, targetKey),
          isNull(peopleCorrections.undoneAt),
        ),
      )
  ).find((c) => (kind === "domain_kind" ? true : (c.personKeys as string[]).some((k) => personKeys.includes(k))));
  if (existing && (kind !== "domain_kind" || (existing.target as { domainKind?: string }).domainKind === input.domainKind)) {
    return { ok: true, correction: existing, duplicate: true };
  }
  const [row] = await db.transaction(async (tx) => {
    // A newer statement on the same thing replaces the older one (e.g. a domain said organization, then mailbox).
    if (existing) {
      await tx
        .update(peopleCorrections)
        .set({ undoneAt: new Date(), undoneByUserId: input.userId })
        .where(eq(peopleCorrections.id, existing.id));
    }
    // A statement that contradicts an active one (add vs remove of the same thing) takes it back.
    const opposite = kind.endsWith("_add") ? kind.replace("_add", "_remove") : kind.endsWith("_remove") ? kind.replace("_remove", "_add") : null;
    if (opposite) {
      const oppositeKey = targetKey.replace(kind, opposite);
      const contradicted = (
        await tx
          .select()
          .from(peopleCorrections)
          .where(
            and(
              eq(peopleCorrections.orgId, input.orgId),
              eq(peopleCorrections.brandId, input.brandId),
              eq(peopleCorrections.targetKey, oppositeKey),
              isNull(peopleCorrections.undoneAt),
            ),
          )
      ).filter((c) => (c.personKeys as string[]).some((k) => personKeys.includes(k)));
      for (const c of contradicted) {
        await tx.update(peopleCorrections).set({ undoneAt: new Date(), undoneByUserId: input.userId }).where(eq(peopleCorrections.id, c.id));
      }
    }
    return tx
      .insert(peopleCorrections)
      .values({
        orgId: input.orgId,
        brandId: input.brandId,
        kind,
        personId: input.personId ?? null,
        personKeys,
        target,
        targetKey,
        reason: input.reason ?? null,
        statedByUserId: input.userId,
        runId: input.runId,
      })
      .returning();
  });
  return { ok: true, correction: row, duplicate: false };
}

export async function undoCorrection(input: { orgId: string; brandId: string; correctionId: string; userId: string }): Promise<CorrectionOutcome> {
  const [row] = await db
    .select()
    .from(peopleCorrections)
    .where(and(eq(peopleCorrections.id, input.correctionId), eq(peopleCorrections.orgId, input.orgId), eq(peopleCorrections.brandId, input.brandId)));
  if (!row) return refuse({ status: 404, reason: "correction_not_found", error: `no correction ${input.correctionId} in this brand` });
  if (row.undoneAt) return { ok: true, correction: row, duplicate: true };
  const [done] = await db
    .update(peopleCorrections)
    .set({ undoneAt: new Date(), undoneByUserId: input.userId })
    .where(eq(peopleCorrections.id, row.id))
    .returning();
  return { ok: true, correction: done, duplicate: false };
}

export async function listCorrections(orgId: string, brandId: string): Promise<PeopleCorrection[]> {
  return db
    .select()
    .from(peopleCorrections)
    .where(and(eq(peopleCorrections.orgId, orgId), eq(peopleCorrections.brandId, brandId)))
    .orderBy(desc(peopleCorrections.createdAt), desc(peopleCorrections.id));
}

export async function activeCorrections(orgId: string, brandId: string): Promise<PeopleCorrection[]> {
  return (await listCorrections(orgId, brandId)).filter((c) => !c.undoneAt).reverse();
}

export function correctionView(c: PeopleCorrection) {
  return {
    correctionId: c.id,
    kind: c.kind as CorrectionKind,
    personId: c.personId,
    target: c.target as Record<string, unknown>,
    reason: c.reason,
    statedByUserId: c.statedByUserId,
    createdAt: c.createdAt.toISOString(),
    undoneAt: c.undoneAt?.toISOString() ?? null,
    undoneByUserId: c.undoneByUserId,
  };
}

// ─── applying them (pure, every build) ───────────────────────────────────────

/** PURE: the domain verdicts the brand's users stated (they win over Jev's). */
export function domainOverrides(corrections: PeopleCorrection[]): Map<string, { kind: DomainKind; companyId: string | null }> {
  const out = new Map<string, { kind: DomainKind; companyId: string | null }>();
  for (const c of corrections) {
    if (c.kind !== "domain_kind") continue;
    const t = c.target as { domain: string; domainKind: DomainKind; companyId?: string };
    out.set(t.domain, { kind: t.domainKind, companyId: t.companyId ?? null });
  }
  return out;
}

/** PURE: the corrections about a person: those whose stated keys the person holds. */
export function correctionsOf(identityKeys: string[], corrections: PeopleCorrection[]): PeopleCorrection[] {
  const keys = new Set(identityKeys);
  return corrections.filter((c) => c.kind !== "domain_kind" && (c.personKeys as string[]).some((k) => keys.has(k)));
}

/**
 * PURE: the person's tags and organizations once their users' statements are applied, in the
 * order they were stated (a later one wins). A correction leaves its own basis
 * (`user_correction`, ref = its id), so a reader always sees a human said it.
 */
export function applyCorrections(
  person: { connectionTags: PersonConnectionTag[]; organizations: PersonOrganization[] },
  corrections: PeopleCorrection[],
  brandId: string,
): { connectionTags: PersonConnectionTag[]; organizations: PersonOrganization[] } {
  let tags = person.connectionTags.map((t) => ({ ...t, basis: [...t.basis] }));
  let orgs = person.organizations.map((o) => ({ ...o, tags: o.tags.map((t) => ({ ...t })) }));
  for (const c of corrections) {
    // A correction of ONE contact point moves that point's relation (people/relations.ts), not the person's summary.
    if ((c.target as { contactPoint?: string }).contactPoint) continue;
    const basis = { kind: "user_correction", ref: c.id, probability: null };
    const t = c.target as { tag?: ConnectionTag; companyId?: string; domain?: string; tags?: ConnectionTag[] };
    if (c.kind === "tag_add" && t.tag) {
      // The contradicting tag goes while this statement stands, whoever held it (Jev, a source, an earlier
      // statement: corrections apply in stated order, the later wins). Undone, it is not applied: the tag comes back.
      // On a company link the stated tag takes the contradicted one's place: the person still speaks for it.
      const opposite = OPPOSITE[t.tag];
      const stated = t.tag;
      tags = tags.filter((x) => x.tag !== opposite);
      orgs = orgs.map((o) => {
        if (!o.tags.some((x) => x.tag === opposite)) return o;
        const kept = o.tags.filter((x) => x.tag !== opposite);
        const held = kept.find((x) => x.tag === stated);
        if (held) held.basis.push(basis);
        else kept.push({ tag: stated, userIds: [], brandId, basis: [basis] });
        return { ...o, tags: CONNECTION_TAGS.filter((x) => kept.some((y) => y.tag === x)).map((x) => kept.find((y) => y.tag === x)!) };
      });
      const held = tags.find((x) => x.tag === t.tag);
      if (held) held.basis.push(basis);
      else tags.push({ tag: t.tag, userIds: PERSONAL.has(t.tag) ? [c.statedByUserId] : [], brandId: PERSONAL.has(t.tag) ? null : brandId, basis: [basis] });
    }
    if (c.kind === "tag_remove" && t.tag) {
      tags = tags.filter((x) => x.tag !== t.tag);
      // A link keeps only the professional tags the person still carries; one left with none goes.
      orgs = orgs.map((o) => ({ ...o, tags: o.tags.filter((x) => x.tag !== t.tag) })).filter((o) => o.tags.length > 0);
    }
    if (c.kind === "organization_remove" && t.companyId) orgs = orgs.filter((o) => o.companyId !== t.companyId);
    if (c.kind === "organization_add" && t.companyId && t.domain) {
      const linkTags: PersonConnectionTag[] = (t.tags ?? []).map((tag) => ({ tag, userIds: [], brandId, basis: [basis] }));
      const held = orgs.find((o) => o.companyId === t.companyId);
      const evidence = { kind: "user" as const, value: t.domain, source: "correction" };
      if (held) {
        held.evidence.push(evidence);
        for (const lt of linkTags) {
          const h = held.tags.find((x) => x.tag === lt.tag);
          if (h) h.basis.push(basis);
          else held.tags.push(lt);
        }
      } else orgs.push({ companyId: t.companyId, domain: t.domain, evidence: [evidence], tags: linkTags });
    }
  }
  tags = CONNECTION_TAGS.filter((x) => tags.some((y) => y.tag === x)).map((x) => tags.find((y) => y.tag === x)!);
  orgs.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return { connectionTags: tags, organizations: orgs };
}
