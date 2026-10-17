/**
 * ORGANIZATIONS — the company a human speaks for (PERSON-ORGANIZATIONS-1017).
 *
 * Owner 2026-10-17: every fact is attached to a humanId and, when the person speaks in their
 * professional role, to an organization; each human x organization link and each organization
 * carries at least one connection tag (people/connection-tags.ts), the professional ones.
 *
 * - Company IDENTITY is brand-service's (`lib/companies/client.ts`): a company is a brand row, same
 *   domain = same id. crm-service states the evidence its tools hold and attaches the answer.
 * - Evidence, per presence of the person: every address's domain (a work email), and a CRM
 *   contact's website. Never a company NAME (no identity).
 * - A public mailbox domain (gmail.com, outlook.com, orange.fr...) is nobody's company: Jev judges
 *   each DOMAIN once, fleet-wide (`domain_verdicts`), never a list of ours. Unjudged = no link yet.
 * - The link exists only where the person speaks professionally: its tags = the professional tags
 *   of the presence(s) giving the evidence (a friend writing from a work address, judged personal
 *   only, gets no link). An organization's own tags = the union of its links' tags.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { companyKeys, domainVerdicts } from "../../db/schema.js";
import type { ChatTrackingHeaders } from "../chat-client.js";
import { resolveCompanies, MAX_COMPANIES_PER_RESOLVE } from "../companies/client.js";
import { judgeQuestions, type ChoiceQuestion } from "../judgments-client.js";
import { normalizeEmail } from "./identity.js";
import {
  presenceConnectionTags,
  professionalTags,
  type PersonConnectionTag,
  type PersonLikeForTags,
  type TagLookups,
} from "./connection-tags.js";
import { mapLimit, type SiblingIdentity } from "./siblings.js";

export const DOMAIN_KINDS = ["mailbox_provider", "organization"] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];
/** A domain is a company's only when Jev says organization at this confidence or more. */
export const ORGANIZATION_MIN_CONFIDENCE = 0.5;
const DOMAINS_PER_CALL = 100;
const CONCURRENCY = 4;

const DOMAIN_CRITERIA: Record<DomainKind, string> = {
  mailbox_provider:
    "a PUBLIC email service anyone can open a personal address on: gmail.com, googlemail.com, outlook.com, hotmail.*, " +
    "live.com, yahoo.*, icloud.com, me.com, aol.com, proton.me, gmx.*, orange.fr, free.fr, web.de, mail.ru, qq.com, " +
    "an internet provider's customer mail, a disposable or forwarding address service.",
  organization:
    "the domain of ONE organization the address holder belongs to: a company, a firm, a clinic, a school or " +
    "university, a government body, a nonprofit, a professional association.",
};

/** PURE: the domain of an address, lower case; null when it is no address. */
export function domainOfEmail(email: string): string | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const d = e.slice(e.lastIndexOf("@") + 1).trim();
  return d.includes(".") ? d : null;
}

/** PURE: the host of a website the CRM states (`https://www.acme.com/about` -> `acme.com`); null when none. */
export function domainOfWebsite(website: string | null | undefined): string | null {
  if (!website?.trim()) return null;
  const raw = website.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  return host.includes(".") ? host : null;
}

// ─── domain verdicts (Jev, once per domain, fleet-wide) ──────────────────────

export interface DomainVerdictsSummary {
  status: "ok" | "failed";
  domains: number;
  reused: number;
  judged: number;
  pending: number;
  error: string | null;
}

/** Each domain's kind: recorded ones reused, the rest judged now (100 per Jev call). */
export async function resolveDomainKinds(
  domains: string[],
  tracking: ChatTrackingHeaders,
): Promise<{ kinds: Map<string, { kind: DomainKind; confidence: number }>; summary: DomainVerdictsSummary }> {
  const kinds = new Map<string, { kind: DomainKind; confidence: number }>();
  for (let i = 0; i < domains.length; i += 1000) {
    const rows = await db.select().from(domainVerdicts).where(inArray(domainVerdicts.domain, domains.slice(i, i + 1000)));
    for (const r of rows) kinds.set(r.domain, { kind: r.kind as DomainKind, confidence: r.confidence });
  }
  const reused = kinds.size;
  const todo = domains.filter((d) => !kinds.has(d));
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += DOMAINS_PER_CALL) batches.push(todo.slice(i, i + DOMAINS_PER_CALL));
  const errors: string[] = [];
  let judged = 0;
  await mapLimit(batches, CONCURRENCY, async (batch) => {
    try {
      const questions: Record<string, ChoiceQuestion> = {};
      batch.forEach((d, k) => {
        questions[`d${k}`] = {
          type: "choice",
          instructions: `Is the email domain "${d}" a public mailbox provider, or the domain of one organization?`,
          criteria: DOMAIN_CRITERIA,
        };
      });
      const state = {
        task:
          "Email addresses reach us from people. For each email DOMAIN, say whether it is a public mailbox provider " +
          "(the address says nothing about where the person works) or one organization's own domain (the person " +
          "belongs to that organization).",
      };
      const result = await judgeQuestions(state, questions, tracking);
      const rows = batch.map((d, k) => {
        const a = result.answers[`d${k}`];
        if (!a || a.type !== "choice" || !(DOMAIN_KINDS as readonly string[]).includes(a.choice) || typeof a.confidence !== "number") {
          throw new Error(`no domain kind for ${d}`);
        }
        return {
          domain: d,
          kind: a.choice,
          confidence: a.confidence,
          probabilities: a.probabilities,
          model: result.model,
          runId: tracking.runId,
          judgedAt: new Date(),
        };
      });
      await db.insert(domainVerdicts).values(rows).onConflictDoNothing();
      for (const r of rows) kinds.set(r.domain, { kind: r.kind as DomainKind, confidence: r.confidence });
      judged += rows.length;
    } catch (err) {
      if (errors.length < 3) errors.push((err as Error).message.slice(0, 300));
    }
  });
  return {
    kinds,
    summary: {
      status: errors.length ? "failed" : "ok",
      domains: domains.length,
      reused,
      judged,
      pending: domains.length - kinds.size,
      error: errors.length ? errors.join(" | ") : null,
    },
  };
}

// ─── company ids (brand-service, cached per domain) ──────────────────────────

export interface CompanyResolveSummary {
  status: "ok" | "failed";
  domains: number;
  reused: number;
  resolved: number;
  unresolved: number;
  error: string | null;
}

/** domain -> company id: recorded answers reused, the rest asked of brand-service (1000 per call). */
export async function resolveCompanyIds(domains: string[]): Promise<{ companyOf: Map<string, string>; summary: CompanyResolveSummary }> {
  const companyOf = new Map<string, string>();
  const known = new Set<string>();
  for (let i = 0; i < domains.length; i += 1000) {
    const rows = await db.select().from(companyKeys).where(inArray(companyKeys.domain, domains.slice(i, i + 1000)));
    for (const r of rows) {
      known.add(r.domain);
      if (r.companyId) companyOf.set(r.domain, r.companyId);
    }
  }
  const reused = known.size;
  const todo = domains.filter((d) => !known.has(d));
  let resolved = 0;
  let unresolved = 0;
  const errors: string[] = [];
  for (let i = 0; i < todo.length; i += MAX_COMPANIES_PER_RESOLVE) {
    const chunk = todo.slice(i, i + MAX_COMPANIES_PER_RESOLVE);
    try {
      const answers = await resolveCompanies(chunk.map((d) => ({ ref: d, domain: d })));
      const rows = answers.map((a, k) => ({
        domain: chunk[k],
        companyId: a.brandId,
        companyDomain: a.domain,
        matchedBy: a.matchedBy,
        unresolvedReason: a.unresolvedReason,
        resolvedAt: new Date(),
      }));
      await db.insert(companyKeys).values(rows).onConflictDoNothing();
      for (const r of rows) {
        if (r.companyId) {
          companyOf.set(r.domain, r.companyId);
          resolved++;
        } else unresolved++;
      }
    } catch (err) {
      if (errors.length < 3) errors.push((err as Error).message.slice(0, 300));
    }
  }
  return {
    companyOf,
    summary: { status: errors.length ? "failed" : "ok", domains: domains.length, reused, resolved, unresolved, error: errors.length ? errors.join(" | ") : null },
  };
}

// ─── the person's organizations ──────────────────────────────────────────────

export interface OrganizationEvidence {
  /** email = a work address of the person; website = the website their CRM record states. */
  kind: "email" | "website";
  value: string;
  source: string;
}

export interface PersonOrganization {
  /** brand-service's company id (a brand row). */
  companyId: string;
  domain: string;
  evidence: OrganizationEvidence[];
  /** The professional tags of the presences giving the evidence: how the person speaks for it. */
  tags: PersonConnectionTag[];
}

type PresenceLike = PersonLikeForTags["presences"][number];

/** PURE: the domains a presence states as company evidence (its addresses, its CRM website). */
export function presenceDomains(p: PresenceLike, websiteOf: (p: PresenceLike) => string | null): OrganizationEvidence[] {
  const out: OrganizationEvidence[] = p.emails.map((e) => ({ kind: "email" as const, value: e, source: p.source }));
  const w = websiteOf(p);
  if (w) out.push({ kind: "website", value: w, source: p.source });
  return out;
}

const evidenceDomain = (e: OrganizationEvidence) => (e.kind === "email" ? domainOfEmail(e.value) : domainOfWebsite(e.value));

/**
 * PURE: the organizations the person speaks for. A domain counts only when Jev called it an
 * organization (>= ORGANIZATION_MIN_CONFIDENCE) and brand-service named its company; the link
 * exists only when the presence giving it carries a professional tag.
 */
export function personOrganizations(
  person: PersonLikeForTags,
  x: TagLookups,
  kinds: Map<string, { kind: DomainKind; confidence: number }>,
  companyOf: Map<string, string>,
  websiteOf: (p: PresenceLike) => string | null,
): PersonOrganization[] {
  const byCompany = new Map<string, PersonOrganization>();
  for (const p of person.presences) {
    const tags = professionalTags(presenceConnectionTags(p, x));
    if (tags.length === 0) continue;
    for (const ev of presenceDomains(p, websiteOf)) {
      const d = evidenceDomain(ev);
      if (!d) continue;
      const k = kinds.get(d);
      if (!k || k.kind !== "organization" || k.confidence < ORGANIZATION_MIN_CONFIDENCE) continue;
      const companyId = companyOf.get(d);
      if (!companyId) continue;
      const org = byCompany.get(companyId) ?? { companyId, domain: d, evidence: [], tags: [] };
      if (!org.evidence.some((e) => e.kind === ev.kind && e.value === ev.value && e.source === ev.source)) org.evidence.push(ev);
      for (const t of tags) {
        const held = org.tags.find((o) => o.tag === t.tag);
        if (!held) org.tags.push({ ...t, basis: [...t.basis] });
        else for (const b of t.basis) if (!held.basis.some((h) => h.kind === b.kind && h.ref === b.ref)) held.basis.push(b);
      }
      byCompany.set(companyId, org);
    }
  }
  return [...byCompany.values()].sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}

/** The website each CRM contact states, by our contact id (GoHighLevel today). */
export async function contactWebsites(contactIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += 1000) {
    const rows = (await db.execute(sql`
      SELECT id, website FROM contacts
      WHERE website IS NOT NULL AND id IN (${sql.join(contactIds.slice(i, i + 1000).map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { id: string; website: string }[];
    for (const r of rows) out.set(r.id, r.website);
  }
  return out;
}

export interface OrganizationsSummary {
  status: "ok" | "failed";
  domainKinds: DomainVerdictsSummary;
  companies: CompanyResolveSummary | null;
  organizations: number;
  links: number;
  peopleWithOrganization: number;
}

/**
 * Everything the build needs to name each person's organizations: every evidence domain judged and
 * resolved. Fail-soft: a Jev or brand-service failure leaves those domains without a link this build.
 */
export async function resolveOrganizationLookups(
  identity: SiblingIdentity,
  persons: PersonLikeForTags[],
  websiteOf: (p: PresenceLike) => string | null,
): Promise<{
  kinds: Map<string, { kind: DomainKind; confidence: number }>;
  companyOf: Map<string, string>;
  domainKinds: DomainVerdictsSummary;
  companies: CompanyResolveSummary | null;
}> {
  const domains = new Set<string>();
  for (const person of persons) {
    for (const p of person.presences) for (const ev of presenceDomains(p, websiteOf)) {
      const d = evidenceDomain(ev);
      if (d) domains.add(d);
    }
  }
  const tracking: ChatTrackingHeaders = { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [identity.brandId] };
  const { kinds, summary: domainKinds } = await resolveDomainKinds([...domains].sort(), tracking);
  const orgDomains = [...domains].filter((d) => {
    const k = kinds.get(d);
    return k?.kind === "organization" && k.confidence >= ORGANIZATION_MIN_CONFIDENCE;
  });
  const { companyOf, summary: companies } = await resolveCompanyIds(orgDomains.sort());
  return { kinds, companyOf, domainKinds, companies };
}
