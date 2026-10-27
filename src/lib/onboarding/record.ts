/**
 * WHAT A CLIENT SET UP WITH US, on their staff Unibox thread (ONBOARDING-FICHE-1027).
 *
 * Owner 2026-10-27 (Chaim Tesser's thread): « dans l'Unibox tu n'as pas les infos complètes qu'il a choisi pour
 * l'onboarding ». The walk's PostHog lines (`Get started step done · ...`) are analytics: cut by the dashboard,
 * repeated each time a step is redone, and silent on what was finally kept. A writer read them as the client's
 * business and re-asked what he had typed 40 minutes earlier.
 *
 * The record is READ from the services that OWN each choice, for the person's OWN org, never re-typed, never
 * parsed out of an analytics string, never copied into a store of ours:
 *   - client-service: who the person is (`/internal/users?email=`) and the orgs they belong to now;
 *   - brand-service: the org's brands (website), each offer (name, description) and its value proposition
 *     (user fields, each with its provenance: confirmed by them / still our suggestion), its economics
 *     (client value, booking link);
 *   - lead-service: the offer's qualification signals, on and off;
 *   - human-service: the audiences (name, description, who exactly);
 *   - campaign-service: the funnel campaigns (name, status, since when);
 *   - billing-service: each campaign's caps (budget / volume and their period).
 *
 * One record per (org, brand), served as ONE timeline event (`source: onboarding`, step `onboarding_record`):
 * `text` = the whole record in plain lines, nothing cut; `event.detail` = the same, structured. Staff Unibox
 * scope only (the person is a client of OURS). Read on the spot, shared 60 s per person (the Unibox re-reads a
 * thread every few seconds); an owner that cannot be read fails the source loud, never a partial record posing
 * as complete.
 */
import { createRun } from "../runs-client.js";
import { isStaffEmail } from "../owner-telegram.js";
import { copilotDestination } from "../copilot/messages.js";
import { siblingGetOk, type SiblingIdentity } from "../people/siblings.js";
import { SwrCache } from "../people/swr.js";

export const ONBOARDING_CHANNEL = "account";
export const ONBOARDING_STEP = "onboarding_record";

// ─── owner shapes (only the fields the record serves) ───────────────────────

interface ClientUser {
  id: string;
  email: string | null;
}
interface UserOrgs {
  organizations: { orgId: string; name: string | null }[];
}
interface Brand {
  id: string;
  name: string | null;
  domain: string | null;
  brandUrl: string | null;
  createdAt: string | null;
}
interface Offer {
  offerId: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}
interface UserField {
  value: unknown;
  provenance: string | null;
}
interface Economics {
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueStatedAt: string | null;
  bookingUrl: string | null;
  destinationUrl: string | null;
}
interface Criterion {
  id: string;
  title: string;
  question: string;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}
interface Audience {
  id: string;
  name: string;
  description: string | null;
  targetText: string | null;
  status: string;
  offerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
interface FunnelCampaign {
  id: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  status: string;
  stopReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
interface Caps {
  maxBudget: { amountCents: string; period: string } | null;
  maxVolume: { count: number; period: string; unit: string | null } | null;
  salesFunnelType: string | null;
}

// ─── the record ─────────────────────────────────────────────────────────────

export interface OnboardingCampaign {
  id: string;
  name: string;
  status: string;
  stopReason: string | null;
  createdAt: string | null;
  maxBudget: { amountCents: string; period: string } | null;
  maxVolume: { count: number; period: string; unit: string | null } | null;
  funnelType: string | null;
}

export interface OnboardingOffer {
  offerId: string;
  name: string;
  description: string | null;
  status: string;
  /** The offer's value proposition as brand-service serves it, key by key, with its provenance. */
  fields: { key: string; value: unknown; provenance: string | null }[];
  clientValueUsd: number | null;
  bookingUrl: string | null;
  destinationUrl: string | null;
  signals: { id: string; title: string; question: string; enabled: boolean }[];
  audiences: { id: string; name: string; description: string | null; targetText: string | null; status: string }[];
  campaigns: OnboardingCampaign[];
}

export interface OnboardingRecord {
  orgId: string;
  orgName: string | null;
  userId: string;
  email: string;
  brand: { id: string; name: string | null; website: string | null };
  offers: OnboardingOffer[];
  /** The latest dated change among the parts (the item's place in the thread); null when none is dated. */
  latestChangeAt: string | null;
}

const latest = (dates: (string | null | undefined)[]): string | null => {
  let best: number | null = null;
  for (const d of dates) {
    const t = d ? Date.parse(d) : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
};

/** PURE: a served key in words: `dreamOutcome` -> `Dream outcome`, `give_for_free` -> `Give for free`. */
export function keyWords(key: string): string {
  const s = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}

/** PURE: a field value as lines, verbatim (a list = one line each, a text = its own lines). */
export function valueLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(valueLines);
  if (typeof value === "string") return value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [JSON.stringify(value)];
}

const usd = (cents: string): string => {
  const n = Number(cents) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
};
const PERIOD_WORDS: Record<string, string> = { daily: "per day", weekly: "per week", monthly: "per month", one_off: "in total" };
const periodWords = (p: string) => PERIOD_WORDS[p] ?? keyWords(p).toLowerCase();
const dateWords = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "date unknown");
const STATUS_WORDS: Record<string, string> = { ongoing: "live", stopped: "stopped", paused: "paused" };

/** PURE: the record as plain lines a person (or a writer) reads once, nothing cut. */
export function recordText(r: OnboardingRecord): string {
  const out: string[] = [];
  out.push(`What ${r.email} set up on distribute.you${r.orgName ? ` (account ${r.orgName})` : ""}`);
  out.push(`Brand: ${r.brand.name ?? "unnamed"}${r.brand.website ? `, website ${r.brand.website}` : ""}`);
  if (r.offers.length === 0) out.push("No offer yet.");
  for (const o of r.offers) {
    out.push("");
    out.push(`Offer: ${o.name}${o.status !== "active" ? ` (${o.status})` : ""}`);
    if (o.description) out.push(`  ${o.description}`);
    for (const f of o.fields) {
      const lines = valueLines(f.value);
      if (lines.length === 0) continue;
      const note = f.provenance && f.provenance !== "confirmed" ? ` (${f.provenance}, not confirmed by them)` : "";
      out.push(`  ${keyWords(f.key)}${note}:`);
      for (const l of lines) out.push(`    - ${l}`);
    }
    if (o.clientValueUsd !== null) out.push(`  Client value: ${usd(String(Math.round(o.clientValueUsd * 100)))} per client`);
    if (o.bookingUrl) out.push(`  Booking link: ${o.bookingUrl}`);
    if (o.destinationUrl) out.push(`  Destination link: ${o.destinationUrl}`);
    const on = o.signals.filter((s) => s.enabled);
    const off = o.signals.filter((s) => !s.enabled);
    if (on.length) {
      out.push("  Signals they kept on:");
      for (const s of on) out.push(`    - ${s.title}: ${s.question}`);
    }
    if (off.length) {
      out.push("  Signals offered, left off:");
      for (const s of off) out.push(`    - ${s.title}: ${s.question}`);
    }
    if (o.audiences.length === 0) out.push("  Audience: none yet");
    for (const a of o.audiences) {
      out.push(`  Audience: ${a.name}${a.status !== "active" ? ` (${a.status})` : ""}`);
      if (a.description) out.push(`    ${a.description}`);
      if (a.targetText && a.targetText !== a.description) out.push(`    Who exactly: ${a.targetText}`);
    }
    if (o.campaigns.length === 0) out.push("  Campaign: none yet");
    for (const c of o.campaigns) {
      const state = STATUS_WORDS[c.status] ?? c.status;
      out.push(`  Campaign: ${c.name}, ${state}${c.stopReason ? ` (${keyWords(c.stopReason).toLowerCase()})` : ""}, created ${dateWords(c.createdAt)}`);
      const upTo = c.funnelType === "reactive" ? "Up to" : "Max budget";
      if (c.maxBudget) out.push(`    ${upTo} ${usd(c.maxBudget.amountCents)} ${periodWords(c.maxBudget.period)}`);
      if (c.maxVolume) out.push(`    Max volume: ${c.maxVolume.count}${c.maxVolume.unit ? ` ${keyWords(c.maxVolume.unit).toLowerCase()}` : ""} ${periodWords(c.maxVolume.period)}`);
      if (!c.maxBudget && !c.maxVolume) out.push("    No budget set");
    }
  }
  return out.join("\n");
}

// ─── reading the owners ─────────────────────────────────────────────────────

const enc = encodeURIComponent;

async function allAudiences(identity: SiblingIdentity, brandId: string): Promise<Audience[]> {
  const out: Audience[] = [];
  for (let offset = 0; ; ) {
    const page = await siblingGetOk<{ audiences: Audience[]; total: number }>(
      "human",
      `/orgs/audiences?brandId=${enc(brandId)}&limit=100&offset=${offset}`,
      identity,
    );
    if (!Array.isArray(page?.audiences)) throw new Error("human-service GET /orgs/audiences answered no audiences list");
    out.push(...page.audiences);
    offset += page.audiences.length;
    if (page.audiences.length === 0 || offset >= page.total) return out;
  }
}

async function readOrgRecords(orgId: string, orgName: string | null, user: ClientUser, email: string): Promise<OnboardingRecord[]> {
  const run = await createRun({
    orgId,
    userId: user.id,
    serviceName: "crm-service",
    taskName: "onboarding.record",
    support: { kind: "product_feature", reason: "Staff Unibox: reading what a client set up with us" },
  });
  const org: SiblingIdentity = { orgId, userId: user.id, runId: run.id, brandId: "" };
  const { brands } = await siblingGetOk<{ brands: Brand[] }>("brand", "/orgs/brands", org);
  if (!Array.isArray(brands)) throw new Error("brand-service GET /orgs/brands answered no brands list");
  if (brands.length === 0) return [];
  const funnels = await siblingGetOk<{ salesFunnelCampaigns: FunnelCampaign[] }>("campaign", "/sales-funnel-campaigns", org);
  if (!Array.isArray(funnels?.salesFunnelCampaigns)) throw new Error("campaign-service GET /sales-funnel-campaigns answered no list");

  return Promise.all(
    brands.map(async (brand): Promise<OnboardingRecord> => {
      const id: SiblingIdentity = { ...org, brandId: brand.id };
      const [{ offers }, audiences] = await Promise.all([
        siblingGetOk<{ offers: Offer[] }>("brand", `/orgs/brands/${enc(brand.id)}/offers`, id),
        allAudiences(id, brand.id),
      ]);
      if (!Array.isArray(offers)) throw new Error(`brand-service offers of ${brand.id} answered no list`);
      const dated: (string | null)[] = [brand.createdAt];
      const outOffers = await Promise.all(
        offers.map(async (o): Promise<OnboardingOffer> => {
          const base = `/orgs/brands/${enc(brand.id)}/offers/${enc(o.offerId)}`;
          const campaigns = funnels.salesFunnelCampaigns.filter((c) => c.brandId === brand.id && c.offerId === o.offerId);
          const [fields, economics, criteria, caps] = await Promise.all([
            siblingGetOk<{ fields: Record<string, UserField> }>("brand", `${base}/user-fields`, id),
            siblingGetOk<Economics>("brand", `${base}/economics`, id),
            siblingGetOk<{ criteria: Criterion[] }>("lead", `${base}/qualification/criteria`, id),
            Promise.all(
              campaigns.map((c) =>
                siblingGetOk<Caps>(
                  "billing",
                  `/internal/brands/${enc(brand.id)}/offers/${enc(o.offerId)}/sales-funnels/${enc(c.salesFunnelId)}/caps`,
                  id,
                ),
              ),
            ),
          ]);
          const mine = audiences.filter((a) => a.offerId === o.offerId);
          dated.push(
            o.createdAt,
            o.updatedAt,
            economics.lifetimeRevenueStatedAt,
            ...criteria.criteria.flatMap((c) => [c.createdAt, c.updatedAt]),
            ...mine.flatMap((a) => [a.createdAt]),
            ...campaigns.flatMap((c) => [c.createdAt, c.updatedAt]),
          );
          return {
            offerId: o.offerId,
            name: o.name,
            description: o.description,
            status: o.status,
            fields: Object.entries(fields.fields ?? {}).map(([key, f]) => ({ key, value: f?.value ?? null, provenance: f?.provenance ?? null })),
            clientValueUsd: economics.lifetimeRevenueUsd ?? null,
            bookingUrl: economics.bookingUrl ?? null,
            destinationUrl: economics.destinationUrl ?? null,
            signals: criteria.criteria.map((c) => ({ id: c.id, title: c.title, question: c.question, enabled: c.enabled })),
            audiences: mine.map((a) => ({ id: a.id, name: a.name, description: a.description, targetText: a.targetText, status: a.status })),
            campaigns: campaigns.map((c, i) => ({
              id: c.id,
              name: c.salesFunnelName,
              status: c.status,
              stopReason: c.stopReason,
              createdAt: c.createdAt,
              maxBudget: caps[i].maxBudget ? { amountCents: caps[i].maxBudget!.amountCents, period: caps[i].maxBudget!.period } : null,
              maxVolume: caps[i].maxVolume ? { count: caps[i].maxVolume!.count, period: caps[i].maxVolume!.period, unit: caps[i].maxVolume!.unit } : null,
              funnelType: caps[i].salesFunnelType,
            })),
          };
        }),
      );
      return {
        orgId,
        orgName,
        userId: user.id,
        email,
        brand: { id: brand.id, name: brand.name, website: brand.brandUrl ?? brand.domain },
        offers: outOffers,
        latestChangeAt: latest(dated),
      };
    }),
  );
}

/**
 * Every account the person opened with us, one record per (org, brand), read from the owners. A staff address is
 * nobody's client (staff open orgs FOR clients); the staff org itself is never a client account.
 */
export async function readOnboardingRecords(emails: string[], caller: SiblingIdentity): Promise<OnboardingRecord[]> {
  const staffOrg = copilotDestination()?.orgId ?? null;
  const addresses = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e && !isStaffEmail(e)))];
  const out: OnboardingRecord[] = [];
  const seen = new Set<string>();
  for (const email of addresses) {
    const { users } = await siblingGetOk<{ users: ClientUser[] }>("client", `/internal/users?email=${enc(email)}`, caller);
    if (!Array.isArray(users)) throw new Error("client-service GET /internal/users answered no users list");
    for (const user of users.filter((u) => u.email?.trim().toLowerCase() === email)) {
      const { organizations } = await siblingGetOk<UserOrgs>("client", `/internal/users/${enc(user.id)}/orgs`, caller);
      if (!Array.isArray(organizations)) throw new Error("client-service GET /internal/users/{id}/orgs answered no organizations list");
      for (const o of organizations) {
        if (o.orgId === staffOrg || seen.has(o.orgId)) continue;
        seen.add(o.orgId);
        out.push(...(await readOrgRecords(o.orgId, o.name, user, email)));
      }
    }
  }
  return out;
}

/** Shared per person: the Unibox re-reads an open thread every few seconds. Failures are never cached. */
const cache = new SwrCache<OnboardingRecord[]>(
  "onboarding records",
  () => Number(process.env.ONBOARDING_RECORD_FRESH_MS) || 60_000,
  () => Number(process.env.ONBOARDING_RECORD_MAX_STALE_MS) || 10 * 60_000,
);

export function cachedOnboardingRecords(emails: string[], caller: SiblingIdentity): Promise<OnboardingRecord[]> {
  const key = [...new Set(emails.map((e) => e.trim().toLowerCase()))].sort().join(",");
  return cache.get(key, () => readOnboardingRecords(emails, caller));
}
