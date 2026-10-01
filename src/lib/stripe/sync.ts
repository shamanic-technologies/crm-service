/**
 * The Stripe ingestion pass: bronze → silver, for one connection. Read-only
 * toward Stripe and free (Stripe does not bill API reads), so no cost is
 * declared — crm-service declares none of its own.
 *
 *  - BRONZE  customers, charges, refunds and subscriptions verbatim in
 *            `stripe_raw_records`, keyed on Stripe's own id; written only when
 *            the content hash moved.
 *  - SILVER  customers → `contacts` (source `stripe`); charges, refunds and
 *            subscriptions → `stripe_transactions`, read back from BRONZE, zero
 *            LLM.
 *
 * Window: a pass re-lists objects CREATED in the last 30 days (a charge is
 * refunded, a subscription renews or is cancelled within that span in the
 * common case). Once a day — and on the first pass — it re-lists everything,
 * so a change on an older object (an edited email, a late cancellation) still
 * lands within a day.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contacts,
  stripeConnections,
  stripeRawRecords,
  stripeTransactions,
  type StripeConnection,
} from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, updateRun } from "../runs-client.js";
import { resolveBrandCredential } from "../gohighlevel/credentials.js";
import { canonicalHash } from "../gohighlevel/records.js";
import { normalizePhone } from "../people/identity.js";
import { listStripe, STRIPE_KINDS, STRIPE_MAX_PAGES, type StripeKind, type StripeObject } from "./client.js";
import {
  deriveCharge,
  deriveRefund,
  deriveStripeCustomer,
  deriveSubscription,
  STRIPE_SOURCE,
  type DerivedTransaction,
} from "./records.js";

export const STRIPE_PROVIDER = "stripe";
export const STRIPE_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const STRIPE_FULL_RESYNC_MS = 24 * 60 * 60 * 1000;

export interface StripeSyncResult {
  connectionId: string;
  runId: string;
  full: boolean;
  mirrored: Record<StripeKind, number>;
  changed: Record<StripeKind, number>;
  contactsDerived: number;
  transactionsDerived: number;
  transactionsLinked: number;
  /** Kinds whose listing hit the page ceiling this pass (older objects not re-read). */
  truncated: StripeKind[];
}

async function mirrorBatch(conn: StripeConnection, kind: StripeKind, records: StripeObject[]): Promise<string[]> {
  if (records.length === 0) return [];
  const values = records.map((payload) => ({
    orgId: conn.orgId,
    brandId: conn.brandId,
    connectionId: conn.id,
    kind,
    externalId: payload.id,
    contentHash: canonicalHash(payload),
    payload: payload as Record<string, unknown>,
  }));
  const changed: string[] = [];
  for (let i = 0; i < values.length; i += 500) {
    const rows = await db
      .insert(stripeRawRecords)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [stripeRawRecords.connectionId, stripeRawRecords.kind, stripeRawRecords.externalId],
        set: { contentHash: sql`excluded.content_hash`, payload: sql`excluded.payload`, mirroredAt: new Date() },
        setWhere: sql`${stripeRawRecords.contentHash} <> excluded.content_hash`,
      })
      .returning({ externalId: stripeRawRecords.externalId });
    for (const row of rows) changed.push(row.externalId);
  }
  return changed;
}

async function readBronze(conn: StripeConnection, kind: StripeKind, externalIds?: string[]) {
  const base = [eq(stripeRawRecords.connectionId, conn.id), eq(stripeRawRecords.kind, kind)];
  const read = async (ids?: string[]) =>
    (
      await db
        .select({ payload: stripeRawRecords.payload })
        .from(stripeRawRecords)
        .where(and(...base, ...(ids ? [inArray(stripeRawRecords.externalId, ids)] : [])))
    ).map((r) => r.payload as Record<string, unknown>);
  if (!externalIds) return read();
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < externalIds.length; i += 1000) out.push(...(await read(externalIds.slice(i, i + 1000))));
  return out;
}

async function deriveContacts(conn: StripeConnection, externalIds?: string[]): Promise<number> {
  const now = new Date();
  let derived = 0;
  for (const payload of await readBronze(conn, "customer", externalIds)) {
    const c = deriveStripeCustomer(payload);
    if (!c) continue;
    const fields = {
      primaryEmail: c.primaryEmail,
      phoneE164: normalizePhone(c.phone),
      fullName: c.fullName,
      sourceCreatedAt: c.sourceCreatedAt,
      sourceConnectionId: conn.id,
      lastRebuiltAt: now,
    };
    await db
      .insert(contacts)
      .values({
        orgId: conn.orgId,
        brandId: conn.brandId,
        ...fields,
        rawAttributes: {},
        consentStatus: "unknown",
        unsubscribed: false,
        source: STRIPE_SOURCE,
        externalId: c.externalId,
      })
      .onConflictDoUpdate({
        target: [contacts.orgId, contacts.brandId, contacts.source, contacts.externalId],
        set: fields,
      });
    derived++;
  }
  return derived;
}

/** Charge id → customer id, from the mirrored charges (a refund names only its charge). */
async function chargeCustomers(conn: StripeConnection): Promise<Map<string, string | null>> {
  const rows = (await db.execute(sql`
    SELECT external_id, payload->>'customer' AS customer
    FROM stripe_raw_records WHERE connection_id = ${conn.id} AND kind = 'charge'
  `)) as unknown as { external_id: string; customer: string | null }[];
  return new Map(rows.map((r) => [r.external_id, r.customer]));
}

async function writeTransaction(conn: StripeConnection, t: DerivedTransaction, now: Date) {
  const fields = {
    externalCustomerId: t.externalCustomerId,
    occurredAt: t.occurredAt,
    amountMinor: t.amountMinor,
    currency: t.currency,
    status: t.status,
    description: t.description,
    detail: t.detail,
    lastRebuiltAt: now,
  };
  await db
    .insert(stripeTransactions)
    .values({
      orgId: conn.orgId,
      brandId: conn.brandId,
      connectionId: conn.id,
      kind: t.kind,
      externalId: t.externalId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [stripeTransactions.connectionId, stripeTransactions.kind, stripeTransactions.externalId],
      set: fields,
    });
}

async function deriveTransactions(
  conn: StripeConnection,
  changed?: { charge: string[]; refund: string[]; subscription: string[] },
): Promise<number> {
  const now = new Date();
  let derived = 0;
  for (const p of await readBronze(conn, "charge", changed?.charge)) {
    const t = deriveCharge(p);
    if (!t) continue;
    await writeTransaction(conn, t, now);
    derived++;
  }
  const refunds = await readBronze(conn, "refund", changed?.refund);
  if (refunds.length > 0) {
    const customers = await chargeCustomers(conn);
    for (const p of refunds) {
      const t = deriveRefund(p, (charge) => customers.get(charge) ?? null);
      if (!t) continue;
      await writeTransaction(conn, t, now);
      derived++;
    }
  }
  for (const p of await readBronze(conn, "subscription", changed?.subscription)) {
    const t = deriveSubscription(p);
    if (!t) continue;
    await writeTransaction(conn, t, now);
    derived++;
  }
  return derived;
}

/** Attach every unattached transaction to its customer's silver contact. */
async function linkTransactions(conn: StripeConnection): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE stripe_transactions t SET contact_id = c.id
    FROM contacts c
    WHERE t.connection_id = ${conn.id} AND t.contact_id IS NULL AND t.external_customer_id IS NOT NULL
      AND c.source = ${STRIPE_SOURCE} AND c.source_connection_id = ${conn.id}
      AND c.external_id = t.external_customer_id
    RETURNING t.id
  `);
  return (rows as unknown as unknown[]).length;
}

export async function syncStripeConnection(conn: StripeConnection): Promise<StripeSyncResult> {
  const startedAt = new Date();
  const full = !conn.lastFullSyncAt || startedAt.getTime() - conn.lastFullSyncAt.getTime() >= STRIPE_FULL_RESYNC_MS;
  const since = full ? null : new Date(startedAt.getTime() - STRIPE_RECENT_WINDOW_MS);
  const run = await createRun({
    orgId: conn.orgId,
    userId: conn.createdByUserId,
    brandIds: [conn.brandId],
    serviceName: SERVICE_NAME,
    taskName: "stripe.sync",
  });
  const identity = { orgId: conn.orgId, userId: conn.createdByUserId, runId: run.id, brandIds: [conn.brandId] };
  try {
    const key = await resolveBrandCredential(STRIPE_PROVIDER, "Stripe", conn.brandId, {
      orgId: conn.orgId,
      userId: conn.createdByUserId,
      runId: run.id,
    });
    const mirrored = { customer: 0, charge: 0, refund: 0, subscription: 0 } as Record<StripeKind, number>;
    const changed = { customer: [], charge: [], refund: [], subscription: [] } as Record<StripeKind, string[]>;
    const truncated: StripeKind[] = [];
    for (const kind of STRIPE_KINDS) {
      let pages = 0;
      for await (const page of listStripe(key, kind, since)) {
        pages++;
        mirrored[kind] += page.length;
        changed[kind].push(...(await mirrorBatch(conn, kind, page)));
      }
      if (pages >= STRIPE_MAX_PAGES) truncated.push(kind);
    }
    if (truncated.length) {
      console.warn(
        `[crm-service][stripe] connection ${conn.id}: listing capped at ${STRIPE_MAX_PAGES} pages for ${truncated.join(", ")}; older objects were not re-read this pass`,
      );
    }
    const contactsDerived = await deriveContacts(conn, changed.customer);
    const transactionsDerived = await deriveTransactions(conn, changed);
    const transactionsLinked = await linkTransactions(conn);

    await db
      .update(stripeConnections)
      .set({
        status: "active",
        lastError: null,
        lastRunId: run.id,
        lastSyncedAt: new Date(),
        ...(full ? { lastFullSyncAt: startedAt } : {}),
      })
      .where(eq(stripeConnections.id, conn.id));
    await updateRun(run.id, "completed", identity);
    return {
      connectionId: conn.id,
      runId: run.id,
      full,
      mirrored,
      changed: Object.fromEntries(STRIPE_KINDS.map((k) => [k, changed[k].length])) as Record<StripeKind, number>,
      contactsDerived,
      transactionsDerived,
      transactionsLinked,
      truncated,
    };
  } catch (err) {
    await db
      .update(stripeConnections)
      .set({ status: "error", lastError: (err as Error).message, lastRunId: run.id })
      .where(eq(stripeConnections.id, conn.id));
    await updateRun(run.id, "failed", identity).catch((e) =>
      console.error("[crm-service][stripe] failed to close run:", e),
    );
    throw err;
  }
}

/** Every active connection (or one). Failures are recorded AND returned, never swallowed. */
export async function runStripeSyncPass(connectionId?: string) {
  const where = connectionId
    ? eq(stripeConnections.id, connectionId)
    : inArray(stripeConnections.status, ["active", "error"]);
  const connections = await db.select().from(stripeConnections).where(where);
  const results: StripeSyncResult[] = [];
  const failures: { connectionId: string; error: string }[] = [];
  for (const conn of connections) {
    if (conn.status === "paused") continue;
    try {
      results.push(await syncStripeConnection(conn));
    } catch (err) {
      console.error(`[crm-service][stripe] sync failed for connection ${conn.id}:`, err);
      failures.push({ connectionId: conn.id, error: (err as Error).message });
    }
  }
  return { connections: connections.length, results, failures };
}

/** Re-derive all silver from bronze alone — no Stripe call, no credential. */
export async function rebuildStripeFromBronze(conn: StripeConnection) {
  const contactsDerived = await deriveContacts(conn);
  await db.update(stripeTransactions).set({ contactId: null }).where(eq(stripeTransactions.connectionId, conn.id));
  const transactionsDerived = await deriveTransactions(conn);
  const transactionsLinked = await linkTransactions(conn);
  return { contactsDerived, transactionsDerived, transactionsLinked };
}
