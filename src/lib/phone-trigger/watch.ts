/**
 * THE PHONE WATCH (WA-GIVEN-TRIGGER-1015): a person giving the brand their phone /
 * WhatsApp number, through ANY connector the brand plugged, is reported to
 * campaign-service's generic trigger door (`whatsapp_number_given`, lib/trigger-door.ts)
 * within about a minute, once per (brand, number). Rules: ./rules.ts.
 *
 * Every `PHONE_WATCH_INTERVAL_MS` (60s, first pass 60s after boot, one at a time):
 *  1. FAST MIRROR. The connectors where a person types a number live (PostHog person
 *     properties, auth-provider profiles) are asked for what changed in the last
 *     `PHONE_WATCH_LOOKBACK_MS` only and mirrored now (bronze + silver, the same
 *     no-churn upserts as their 15-min pass). Every other connector (GoHighLevel,
 *     Stripe...) is seen at its own sync: the detection below reads silver.
 *  2. DETECT, generic over silver `contacts`: every number a contact of the brand
 *     holds that the LEDGER (`phone_given_reports`, one row per (org, brand, number))
 *     does not. History is never reported: the first time the watch looks at a source
 *     ARTIFACT (a CSV upload, a connection) once it has finished its first sync, every
 *     number it holds is recorded `skipped / before_watch` (`phone_watch_artifacts`),
 *     so connecting a CRM or importing a file never fires on its backlog. A chat
 *     contact (Matrix) counts once the person WROTE in a one-to-one thread (a silent
 *     group member gave nothing). No WHO filter (staff, own team, already wrote): the
 *     answering pipe's strategy decides (WA-GIVEN-PURE-FACT-1017).
 *  3. DELIVER every pending / failed-and-due report: one ORG run per (org, brand),
 *     an impossible number dropped (`invalid_number`), the offer = the one the brand stated
 *     for every form (`form_offer_mappings` '*'), else its only active offer, idempotency key `crm:phone_given:<brand>:<number>` (a retry returns
 *     campaign-service's first event). Retries 1 → 60 min for 24h; 400 / 422 final.
 *  A detection kicks the brand's people build (unawaited) so the person is known to
 *  lead-service; campaign-service holds a `person_not_known` event and retries it.
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  authConnections,
  peopleScopes,
  phoneGivenReports,
  phoneWatchArtifacts,
  posthogConnections,
  type PhoneGivenReport,
} from "../../db/schema.js";
import { mirrorRecentPersons } from "../posthog/sync.js";
import { mirrorRecentlyUpdatedUsers } from "../auth/sync.js";
import { runScopeBuild } from "../people/build.js";
import { createRun, updateRun } from "../runs-client.js";
import { resolveOffer, type OfferAnswer } from "../form-trigger/offer.js";
import {
  CampaignRefusal,
  campaignServiceConfigured,
  dialablePhone,
  FINAL_REFUSAL_STATUSES,
  recordTriggerEvent,
} from "../trigger-door.js";
import {
  PHONE_REASONS,
  PHONE_STATUS,
  phoneOccurrenceBody,
} from "./rules.js";

const SERVICE_NAME = "crm-service";

export const PHONE_WATCH_INTERVAL_MS = Number(process.env.PHONE_WATCH_INTERVAL_MS) || 60_000;
/** How far back the fast mirror asks (overlapping passes are free: the upserts are no-churn). */
export const PHONE_WATCH_LOOKBACK_MS = 10 * 60_000;
export const PHONE_REPORT_RETRY_WINDOW_MS = 24 * 3_600_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** New numbers read per pass (the first pass baselines every brand's history). */
const DETECT_BATCH = 10_000;

export interface PhoneWatchResult {
  mirrored: { source: string; connectionId: string; orgId: string; brandId: string; changed: number; created?: number; eventsChanged?: number; error?: string }[];
  baselined: { artifactId: string; source: string; phones: number }[];
  detected: number;
  skipped: Record<string, number>;
  delivered: { reportId: string; status: string; reason: string | null }[];
}

/** PURE: when a failed report is next due. */
export function nextAttemptDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  return lastAttemptAt.getTime() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/** 1. The live connectors, mirrored now. A connection never fully synced is left to its own pass. */
async function fastMirror(now: number): Promise<PhoneWatchResult["mirrored"]> {
  const out: PhoneWatchResult["mirrored"] = [];
  const since = now - PHONE_WATCH_LOOKBACK_MS;
  const ph = await db
    .select()
    .from(posthogConnections)
    .where(and(inArray(posthogConnections.status, ["active", "error"]), sql`${posthogConnections.lastSyncedAt} IS NOT NULL`));
  for (const conn of ph) {
    try {
      const r = await mirrorRecentPersons(conn, new Date(since));
      out.push({ source: "posthog", connectionId: conn.id, orgId: conn.orgId, brandId: conn.brandId, changed: r.changed.length, created: r.created, eventsChanged: r.eventsChanged });
    } catch (err) {
      console.warn(`[crm-service][phone-trigger] PostHog fast mirror of ${conn.id} (brand ${conn.brandId}) failed: ${(err as Error).message}`);
      out.push({ source: "posthog", connectionId: conn.id, orgId: conn.orgId, brandId: conn.brandId, changed: 0, error: (err as Error).message });
    }
  }
  const auth = await db
    .select()
    .from(authConnections)
    .where(and(inArray(authConnections.status, ["active", "error"]), sql`${authConnections.lastSyncedAt} IS NOT NULL`));
  for (const conn of auth) {
    try {
      out.push({ source: conn.provider, connectionId: conn.id, orgId: conn.orgId, brandId: conn.brandId, changed: (await mirrorRecentlyUpdatedUsers(conn, since)).length });
    } catch (err) {
      console.warn(`[crm-service][phone-trigger] ${conn.provider} fast mirror of ${conn.id} (brand ${conn.brandId}) failed: ${(err as Error).message}`);
      out.push({ source: conn.provider, connectionId: conn.id, orgId: conn.orgId, brandId: conn.brandId, changed: 0, error: (err as Error).message });
    }
  }
  return out;
}

type Row = Record<string, unknown>;

/**
 * MANUAL-CONTACT-IS-A-PERSON-1024 (owner 2026-10-24: a Lead event = a new event of THEIR action toward us): a number
 * the CLIENT typed on a contact added by hand (the brand's `manual` list) is our statement, never the person giving
 * it. Neither detected nor recorded, so the day the person gives it themselves (a form, a signup) it is reported.
 * Before, every manual add after the brand's first one fired `whatsapp_number_given`.
 */
const notAddedByHand = sql`NOT EXISTS (SELECT 1 FROM contact_uploads mu WHERE mu.id = c.source_upload_id AND mu.kind = 'manual')`;
const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

/**
 * The first look at every source ARTIFACT that finished its first load (a promoted
 * upload, a connection synced once) and was never looked at: every number it holds
 * is history, recorded `before_watch`. Runs every pass, phones or not, so a source
 * that holds no number yet is watched from its first load on.
 */
async function baselineNewArtifacts(now: number): Promise<PhoneWatchResult["baselined"]> {
  const out: PhoneWatchResult["baselined"] = [];
  const fresh = await rows<{ org_id: string; brand_id: string; id: string; source: string }>(sql`
    SELECT a.org_id, a.brand_id, a.id, a.source FROM (
      SELECT org_id, brand_id, id, 'csv' AS source FROM contact_uploads WHERE status = 'promoted'
      UNION ALL SELECT org_id, brand_id, id, 'gohighlevel' FROM ghl_connections WHERE last_synced_at IS NOT NULL
      UNION ALL SELECT org_id, brand_id, id, 'posthog' FROM posthog_connections WHERE last_synced_at IS NOT NULL
      UNION ALL SELECT org_id, brand_id, id, 'stripe' FROM stripe_connections WHERE last_synced_at IS NOT NULL
      UNION ALL SELECT org_id, brand_id, id, provider FROM auth_connections WHERE last_synced_at IS NOT NULL
      UNION ALL SELECT org_id, brand_id, id, 'matrix' FROM matrix_connections WHERE last_synced_at IS NOT NULL
    ) a
    WHERE NOT EXISTS (
      SELECT 1 FROM phone_watch_artifacts w WHERE w.org_id = a.org_id AND w.brand_id = a.brand_id AND w.artifact_id = a.id
    )
  `);
  for (const a of fresh) {
    const phones = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(phoneWatchArtifacts)
        .values({ orgId: a.org_id, brandId: a.brand_id, artifactId: a.id, source: a.source, baselineAt: new Date(now) })
        .onConflictDoNothing()
        .returning({ id: phoneWatchArtifacts.id });
      if (claimed.length === 0) return null;
      const inserted = (await tx.execute(sql`
        INSERT INTO phone_given_reports (org_id, brand_id, phone, source, contact_id, source_contact_id, artifact_id, full_name, first_name, last_name, email, detected_at, status, reason)
        SELECT DISTINCT ON (c.phone_e164) c.org_id, c.brand_id, c.phone_e164, c.source, c.id, c.external_id,
               ${a.id}::uuid, c.full_name, c.first_name, c.last_name, c.primary_email, ${new Date(now).toISOString()}::timestamptz,
               ${PHONE_STATUS.SKIPPED}, ${PHONE_REASONS.BEFORE_WATCH}
        FROM contacts c
        WHERE c.org_id = ${a.org_id} AND c.brand_id = ${a.brand_id} AND c.phone_e164 IS NOT NULL
          AND coalesce(c.source_upload_id, c.source_connection_id) = ${a.id}::uuid
          AND ${notAddedByHand}
        ORDER BY c.phone_e164, c.id
        ON CONFLICT (org_id, brand_id, phone) DO NOTHING
        RETURNING id
      `)) as unknown as unknown[];
      await tx.update(phoneWatchArtifacts).set({ phonesAtBaseline: inserted.length }).where(eq(phoneWatchArtifacts.id, claimed[0].id));
      return inserted.length;
    });
    if (phones === null) continue;
    out.push({ artifactId: a.id, source: a.source, phones });
    console.log(`[crm-service][phone-trigger] baseline: ${a.source} artifact ${a.id} (brand ${a.brand_id}) holds ${phones} number(s) already known, never reported`);
  }
  return out;
}

/** 2. Every number silver holds that the ledger does not, recorded once. */
export async function detectNewPhones(now: number = Date.now()): Promise<Pick<PhoneWatchResult, "baselined" | "detected" | "skipped"> & { brands: Set<string> }> {
  const baselined = await baselineNewArtifacts(now);
  const out = { baselined, detected: 0, skipped: {} as Record<string, number>, brands: new Set<string>() };
  // Only contacts of a WATCHED artifact (one still on its first load waits: its numbers are not news yet).
  // A chat contact (Matrix) only once the person wrote in a one-to-one thread: a group member who
  // never did gave the brand nothing (WA-GIVEN-PURE-FACT-1017: a chat-learned number is given too).
  const found = await rows<Row>(sql`
    SELECT c.id, c.org_id, c.brand_id, c.source, c.phone_e164, c.primary_email, c.full_name,
           c.first_name, c.last_name, c.external_id,
           coalesce(c.source_upload_id, c.source_connection_id) AS artifact_id
    FROM contacts c
    WHERE c.phone_e164 IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM phone_given_reports r
        WHERE r.org_id = c.org_id AND r.brand_id = c.brand_id AND r.phone = c.phone_e164
      )
      AND EXISTS (
        SELECT 1 FROM phone_watch_artifacts w
        WHERE w.org_id = c.org_id AND w.brand_id = c.brand_id
          AND w.artifact_id = coalesce(c.source_upload_id, c.source_connection_id)
      )
      AND (c.channel IS NULL OR EXISTS (
        SELECT 1 FROM conversations cv WHERE cv.contact_id = c.id AND cv.inbound_count > 0
      ))
      AND ${notAddedByHand}
    ORDER BY c.last_rebuilt_at DESC, c.id
    LIMIT ${DETECT_BATCH}
  `);
  const detectedAt = new Date(now);
  for (const r of found) {
    const c = {
      contactId: String(r.id),
      orgId: String(r.org_id),
      brandId: String(r.brand_id),
      source: String(r.source),
      phone: String(r.phone_e164),
    };
    const inserted = await db
      .insert(phoneGivenReports)
      .values({
        ...c,
        sourceContactId: (r.external_id as string | null) ?? null,
        artifactId: (r.artifact_id as string | null) ?? null,
        fullName: (r.full_name as string | null) ?? null,
        firstName: (r.first_name as string | null) ?? null,
        lastName: (r.last_name as string | null) ?? null,
        email: (r.primary_email as string | null) ?? null,
        detectedAt,
        status: PHONE_STATUS.PENDING,
        reason: null,
      })
      .onConflictDoNothing()
      .returning({ id: phoneGivenReports.id });
    if (inserted.length === 0) continue;
    out.detected += 1;
    out.brands.add(`${c.orgId}|${c.brandId}`);
    console.log(
      `[crm-service][phone-trigger] detected a number given on ${c.source} (brand ${c.brandId}, contact ${c.contactId}) at ${detectedAt.toISOString()}`,
    );
  }
  return out;
}

async function dueReports(now: number): Promise<PhoneGivenReport[]> {
  const found = await db
    .select()
    .from(phoneGivenReports)
    .where(
      and(
        inArray(phoneGivenReports.status, [PHONE_STATUS.PENDING, PHONE_STATUS.FAILED]),
        or(isNull(phoneGivenReports.reason), ne(phoneGivenReports.reason, PHONE_REASONS.CAMPAIGN_REFUSED)),
        gt(phoneGivenReports.detectedAt, new Date(now - PHONE_REPORT_RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(phoneGivenReports.detectedAt, phoneGivenReports.id);
  return found.filter((r) => nextAttemptDue(r.attempts, r.lastAttemptAt) <= now);
}

/** Who the brand's org runs are attributed to: whoever connected one of its sources. */
async function brandActor(orgId: string, brandId: string): Promise<string | null> {
  const [r] = await rows<{ user_id: string }>(sql`
    SELECT created_by_user_id AS user_id FROM (
      SELECT created_by_user_id, 1 AS o FROM people_scopes WHERE org_id = ${orgId} AND brand_id = ${brandId}
      UNION ALL SELECT created_by_user_id, 2 FROM auth_connections WHERE org_id = ${orgId} AND brand_id = ${brandId}
      UNION ALL SELECT created_by_user_id, 3 FROM posthog_connections WHERE org_id = ${orgId} AND brand_id = ${brandId}
      UNION ALL SELECT created_by_user_id, 4 FROM ghl_connections WHERE org_id = ${orgId} AND brand_id = ${brandId}
      UNION ALL SELECT created_by_user_id, 5 FROM stripe_connections WHERE org_id = ${orgId} AND brand_id = ${brandId}
    ) a WHERE created_by_user_id IS NOT NULL ORDER BY o LIMIT 1
  `);
  return r?.user_id ?? null;
}

async function settle(
  r: PhoneGivenReport,
  now: number,
  set: Partial<Pick<PhoneGivenReport, "status" | "reason" | "lastError" | "offerId" | "runId" | "reportedAt" | "campaignEventId" | "campaignRecordedAt" | "campaignOutcome">>,
): Promise<void> {
  await db
    .update(phoneGivenReports)
    .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now) })
    .where(eq(phoneGivenReports.id, r.id));
}

/** 3. Report every due number: one ORG run per (org, brand). */
export async function deliverDue(now: number = Date.now()): Promise<PhoneWatchResult["delivered"]> {
  if (!campaignServiceConfigured()) return [];
  return deliverReports(await dueReports(now), now);
}

/** Deliver these reports now, one ORG run per (org, brand). The caller picked them. */
async function deliverReports(due: PhoneGivenReport[], now: number, replay = false): Promise<PhoneWatchResult["delivered"]> {
  const delivered: PhoneWatchResult["delivered"] = [];
  const groups = new Map<string, PhoneGivenReport[]>();
  for (const r of due) groups.set(`${r.orgId}|${r.brandId}`, [...(groups.get(`${r.orgId}|${r.brandId}`) ?? []), r]);
  for (const reports of groups.values()) {
    const { orgId, brandId } = reports[0];
    const userId = await brandActor(orgId, brandId);
    if (!userId) {
      for (const r of reports) {
        await settle(r, now, { status: PHONE_STATUS.FAILED, reason: PHONE_REASONS.CAMPAIGN_UNREACHABLE, lastError: "no user of the brand to attribute the run to" });
        delivered.push({ reportId: r.id, status: PHONE_STATUS.FAILED, reason: PHONE_REASONS.CAMPAIGN_UNREACHABLE });
      }
      continue;
    }
    const run = await createRun({ orgId, userId, brandIds: [brandId], serviceName: SERVICE_NAME, taskName: "phone-trigger.report" });
    const identity = { orgId, userId, runId: run.id, brandId };
    let failed = false;
    try {
      // Read once per brand; a brand-service outage leaves every report for the next pass.
      // Same answer as a form submission (WA-GREETING-OFFER-1027): the offer the brand STATED
      // for every form wins, then its only active offer; several and none stated = offer_unknown.
      const offer = await resolveOffer(identity, null);
      for (const r of reports) {
        const outcome = await deliverOne(r, identity, offer, now, replay && repliedOff(r) ? r.campaignEventId : null);
        if (outcome.status === PHONE_STATUS.FAILED) failed = true;
        delivered.push({ reportId: r.id, ...outcome });
      }
    } catch (err) {
      failed = true;
      console.warn(`[crm-service][phone-trigger] brand ${brandId}: offers unreadable, retried next pass: ${(err as Error).message}`);
    }
    await updateRun(run.id, failed ? "failed" : "completed", { orgId, userId, runId: run.id, brandIds: [brandId] });
  }
  return delivered;
}

async function deliverOne(
  r: PhoneGivenReport,
  identity: { orgId: string; userId: string; runId: string; brandId: string },
  offer: OfferAnswer,
  now: number,
  replayOf: string | null = null,
): Promise<{ status: string; reason: string | null }> {
  if (!dialablePhone([r.phone])) {
    await settle(r, now, { status: PHONE_STATUS.SKIPPED, reason: PHONE_REASONS.INVALID_NUMBER, runId: identity.runId });
    return { status: PHONE_STATUS.SKIPPED, reason: PHONE_REASONS.INVALID_NUMBER };
  }
  if (offer.offerId === null) {
    const detail = offer.detail.replace(/: state it with .*$/, "");
    console.warn(`[crm-service][phone-trigger] number ${r.id} (brand ${r.brandId}) not reported: ${detail}`);
    await settle(r, now, { status: PHONE_STATUS.FAILED, reason: PHONE_REASONS.OFFER_UNKNOWN, lastError: detail, runId: identity.runId });
    return { status: PHONE_STATUS.FAILED, reason: PHONE_REASONS.OFFER_UNKNOWN };
  }
  try {
    const recorded = await recordTriggerEvent(
      identity,
      phoneOccurrenceBody({
        brandId: r.brandId,
        offerId: offer.offerId,
        phone: r.phone,
        source: r.source,
        email: r.email,
        fullName: r.fullName,
        firstName: r.firstName,
        lastName: r.lastName,
        contactId: r.contactId,
        sourceContactId: r.sourceContactId,
        detectedAt: r.detectedAt,
        replayOf,
      }),
    );
    const reportedAt = new Date();
    await settle(r, now, {
      status: PHONE_STATUS.REPORTED,
      reason: null,
      lastError: null,
      offerId: offer.offerId,
      runId: identity.runId,
      reportedAt,
      campaignEventId: recorded.eventId,
      campaignRecordedAt: recorded.recordedAt,
      campaignOutcome: recorded.event,
    });
    console.log(
      `[crm-service][phone-trigger] reported number ${r.id} (brand ${r.brandId}, ${r.source}) as event ${recorded.eventId}` +
        `${recorded.replayed ? " (replayed)" : ""}: detected ${r.detectedAt.toISOString()}, reported ${reportedAt.toISOString()}, ` +
        `outcome ${String(recorded.event.outcome ?? recorded.event.status ?? "-")}${recorded.event.skipReason ? `/${String(recorded.event.skipReason)}` : ""}`,
    );
    return { status: PHONE_STATUS.REPORTED, reason: null };
  } catch (err) {
    const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
    const reason = final ? PHONE_REASONS.CAMPAIGN_REFUSED : PHONE_REASONS.CAMPAIGN_UNREACHABLE;
    console.warn(`[crm-service][phone-trigger] number ${r.id} (brand ${r.brandId}) not reported: ${(err as Error).message}`);
    await settle(r, now, { status: PHONE_STATUS.FAILED, reason, lastError: (err as Error).message, offerId: offer.offerId, runId: identity.runId });
    return { status: PHONE_STATUS.FAILED, reason };
  }
}

/** Statuses an owner door may act on: a report not sent yet (never one reported, skipped or finally refused). */
function unsent(r: PhoneGivenReport): boolean {
  return (r.status === PHONE_STATUS.FAILED || r.status === PHONE_STATUS.PENDING) && r.reason !== PHONE_REASONS.CAMPAIGN_REFUSED;
}

export interface OwnerDoorResult {
  acted: { reportId: string; status: string; reason: string | null }[];
  refused: { reportId: string; error: string }[];
}

/** A report campaign-service took but answered `skipped / campaign_off`: nothing ran, its campaign was Off. */
export function repliedOff(r: Pick<PhoneGivenReport, "status" | "campaignEventId" | "campaignOutcome">): boolean {
  const o = (r.campaignOutcome ?? {}) as Record<string, unknown>;
  return r.status === PHONE_STATUS.REPORTED && !!r.campaignEventId && o.outcome === "skipped" && o.skipReason === "campaign_off";
}

async function loadReports(
  reportIds: string[],
  replayCampaignOff = false,
): Promise<{ found: PhoneGivenReport[]; refused: OwnerDoorResult["refused"] }> {
  const found = reportIds.length ? await db.select().from(phoneGivenReports).where(inArray(phoneGivenReports.id, reportIds)) : [];
  const ok = (r: PhoneGivenReport) => unsent(r) || (replayCampaignOff && repliedOff(r));
  const refused: OwnerDoorResult["refused"] = [];
  for (const id of reportIds) {
    const r = found.find((f) => f.id === id);
    if (!r) refused.push({ reportId: id, error: "report_not_found" });
    else if (!ok(r)) refused.push({ reportId: id, error: `not_unsent: ${r.status}${r.reason ? `/${r.reason}` : ""}` });
  }
  return { found: found.filter(ok), refused };
}

/**
 * OWNER DOOR (WA-GREETING-OFFER-1027): deliver these unsent reports NOW, past the 24 h retry
 * window (a report the loop gave up on, e.g. 5 days of offer_unknown). Same rules as the loop:
 * an impossible number is skipped, the offer resolved as usual, the same idempotency key.
 * `replayCampaignOff`: also a report campaign-service answered `skipped / campaign_off` (the campaign was Off,
 * final there), sent again as a NEW occurrence keyed on that first event, once the owner turned it back on.
 */
export async function redeliverReports(
  reportIds: string[],
  now: number = Date.now(),
  opts: { replayCampaignOff?: boolean } = {},
): Promise<OwnerDoorResult> {
  if (!campaignServiceConfigured()) throw new Error("campaign-service is not configured");
  const { found, refused } = await loadReports(reportIds, opts.replayCampaignOff === true);
  return { acted: await deliverReports(found, now, opts.replayCampaignOff === true), refused };
}

/** OWNER DOOR: these unsent reports are never sent (`skipped / withheld`, the note kept in last_error). */
export async function withholdReports(reportIds: string[], note: string, now: number = Date.now()): Promise<OwnerDoorResult> {
  const { found, refused } = await loadReports(reportIds);
  const acted: OwnerDoorResult["acted"] = [];
  for (const r of found) {
    await db
      .update(phoneGivenReports)
      .set({ status: PHONE_STATUS.SKIPPED, reason: PHONE_REASONS.WITHHELD, lastError: `withheld: ${note}`.slice(0, 1000), lastAttemptAt: new Date(now) })
      .where(and(eq(phoneGivenReports.id, r.id), inArray(phoneGivenReports.status, [PHONE_STATUS.FAILED, PHONE_STATUS.PENDING])));
    acted.push({ reportId: r.id, status: PHONE_STATUS.SKIPPED, reason: PHONE_REASONS.WITHHELD });
  }
  return { acted, refused };
}

/** lead-service learns of a person through our fact feed: build the brand's people now (unawaited). */
async function refreshBrandPeople(orgId: string, brandId: string): Promise<void> {
  try {
    const [scope] = await db.select().from(peopleScopes).where(and(eq(peopleScopes.orgId, orgId), eq(peopleScopes.brandId, brandId)));
    if (scope) await runScopeBuild(scope, { followUp: true });
  } catch (err) {
    console.error(`[crm-service][phone-trigger] people build of brand ${brandId} after a new number failed:`, err);
  }
}

/** One pass: fast mirror, detect, deliver. */
export async function runPhoneWatchPass(now: number = Date.now()): Promise<PhoneWatchResult> {
  const mirrored = process.env.PHONE_WATCH_FAST_MIRROR === "off" ? [] : await fastMirror(now);
  const { brands, ...detected } = await detectNewPhones(now);
  // A PostHog person new or changed (a visitor who typed their website, name, email...:
  // ONBOARDING-IN-UNIBOX-1015) becomes a person of the brand's Unibox at the build; their
  // later events need none (the thread reads the mirror live).
  const refresh = new Set(brands);
  for (const m of mirrored) if (m.source === "posthog" && m.changed > 0) refresh.add(`${m.orgId}|${m.brandId}`);
  if (process.env.PHONE_TRIGGER_REFRESH !== "off") {
    for (const b of refresh) {
      const [orgId, brandId] = b.split("|");
      void refreshBrandPeople(orgId, brandId);
    }
  }
  const delivered = await deliverDue(now);
  return { mirrored, ...detected, delivered };
}

let running = false;

/** In-process, every PHONE_WATCH_INTERVAL_MS, first pass 60s after boot, never two at once. */
export function startPhoneWatch(): void {
  if (process.env.PHONE_WATCH === "off") return;
  const tick = () => {
    if (running) return;
    running = true;
    runPhoneWatchPass()
      .catch((e) => console.error("[crm-service][phone-trigger] pass failed:", e))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(() => {
    tick();
    setInterval(tick, PHONE_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}
