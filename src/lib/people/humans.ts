/**
 * Who is the same HUMAN — human-service's call, never ours (LEAD-REFONTE-1013).
 *
 * human-service holds one id per real human across the fleet. crm-service only
 * STATES what the brand's tools say and READS the answer:
 *  - every record a build reads (a Gmail correspondent, a GoHighLevel / Stripe /
 *    Clerk contact, a CSV row, a WhatsApp send...) is resolved with its email +
 *    phone keys GIVEN TOGETHER: that is a proof "one contact", which human-service
 *    turns into a fleet-wide merge when a key is already someone's;
 *  - a JUDGMENT that two records are one human (a person's stated merge, a
 *    confident lead-service pairing) is an ORG-scoped `same` link: it holds for
 *    this org only, and it is withdrawn when the judgment goes;
 *  - a do-not-contact mark a tool states (CSV opt-out, GoHighLevel DND) is a
 *    fact on the human, so it follows them everywhere.
 *
 * The answer (key -> humanId in the org's view) is cached in `human_keys` and
 * refreshed from human-service's event feed when a human merges or splits.
 * The people build then ties keys that are one human (`human_identity`
 * evidence): our people follow human-service's merges and splits.
 *
 * Fail-soft by construction, like human-service's own serve: identity never
 * fails a build. human-service down → today's cache answers, a judgment not
 * stated yet stays a local merge for this build, and the summary says so.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  humanEventCursor,
  humanFactStatements,
  humanKeys,
  humanLinkStatements,
  humanResolutions,
  type PeopleScope,
} from "../../db/schema.js";
import {
  humanServiceConfigured,
  readHumanEvents,
  resolveHuman,
  stateHumanFact,
  stateSameHuman,
  withdrawHumanFact,
  withdrawHumanLink,
} from "../human-identity/client.js";
import { emailKey, normalizeEmail, normalizePhone, parseHandleKey, phoneKey, type Evidence } from "./identity.js";
import { mapLimit } from "./siblings.js";

/** One record: keys a single source record states together. */
export interface IdentityRecord {
  emails: string[];
  phones: string[];
  /** Messaging handle keys (`msg:<network>:<id>`, identity.ts): a bridged contact with no email / phone. */
  handles?: string[];
  /** HUMAN-RECORD-KEYS-1017: a record of the brand's own tool, stated only for a record with no email / phone. */
  crmRecords?: CrmRecord[];
}

/** One record in a client's tool (human-service `crmRecords`): provider + the client account + the vendor's record id. */
export interface CrmRecord {
  provider: "gohighlevel" | "stripe" | "posthog" | "clerk";
  accountId: string;
  id: string;
}

const CRM_RECORD_PREFIX = "crm_record:";
/** PURE: the identity key of a CRM record, as human-service stores it (`crm_record:<provider>:<accountId>:<id>`). */
export const crmRecordKey = (r: CrmRecord) => `${CRM_RECORD_PREFIX}${r.provider}:${r.accountId}:${r.id}`;
/** PURE: a `crm_record:` key back to its parts (the id may itself hold ':'); null = not one. */
export function parseCrmRecordKey(k: string): CrmRecord | null {
  if (!k.startsWith(CRM_RECORD_PREFIX)) return null;
  const rest = k.slice(CRM_RECORD_PREFIX.length);
  const a = rest.indexOf(":");
  const b = a < 0 ? -1 : rest.indexOf(":", a + 1);
  if (a <= 0 || b <= a + 1 || b === rest.length - 1) return null;
  return { provider: rest.slice(0, a) as CrmRecord["provider"], accountId: rest.slice(a + 1, b), id: rest.slice(b + 1) };
}

/** A judgment that two records are one human. */
export interface Judgment {
  kind: "lead_pairing" | "stated_merge";
  ref: string;
  sides: [IdentityRecord, IdentityRecord];
  judgedBy: string;
  evidence: string;
}

export interface HumanIdentitySummary {
  status: "ok" | "partial" | "failed" | "not_configured";
  /** Records stated to human-service this build. */
  resolved: number;
  /** Records still to state (budget spent); next build continues. */
  pending: number;
  failed: number;
  linksStated: number;
  linksWithdrawn: number;
  /** Judgments human-service does not hold yet (no key, not resolved, failed): kept as a local merge. */
  judgmentsLocal: number;
  factsStated: number;
  factsWithdrawn: number;
  keysRefreshed: number;
  error: string | null;
}

const CONCURRENCY = Number(process.env.HUMAN_RESOLVE_CONCURRENCY) || 4;
export const resolveBudgetMs = () => Number(process.env.HUMAN_RESOLVE_BUDGET_MS) || 300_000;

// ─── pure ────────────────────────────────────────────────────────────────────

/** PURE: the email / phone / messaging-handle / CRM-record identity keys a record states (sorted, unique). Other keys never reach human-service. */
export function recordKeys(r: IdentityRecord): string[] {
  const keys = new Set<string>();
  for (const h of r.handles ?? []) if (parseHandleKey(h)) keys.add(h);
  for (const c of r.crmRecords ?? []) if (c.accountId && !c.accountId.includes(":") && c.id) keys.add(crmRecordKey(c));
  for (const e of r.emails) {
    const n = normalizeEmail(e);
    if (n) keys.add(emailKey(n));
  }
  for (const p of r.phones) {
    const n = normalizePhone(p);
    if (n) keys.add(phoneKey(n));
  }
  return [...keys].sort();
}

export const keysHash = (keys: string[]) => createHash("sha256").update(keys.join("\n")).digest("hex");

const splitKeys = (keys: string[]) => ({
  emails: keys.filter((k) => k.startsWith("email:")).map((k) => k.slice(6)),
  phones: keys.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6)),
  messagingHandles: keys.map(parseHandleKey).filter((h): h is { network: string; id: string } => !!h),
  crmRecords: keys.map(parseCrmRecordKey).filter((c): c is CrmRecord => !!c),
});

/**
 * PURE: one `human_identity` evidence per human holding 2+ of the given keys:
 * the build ties them. Only keys the build already holds: a human's OTHER
 * addresses (another org's, another tool's) never join the brand's person.
 */
export function humanEvidence(keys: Iterable<string>, humanOf: Map<string, string>): Evidence[] {
  const byHuman = new Map<string, Set<string>>();
  for (const k of keys) {
    const h = humanOf.get(k);
    if (!h) continue;
    byHuman.set(h, (byHuman.get(h) ?? new Set()).add(k));
  }
  const out: Evidence[] = [];
  for (const [humanId, ks] of [...byHuman.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ks.size < 2) continue;
    const sorted = [...ks].sort();
    const { emails, phones } = splitKeys(sorted);
    const handles = sorted.filter((k) => parseHandleKey(k));
    out.push({ kind: "human_identity", ref: humanId, displayName: null, company: null, emails, phones, ...(handles.length ? { keys: handles } : {}) });
  }
  return out;
}

/**
 * PURE: the human a person IS. Its keys normally all name one human (the build
 * tied them); if not (a local merge human-service does not hold), the human
 * most of its keys name, ties to the one of the smallest key.
 */
export function personHumanId(identityKeys: string[], humanOf: Map<string, string>): string | null {
  const count = new Map<string, number>();
  const first = new Map<string, string>();
  for (const k of [...identityKeys].sort()) {
    const h = humanOf.get(k);
    if (!h) continue;
    count.set(h, (count.get(h) ?? 0) + 1);
    if (!first.has(h)) first.set(h, k);
  }
  let best: string | null = null;
  for (const [h, n] of count) {
    if (
      best === null ||
      n > count.get(best)! ||
      (n === count.get(best)! && first.get(h)! < first.get(best)!)
    ) {
      best = h;
    }
  }
  return best;
}

/** PURE: the human ids an event can have moved (merge, split, statement withdrawn). */
export function eventHumanIds(e: { type: string; humanIds: string[]; data: Record<string, unknown> }): string[] {
  if (!["human.linked", "human.separated", "human.link_withdrawn"].includes(e.type)) return [];
  const ids = new Set(e.humanIds);
  const d = e.data ?? {};
  if (typeof d.humanId === "string") ids.add(d.humanId);
  for (const field of ["memberHumanIds", "humanIds"]) {
    const v = d[field];
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.add(x);
  }
  return [...ids];
}

// ─── cache ───────────────────────────────────────────────────────────────────

async function upsertKeys(orgId: string, keys: string[], humanId: string, atomicHumanId: string | null) {
  if (keys.length === 0) return;
  await db
    .insert(humanKeys)
    .values(keys.map((identityKey) => ({ orgId, identityKey, humanId, atomicHumanId, resolvedAt: new Date() })))
    .onConflictDoUpdate({
      target: [humanKeys.orgId, humanKeys.identityKey],
      set: { humanId: sql`excluded.human_id`, atomicHumanId: sql`excluded.atomic_human_id`, resolvedAt: sql`excluded.resolved_at` },
    });
}

/** Re-read, one key at a time (read-only), what human-service says each cached key is now. */
async function refreshKeys(rows: { orgId: string; identityKey: string }[]): Promise<number> {
  let n = 0;
  await mapLimit(rows, CONCURRENCY, async (r) => {
    const ans = await resolveHuman({ orgId: r.orgId, ...splitKeys([r.identityKey]), create: false });
    if (ans.humanId) await upsertKeys(r.orgId, [r.identityKey], ans.humanId, ans.atomicHumanId);
    else await db.delete(humanKeys).where(and(eq(humanKeys.orgId, r.orgId), eq(humanKeys.identityKey, r.identityKey)));
    n++;
  });
  return n;
}

/** Every cached key that names one of `ids` (as its human or atomic human), plus the rest of those humans' keys. */
async function keysTouching(ids: string[], orgId: string | null) {
  if (ids.length === 0) return [];
  const orgCond = orgId ? eq(humanKeys.orgId, orgId) : sql`true`;
  const direct = await db
    .select({ orgId: humanKeys.orgId, identityKey: humanKeys.identityKey, humanId: humanKeys.humanId })
    .from(humanKeys)
    .where(and(orgCond, or(inArray(humanKeys.humanId, ids), inArray(humanKeys.atomicHumanId, ids))));
  const humans = [...new Set(direct.map((d) => d.humanId))];
  const more = humans.length
    ? await db
        .select({ orgId: humanKeys.orgId, identityKey: humanKeys.identityKey, humanId: humanKeys.humanId })
        .from(humanKeys)
        .where(and(orgCond, inArray(humanKeys.humanId, humans)))
    : [];
  const seen = new Map<string, { orgId: string; identityKey: string }>();
  for (const r of [...direct, ...more]) seen.set(`${r.orgId}|${r.identityKey}`, { orgId: r.orgId, identityKey: r.identityKey });
  return [...seen.values()];
}

// ─── the event feed ──────────────────────────────────────────────────────────

const CURSOR_ID = "human-service";
const MAX_EVENT_PAGES = Number(process.env.HUMAN_EVENT_MAX_PAGES) || 20;
let following: Promise<number> | null = null;

/**
 * Follow human-service's merges and splits: every cached key whose human an
 * event may have moved is re-read. One pass at a time per process.
 */
export function followHumanEvents(): Promise<number> {
  if (!following) {
    following = (async () => {
      const [row] = await db.select().from(humanEventCursor).where(eq(humanEventCursor.id, CURSOR_ID));
      let after = row?.after ?? 0;
      let refreshed = 0;
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const { events, nextCursor, hasMore } = await readHumanEvents(after);
        for (const e of events) {
          const ids = eventHumanIds(e);
          if (ids.length) refreshed += await refreshKeys(await keysTouching(ids, e.orgId));
        }
        const next = Number(nextCursor);
        if (Number.isFinite(next) && next > after) {
          after = next;
          await db
            .insert(humanEventCursor)
            .values({ id: CURSOR_ID, after, updatedAt: new Date() })
            .onConflictDoUpdate({ target: humanEventCursor.id, set: { after, updatedAt: new Date() } });
        }
        if (!hasMore || events.length === 0) break;
      }
      return refreshed;
    })().finally(() => {
      following = null;
    });
  }
  return following;
}

// ─── one scope ───────────────────────────────────────────────────────────────

async function orgHumanMap(orgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ k: humanKeys.identityKey, h: humanKeys.humanId })
    .from(humanKeys)
    .where(eq(humanKeys.orgId, orgId));
  return new Map(rows.map((r) => [r.k, r.h]));
}

/** State every record not stated yet (budgeted). Returns how many were stated / failed / left. */
async function stateRecords(orgId: string, records: string[][], deadline: number) {
  const done = new Set(
    (await db.select({ h: humanResolutions.keysHash }).from(humanResolutions).where(eq(humanResolutions.orgId, orgId))).map((r) => r.h),
  );
  const todo = new Map<string, string[]>();
  for (const keys of records) {
    if (keys.length === 0) continue;
    const h = keysHash(keys);
    if (!done.has(h)) todo.set(h, keys);
  }
  let resolved = 0;
  let failed = 0;
  let pending = 0;
  let firstError: string | null = null;
  let keysRefreshed = 0;
  await mapLimit([...todo.entries()], CONCURRENCY, async ([hash, keys]) => {
    if (Date.now() > deadline) {
      pending++;
      return;
    }
    try {
      const ans = await resolveHuman({ orgId, ...splitKeys(keys), create: true });
      if (!ans.humanId) throw new Error("resolve(create) answered no human");
      if (ans.separatedHumanIds.length > 0) {
        // A split keeps some of these keys apart: each key says who it is.
        await refreshKeys(keys.map((identityKey) => ({ orgId, identityKey })));
      } else {
        await upsertKeys(orgId, keys, ans.humanId, ans.atomicHumanId);
      }
      if (ans.mergedHumanIds.length > 0) {
        // Humans this record proved to be one: every org's cached keys of them move (events do it for other orgs).
        keysRefreshed += await refreshKeys(await keysTouching(ans.mergedHumanIds, orgId));
      }
      await db
        .insert(humanResolutions)
        .values({ orgId, keysHash: hash, keys, humanId: ans.humanId })
        .onConflictDoNothing();
      resolved++;
    } catch (err) {
      failed++;
      firstError ??= (err as Error).message;
    }
  });
  return { resolved, failed, pending, firstError, keysRefreshed };
}

/** PURE: a judgment human-service can hold: both sides carry an email or a phone. */
export const statable = (j: Judgment) => recordKeys(j.sides[0]).length > 0 && recordKeys(j.sides[1]).length > 0;

const judgmentId = (j: Pick<Judgment, "kind" | "ref">) => `${j.kind}:${j.ref}`;

/**
 * State each judgment as an org-scoped `same` link; withdraw the links whose
 * judgment is gone (only for kinds READ this build: a failed read withdraws
 * nothing). Returns the judgments human-service now answers.
 */
async function stateJudgments(scope: PeopleScope, judgments: Judgment[], kindsRead: Set<Judgment["kind"]>) {
  const { orgId, brandId } = scope;
  let humanOf = await orgHumanMap(orgId);
  const live = await db
    .select()
    .from(humanLinkStatements)
    .where(and(eq(humanLinkStatements.orgId, orgId), eq(humanLinkStatements.brandId, brandId), isNull(humanLinkStatements.withdrawnAt)));
  const liveById = new Map(live.map((s) => [`${s.kind}:${s.ref}`, s]));
  const held = new Set<string>();
  let stated = 0;
  let withdrawn = 0;
  let keysRefreshed = 0;
  for (const j of judgments) {
    if (!statable(j)) continue;
    const [ka, kb] = [recordKeys(j.sides[0]), recordKeys(j.sides[1])];
    const a = personHumanId(ka, humanOf);
    const b = personHumanId(kb, humanOf);
    if (!a || !b) continue;
    const prior = liveById.get(judgmentId(j));
    if (prior && prior.statedOrgId === orgId) {
      held.add(judgmentId(j));
      continue;
    }
    if (a === b) {
      // Already one human in this org's view: nothing to state.
      held.add(judgmentId(j));
      continue;
    }
    const r = await stateSameHuman({ orgId, humanIds: [a, b], judgedBy: j.judgedBy, evidence: j.evidence });
    if (prior) await db.update(humanLinkStatements).set({ withdrawnAt: new Date() }).where(eq(humanLinkStatements.id, prior.id));
    await db.insert(humanLinkStatements).values({
      orgId,
      brandId,
      kind: j.kind,
      ref: j.ref,
      humanIds: [a, b],
      linkId: r.link?.linkId ?? null,
      statedOrgId: orgId,
    });
    stated++;
    held.add(judgmentId(j));
    keysRefreshed += await refreshKeys(await keysTouching([a, b, ...r.humanIds], orgId));
    humanOf = await orgHumanMap(orgId);
  }
  const current = new Set(judgments.map(judgmentId));
  for (const s of live) {
    const id = `${s.kind}:${s.ref}`;
    if (current.has(id) || !kindsRead.has(s.kind as Judgment["kind"])) continue;
    if (s.linkId && s.statedOrgId === orgId) {
      await withdrawHumanLink({ linkId: s.linkId, orgId, reason: `${s.kind} ${s.ref} no longer stated in the brand's CRM` });
    }
    await db.update(humanLinkStatements).set({ withdrawnAt: new Date() }).where(eq(humanLinkStatements.id, s.id));
    withdrawn++;
    keysRefreshed += await refreshKeys(await keysTouching(s.humanIds as string[], orgId));
  }
  return { held, stated, withdrawn, keysRefreshed };
}

/** A do-not-contact mark one of the brand's tools states on a contact. */
export interface ContactMark {
  subject: string;
  kind: "opt_out" | "do_not_contact";
  marked: boolean;
  keys: string[];
  evidence: string;
}

/** PURE: the mark a CSV / GoHighLevel contact row states (CSV opt-out or denied consent; GoHighLevel DND). */
export function contactMark(c: {
  source: string;
  externalId: string | null;
  primaryEmail: string | null;
  phoneE164: string | null;
  unsubscribed: boolean;
  consentStatus: string;
}): ContactMark | null {
  const keys = recordKeys({ emails: c.primaryEmail ? [c.primaryEmail] : [], phones: c.phoneE164 ? [c.phoneE164] : [] });
  if (keys.length === 0) return null;
  if (c.source === "csv" && c.primaryEmail) {
    const marked = c.unsubscribed || c.consentStatus === "denied";
    return {
      subject: `csv:${c.primaryEmail.trim().toLowerCase()}`,
      kind: "opt_out",
      marked,
      keys,
      evidence: c.unsubscribed ? "The brand's CRM export marks this contact unsubscribed / opted out" : "The brand's CRM export marks this contact's consent denied",
    };
  }
  if (c.source === "gohighlevel" && c.externalId) {
    return {
      subject: `gohighlevel:${c.externalId}`,
      kind: "do_not_contact",
      marked: c.unsubscribed,
      keys,
      evidence: "The brand's GoHighLevel CRM marks this contact Do Not Disturb",
    };
  }
  return null;
}

/** State every do-not-contact mark on its human; withdraw a mark the tool no longer states (contact still there, unmarked). */
async function stateMarks(scope: PeopleScope, deadline: number) {
  const { orgId, brandId } = scope;
  const rows = await db
    .select({
      source: contacts.source,
      externalId: contacts.externalId,
      primaryEmail: contacts.primaryEmail,
      phoneE164: contacts.phoneE164,
      unsubscribed: contacts.unsubscribed,
      consentStatus: contacts.consentStatus,
    })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.brandId, brandId), inArray(contacts.source, ["csv", "gohighlevel"])));
  const marks = rows.map(contactMark).filter((m): m is ContactMark => !!m);
  const live = await db
    .select()
    .from(humanFactStatements)
    .where(and(eq(humanFactStatements.orgId, orgId), eq(humanFactStatements.brandId, brandId), isNull(humanFactStatements.withdrawnAt)));
  const liveBy = new Map(live.map((s) => [`${s.subject}|${s.kind}`, s]));
  const marked = marks.filter((m) => m.marked && !liveBy.has(`${m.subject}|${m.kind}`));
  const res = await stateRecords(orgId, marked.map((m) => m.keys), deadline);
  const humanOf = await orgHumanMap(orgId);
  let stated = 0;
  let withdrawn = 0;
  for (const m of marked) {
    const humanId = personHumanId(m.keys, humanOf);
    if (!humanId) continue;
    const r = await stateHumanFact({ humanId, kind: m.kind, orgId, evidence: m.evidence });
    await db.insert(humanFactStatements).values({ orgId, brandId, subject: m.subject, kind: m.kind, humanId, factId: r.fact.factId });
    stated++;
  }
  for (const m of marks) {
    const s = liveBy.get(`${m.subject}|${m.kind}`);
    if (!s || m.marked) continue;
    await withdrawHumanFact({ factId: s.factId, reason: "The brand's CRM no longer marks this contact" });
    await db.update(humanFactStatements).set({ withdrawnAt: new Date() }).where(eq(humanFactStatements.id, s.id));
    withdrawn++;
  }
  return { stated, withdrawn, resolved: res.resolved, failed: res.failed, pending: res.pending, firstError: res.firstError };
}

/**
 * The identity step of a people build. Returns which human every key is (org
 * view) and which judgments human-service now holds (the build no longer merges
 * on those itself).
 */
export async function resolveScopeHumans(
  scope: PeopleScope,
  records: IdentityRecord[],
  judgments: Judgment[],
  kindsRead: Set<Judgment["kind"]>,
): Promise<{ humanOf: Map<string, string>; heldJudgments: Set<string>; summary: HumanIdentitySummary }> {
  const summary: HumanIdentitySummary = {
    status: "ok",
    resolved: 0,
    pending: 0,
    failed: 0,
    linksStated: 0,
    linksWithdrawn: 0,
    judgmentsLocal: 0,
    factsStated: 0,
    factsWithdrawn: 0,
    keysRefreshed: 0,
    error: null,
  };
  let heldJudgments = new Set<string>();
  if (!humanServiceConfigured()) {
    summary.status = "not_configured";
  } else {
    try {
      const deadline = Date.now() + resolveBudgetMs();
      summary.keysRefreshed += await followHumanEvents();
      // Judgment sides first: a merge someone stated reaches human-service before the long tail.
      const all = [...judgments.flatMap((j) => j.sides), ...records].map(recordKeys);
      const r = await stateRecords(scope.orgId, all, deadline);
      Object.assign(summary, { resolved: r.resolved, failed: r.failed, pending: r.pending });
      summary.keysRefreshed += r.keysRefreshed;
      if (r.firstError) summary.error = r.firstError;
      const j = await stateJudgments(scope, judgments, kindsRead);
      heldJudgments = j.held;
      summary.linksStated = j.stated;
      summary.linksWithdrawn = j.withdrawn;
      summary.keysRefreshed += j.keysRefreshed;
      const m = await stateMarks(scope, deadline);
      summary.factsStated = m.stated;
      summary.factsWithdrawn = m.withdrawn;
      summary.resolved += m.resolved;
      summary.failed += m.failed;
      summary.pending += m.pending;
      if (m.firstError) summary.error ??= m.firstError;
      if (summary.failed > 0 || summary.pending > 0) summary.status = "partial";
    } catch (err) {
      console.error(`[crm-service] human identity step failed scope=${scope.id}:`, err);
      summary.status = "failed";
      summary.error = (err as Error).message;
    }
  }
  summary.judgmentsLocal = judgments.filter((j) => !heldJudgments.has(judgmentId(j))).length;
  return { humanOf: await orgHumanMap(scope.orgId), heldJudgments, summary };
}

export { judgmentId };
