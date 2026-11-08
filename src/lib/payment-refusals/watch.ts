/**
 * THE REFUSED PAYMENT WATCH (REFUSED-CARD-LEAD-EVENT-1103): every refused charge a brand's Stripe states (mirrored into
 * `stripe_transactions` within a minute by the fast mirror, lib/phone-trigger/) becomes ONE Lead event (`account_event`,
 * `item.kind = payment_refused`) for the person who paid, on ONE offer of the brand (lib/account-offer.ts ->
 * lib/offer-pick.ts, ACCOUNT-EVENTS-ONE-OFFER-1108), through campaign-service's trigger door. Rules in rules.ts.
 *
 * Every `PAYMENT_REFUSED_WATCH_INTERVAL_MS` (60 s), first pass 60 s after boot, one at a time; `PAYMENT_REFUSED_WATCH=off`
 * stops it. A pass: record every fresh refused charge not recorded yet (`payment_refusal_reports`, UNIQUE per connection x
 * charge, so a re-read records nothing twice), then report the due ones on ONE org run per (org, brand), filed under the
 * connection's creator. Retries 1 -> 60 min for 24 h; a 400 / 422 is final.
 */

import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { paymentRefusalReports, stripeConnections, stripeTransactions, type PaymentRefusalReport } from "../../db/schema.js";
import { accountPersonOf, resolveAccountFactOffer } from "../account-offer.js";
import { contactFacts, type OfferPick } from "../offer-pick.js";
import { formatMoney } from "../stripe/attempts.js";
import { createRun, updateRun } from "../runs-client.js";
import { CampaignRefusal, FINAL_REFUSAL_STATUSES, campaignServiceConfigured, recordTriggerEvent } from "../trigger-door.js";
import {
  REFUSAL_FRESH_WINDOW_MS,
  REFUSAL_REASONS,
  REFUSAL_STATUS,
  latestPerPerson,
  refusalIsFresh,
  refusalOccurrenceBody,
  refusalVerdict,
} from "./rules.js";

const SERVICE_NAME = "crm-service";
export const PAYMENT_REFUSED_WATCH_INTERVAL_MS = Number(process.env.PAYMENT_REFUSED_WATCH_INTERVAL_MS) || 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const REPORT_RETRY_WINDOW_MS = 24 * 60 * 60_000;

export function nextAttemptDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  return lastAttemptAt.getTime() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/** Record every fresh refused charge not recorded yet: pending, or skipped (staff, nobody named). */
export async function detectRefusals(now: number = Date.now()): Promise<{ recorded: number; pending: number }> {
  const since = new Date(now - REFUSAL_FRESH_WINDOW_MS);
  const found = (await db.execute(sql`
    SELECT t.org_id, t.brand_id, t.connection_id, t.external_id, t.occurred_at, sc.created_at AS connection_created_at,
      c.primary_email, c.phone_e164, c.full_name, c.first_name, c.last_name
    FROM stripe_transactions t
    JOIN stripe_connections sc ON sc.id = t.connection_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.kind = 'payment' AND t.status = 'failed'
      AND t.occurred_at > ${since.toISOString()}::timestamptz
      AND t.occurred_at >= sc.created_at
      AND NOT EXISTS (
        SELECT 1 FROM payment_refusal_reports r WHERE r.connection_id = t.connection_id AND r.charge_id = t.external_id
      )
    ORDER BY t.occurred_at, t.external_id`)) as unknown as {
    org_id: string;
    brand_id: string;
    connection_id: string;
    external_id: string;
    occurred_at: Date | string;
    connection_created_at: Date | string;
    primary_email: string | null;
    phone_e164: string | null;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
  }[];
  let recorded = 0;
  let pending = 0;
  for (const r of found) {
    const chargedAt = new Date(r.occurred_at);
    if (!refusalIsFresh(chargedAt, new Date(r.connection_created_at), now)) continue;
    const v = refusalVerdict(r.primary_email, r.phone_e164);
    const name = r.full_name?.trim() || [r.first_name, r.last_name].filter((x) => x?.trim()).join(" ").trim() || null;
    const inserted = await db
      .insert(paymentRefusalReports)
      .values({
        orgId: r.org_id,
        brandId: r.brand_id,
        connectionId: r.connection_id,
        chargeId: r.external_id,
        chargedAt,
        email: v.email,
        phone: v.phone,
        fullName: name,
        status: v.status,
        reason: v.status === "skipped" ? v.reason : null,
      })
      .onConflictDoNothing()
      .returning({ id: paymentRefusalReports.id });
    if (inserted.length === 0) continue;
    recorded++;
    if (v.status === "pending") pending++;
  }
  return { recorded, pending };
}

async function dueReports(now: number): Promise<PaymentRefusalReport[]> {
  const found = await db
    .select()
    .from(paymentRefusalReports)
    .where(
      and(
        inArray(paymentRefusalReports.status, [REFUSAL_STATUS.PENDING, REFUSAL_STATUS.FAILED]),
        or(isNull(paymentRefusalReports.reason), ne(paymentRefusalReports.reason, REFUSAL_REASONS.CAMPAIGN_REFUSED)),
        gt(paymentRefusalReports.createdAt, new Date(now - REPORT_RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(paymentRefusalReports.chargedAt, paymentRefusalReports.id);
  return found.filter((r) => nextAttemptDue(r.attempts, r.lastAttemptAt) <= now);
}

export interface DeliveredRefusal {
  reportId: string;
  status: string;
  reason: string | null;
}

/** Report every due refusal: one ORG run per (org, brand), filed under the Stripe connection's creator. */
export async function deliverRefusals(now: number = Date.now()): Promise<DeliveredRefusal[]> {
  if (!campaignServiceConfigured()) return [];
  const due = await dueReports(now);
  if (due.length === 0) return [];
  const out: DeliveredRefusal[] = [];
  const groups = new Map<string, PaymentRefusalReport[]>();
  for (const r of due) groups.set(`${r.orgId}|${r.brandId}`, [...(groups.get(`${r.orgId}|${r.brandId}`) ?? []), r]);
  for (const reports of groups.values()) {
    const { orgId, brandId } = reports[0];
    const connections = await db
      .select()
      .from(stripeConnections)
      .where(inArray(stripeConnections.id, [...new Set(reports.map((r) => r.connectionId))]));
    const conn = new Map(connections.map((c) => [c.id, c]));
    const userId = connections[0]?.createdByUserId;
    if (!userId) {
      console.warn(`[crm-service][payment-refused] brand ${brandId}: its Stripe connection is gone, reports retried next pass`);
      continue;
    }
    const { report, superseded } = latestPerPerson(reports);
    for (const r of superseded) {
      await db
        .update(paymentRefusalReports)
        .set({ status: REFUSAL_STATUS.SKIPPED, reason: REFUSAL_REASONS.SUPERSEDED, lastAttemptAt: new Date(now) })
        .where(eq(paymentRefusalReports.id, r.id));
      out.push({ reportId: r.id, status: REFUSAL_STATUS.SKIPPED, reason: REFUSAL_REASONS.SUPERSEDED });
    }
    const run = await createRun({ orgId, userId, brandIds: [brandId], serviceName: SERVICE_NAME, taskName: "payment-refused.report" });
    const identity = { orgId, userId, runId: run.id, brandId };
    const runIdentity = { orgId, userId, runId: run.id, brandIds: [brandId] };
    const settle = (r: PaymentRefusalReport, set: Partial<PaymentRefusalReport>) =>
      db
        .update(paymentRefusalReports)
        .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now), runId: run.id })
        .where(eq(paymentRefusalReports.id, r.id));
    let failed = false;
    try {
      const charges = new Map(
        (
          await db
            .select()
            .from(stripeTransactions)
            .where(
              and(
                eq(stripeTransactions.kind, "payment"),
                inArray(stripeTransactions.connectionId, [...conn.keys()]),
                inArray(stripeTransactions.externalId, report.map((r) => r.chargeId)),
              ),
            )
        ).map((t) => [`${t.connectionId}|${t.externalId}`, t]),
      );
      for (const r of report) {
        const t = charges.get(`${r.connectionId}|${r.chargeId}`);
        const person = await accountPersonOf(orgId, brandId, r.email, r.phone);
        // ACCOUNT-EVENTS-ONE-OFFER-1108: ONE event on ONE offer (the resolver every trigger shares), never one per offer.
        let offer: OfferPick;
        try {
          const contact = await contactFacts(orgId, t?.contactId ?? null);
          const charge = {
            amount: formatMoney(t?.amountMinor ?? null, t?.currency ?? null),
            description: t?.description ?? null,
          };
          offer = await resolveAccountFactOffer(identity, {
            ledger: "refusal",
            reportId: r.id,
            persisted: { offerId: r.offerId, offerBasis: r.offerBasis, offerVerdict: r.offerVerdict },
            person: { email: r.email, phone: r.phone },
            who: person,
            what: "A payment this person made to the brand was just refused by their bank (a card charge on the brand's Stripe).",
            facts: { name: person.name ?? r.fullName, email: r.email, charge, ...(contact ? { contact } : {}) },
            hasPersonEvidence: !!charge.description || !!contact,
          });
        } catch (err) {
          failed = true;
          const message = `placing the refusal on an offer failed: ${(err as Error).message}`.slice(0, 1000);
          console.warn(`[crm-service][payment-refused] ${r.chargeId} for ${r.email ?? r.phone} not reported: ${message}`);
          await settle(r, { status: REFUSAL_STATUS.FAILED, reason: REFUSAL_REASONS.OFFER_PICK_FAILED, lastError: message });
          out.push({ reportId: r.id, status: REFUSAL_STATUS.FAILED, reason: REFUSAL_REASONS.OFFER_PICK_FAILED });
          continue;
        }
        if (offer.offerId === null) {
          failed = true;
          await settle(r, { status: REFUSAL_STATUS.FAILED, reason: REFUSAL_REASONS.OFFER_UNKNOWN, lastError: offer.detail.replace(/: state it with .*$/, "") });
          out.push({ reportId: r.id, status: REFUSAL_STATUS.FAILED, reason: REFUSAL_REASONS.OFFER_UNKNOWN });
          continue;
        }
        const offerId = offer.offerId;
        const placed = { offerId, offerBasis: offer.basis, offerVerdict: offer.verdict, offerIds: [offerId] };
        // Persisted at once (judged once): a campaign-service failure below retries on the same pick.
        await db.update(paymentRefusalReports).set(placed).where(eq(paymentRefusalReports.id, r.id));
        try {
          const rec = await recordTriggerEvent(
            identity,
            refusalOccurrenceBody({
              brandId,
              offerId,
              email: r.email,
              phone: r.phone,
              name: person.name ?? r.fullName,
              chargeId: r.chargeId,
              chargedAt: r.chargedAt,
              amountMinor: t?.amountMinor ?? null,
              currency: t?.currency ?? null,
              description: t?.description ?? null,
              detail: (t?.detail as Record<string, unknown> | undefined) ?? {},
              stripeAccountId: conn.get(r.connectionId)?.accountId ?? null,
            }),
          );
          const recorded = [{ offerId, eventId: rec.eventId, replayed: rec.replayed }];
          await settle(r, { status: REFUSAL_STATUS.REPORTED, reason: null, lastError: null, ...placed, campaignEvents: recorded, reportedAt: new Date() });
          console.log(`[crm-service][payment-refused] reported ${r.chargeId} for ${r.email ?? r.phone} as account_event on offer ${offerId} (${offer.basis})`);
          out.push({ reportId: r.id, status: REFUSAL_STATUS.REPORTED, reason: null });
        } catch (err) {
          failed = true;
          const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
          const reason = final ? REFUSAL_REASONS.CAMPAIGN_REFUSED : REFUSAL_REASONS.CAMPAIGN_UNREACHABLE;
          console.warn(`[crm-service][payment-refused] ${r.chargeId} for ${r.email ?? r.phone} not reported (${reason}): ${(err as Error).message}`);
          await settle(r, { status: REFUSAL_STATUS.FAILED, reason, lastError: (err as Error).message.slice(0, 1000), ...placed });
          out.push({ reportId: r.id, status: REFUSAL_STATUS.FAILED, reason });
        }
      }
      await updateRun(run.id, failed ? "failed" : "completed", runIdentity);
    } catch (err) {
      console.warn(`[crm-service][payment-refused] brand ${brandId}: reports retried next pass: ${(err as Error).message}`);
      await updateRun(run.id, "failed", runIdentity).catch(() => {});
    }
  }
  return out;
}

export interface RefusalWatchResult {
  detected: { recorded: number; pending: number };
  delivered: DeliveredRefusal[];
}

export async function runRefusalWatchPass(now: number = Date.now()): Promise<RefusalWatchResult> {
  const detected = await detectRefusals(now);
  const delivered = await deliverRefusals(now);
  return { detected, delivered };
}

let running = false;

/** Run one pass now unless one is running. */
export async function refusalWatchNow(): Promise<RefusalWatchResult | { skipped: "pass_running" }> {
  if (running) return { skipped: "pass_running" };
  running = true;
  try {
    return await runRefusalWatchPass();
  } finally {
    running = false;
  }
}

/** In-process, every PAYMENT_REFUSED_WATCH_INTERVAL_MS, first pass 60 s after boot, never two at once. */
export function startRefusalWatch(): void {
  if (process.env.PAYMENT_REFUSED_WATCH === "off") return;
  const tick = () => {
    refusalWatchNow()
      .then((r) => {
        if ("detected" in r && (r.detected.recorded > 0 || r.delivered.length > 0)) {
          console.log(`[crm-service][payment-refused] pass: ${JSON.stringify({ detected: r.detected, delivered: r.delivered.length })}`);
        }
      })
      .catch((e) => console.error("[crm-service][payment-refused] pass failed:", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, PAYMENT_REFUSED_WATCH_INTERVAL_MS).unref();
  }, 60_000).unref();
}
