import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  authConnections,
  authRawRecords,
  contacts,
  contactUploads,
  ghlConnections,
  phoneGivenReports,
  phoneWatchArtifacts,
  posthogConnections,
  posthogRawRecords,
} from "../../src/db/schema.js";
import { runPhoneWatchPass } from "../../src/lib/phone-trigger/watch.js";
import { PHONE_GIVEN_TRIGGER } from "../../src/lib/phone-trigger/rules.js";

/**
 * The phone watch end to end against a real database (WA-GIVEN-TRIGGER-1015).
 * PostHog, Clerk, key-service, brand-service, runs-service and campaign-service are
 * stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "fefefefe-1111-4111-8111-000000000001";
const BRAND = "fefefefe-1111-4111-8111-000000000002";
const OFFER = "fefefefe-1111-4111-8111-0000000000a1";
const USER = "user-phone-1";
const SALES_REP = "+33770000001";

process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "client-key";
process.env.PHONE_TRIGGER_REFRESH = "off";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let campaignCalls: Record<string, unknown>[] = [];
let campaignStatus = 201;
let clerkUsers: Record<string, unknown>[] = [];
let posthogPersons: Record<string, unknown>[] = [];

function installFetchStub() {
  campaignCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs")) return json({ id: "run-" + Math.random().toString(16).slice(2) });
    if (url.pathname.endsWith("/decrypt")) return json({ key: "secret" });
    if (url.host === "api.clerk.com" && url.pathname === "/v1/users") {
      expect(url.searchParams.get("order_by")).toBe("-updated_at");
      return json(clerkUsers);
    }
    if (url.host === "eu.posthog.com") {
      const q = String((JSON.parse(String(init?.body)) as { query: { query: string } }).query.query);
      if (q.includes("FROM events") && q.includes("$set")) return json({ columns: ["id"], results: posthogPersons.map((p) => [p.id]) });
      if (q.includes("FROM persons")) {
        const cols = Object.keys(posthogPersons[0] ?? { id: 1 });
        return json({ columns: cols, results: posthogPersons.map((p) => cols.map((c) => p[c])) });
      }
      return json({ columns: [], results: [] }); // visits / events of a new person
    }
    if (url.host === "brand.test" && url.pathname.endsWith("/offers")) {
      return json({ offers: [{ offerId: OFFER, name: "A", description: null, status: "active" }] });
    }
    if (url.host === "brand.test" && url.pathname.endsWith("/sales-rep")) return json({ salesRepPhone: SALES_REP });
    if (url.host === "client.test" && url.pathname === "/internal/users") return json({ users: [], total: 0 });
    if (url.host === "campaign.test" && url.pathname === "/internal/trigger-events") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      campaignCalls.push(body);
      return json({ event: { id: `ev-${campaignCalls.length}`, outcome: "skipped", skipReason: "no_campaign" }, replayed: false }, campaignStatus);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const T0 = Date.parse("2026-10-15T15:00:00Z");
const min = (n: number) => T0 + n * 60_000;

async function reports() {
  return db.select().from(phoneGivenReports).where(eq(phoneGivenReports.brandId, BRAND));
}

async function wipe() {
  await db.delete(phoneGivenReports).where(eq(phoneGivenReports.brandId, BRAND));
  await db.delete(phoneWatchArtifacts).where(eq(phoneWatchArtifacts.brandId, BRAND));
  await db.delete(contacts).where(eq(contacts.brandId, BRAND));
  await db.delete(authRawRecords).where(eq(authRawRecords.brandId, BRAND));
  await db.delete(posthogRawRecords).where(eq(posthogRawRecords.brandId, BRAND));
  await db.delete(authConnections).where(eq(authConnections.brandId, BRAND));
  await db.delete(posthogConnections).where(eq(posthogConnections.brandId, BRAND));
  await db.delete(ghlConnections).where(eq(ghlConnections.brandId, BRAND));
  await db.delete(contactUploads).where(eq(contactUploads.brandId, BRAND));
}

function clerkUser(id: string, phone: string | null, updatedAt: number, email = `${id}@example.com`) {
  return {
    id,
    first_name: "Test",
    last_name: id,
    email_addresses: [{ id: `em-${id}`, email_address: email, verification: { status: "verified" } }],
    primary_email_address_id: `em-${id}`,
    phone_numbers: [],
    public_metadata: phone ? { phone } : {},
    created_at: T0 - 86_400_000,
    updated_at: updatedAt,
  };
}

describe.skipIf(!RUN)("phone watch (whatsapp_number_given)", () => {
  let clerkConn: string;

  beforeEach(async () => {
    await wipe();
    clerkUsers = [];
    posthogPersons = [];
    campaignStatus = 201;
    const [a] = await db
      .insert(authConnections)
      .values({ orgId: ORG, brandId: BRAND, provider: "clerk", createdByUserId: USER, status: "active", lastSyncedAt: new Date(T0 - 3_600_000) })
      .returning();
    clerkConn = a.id;
    await db
      .insert(posthogConnections)
      .values({ orgId: ORG, brandId: BRAND, projectId: "1", region: "eu", createdByUserId: USER, status: "active", lastSyncedAt: new Date(T0 - 3_600_000) })
      .returning();
    // History: a Clerk user who gave a number before the watch existed.
    await db.insert(contacts).values({
      orgId: ORG, brandId: BRAND, source: "clerk", externalId: "user_old", phoneE164: "+447911123001",
      primaryEmail: "old@example.com", rawAttributes: {}, sourceConnectionId: clerkConn,
    });
    installFetchStub();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await wipe();
  });

  it("the first look at a source is a baseline: numbers it already held are never reported", async () => {
    const pass = await runPhoneWatchPass(T0);
    expect(pass.baselined.find((b) => b.artifactId === clerkConn)).toMatchObject({ phones: 1 });
    const rows = await reports();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: "+447911123001", status: "skipped", reason: "before_watch" });
    await runPhoneWatchPass(min(1));
    expect(campaignCalls).toHaveLength(0);
  });

  it("a Clerk user gaining public_metadata.phone is reported once, within the pass, and never again", async () => {
    await runPhoneWatchPass(T0);
    clerkUsers = [clerkUser("user_new", "+44 7911 123002", min(1)), clerkUser("user_stale", "+447911123009", T0 - 3_600_000)];
    const pass = await runPhoneWatchPass(min(2));
    expect(pass.mirrored.find((m) => m.connectionId === clerkConn)).toMatchObject({ changed: 1 });
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0]).toMatchObject({
      triggerId: PHONE_GIVEN_TRIGGER,
      brandId: BRAND,
      offerId: OFFER,
      idempotencyKey: `crm:phone_given:${BRAND}:+447911123002`,
      person: { phone: "+447911123002", email: "user_new@example.com", name: "Test user_new" },
      item: { kind: "phone_given", phone: "+447911123002", firstName: "Test", lastName: "user_new", source: "clerk", sourceContactId: "user_new" },
    });
    const [row] = (await reports()).filter((r) => r.phone === "+447911123002");
    expect(row).toMatchObject({ status: "reported", campaignEventId: "ev-1" });
    // Further passes (same user listed again, a full re-sync) report nothing.
    await runPhoneWatchPass(min(3));
    await runPhoneWatchPass(min(60));
    expect(campaignCalls).toHaveLength(1);
  });

  it("a PostHog visitor known only by the phone they typed is reported; signing up later with that number is the SAME occurrence", async () => {
    await runPhoneWatchPass(T0);
    posthogPersons = [{
      id: "ph-anon-1", email: null, name: "Marie Curie", first_name: "Marie", last_name: "Curie", created_at: new Date(T0).toISOString(),
      prop_phone: "+447911123003", prop_phone_number: null, prop_phoneNumber: null, is_identified: false, distinct_ids: ["anon-abc"],
    }];
    await runPhoneWatchPass(min(1));
    const [c] = await db.select().from(contacts).where(and(eq(contacts.brandId, BRAND), eq(contacts.source, "posthog")));
    expect(c).toMatchObject({ phoneE164: "+447911123003", primaryEmail: null });
    expect((c.rawAttributes as Record<string, unknown>).phoneOnly).toBe(true);
    expect(campaignCalls).toHaveLength(1);
    expect(campaignCalls[0]).toMatchObject({ person: { phone: "+447911123003", name: "Marie Curie" }, item: { source: "posthog", firstName: "Marie", lastName: "Curie" } });
    expect((campaignCalls[0].person as Record<string, unknown>).email).toBeUndefined();

    clerkUsers = [clerkUser("user_signup", "+447911123003", min(5))];
    await runPhoneWatchPass(min(6));
    expect(campaignCalls).toHaveLength(1);
    expect((await reports()).filter((r) => r.phone === "+447911123003")).toHaveLength(1);
  });

  it("staff and the brand's own numbers are reported (the pipe decides who to skip); a number read off a chat is not", async () => {
    await runPhoneWatchPass(T0);
    await db.insert(contacts).values([
      { orgId: ORG, brandId: BRAND, source: "clerk", externalId: "user_staff", phoneE164: "+447911123004", primaryEmail: "kevin@distribute.you", rawAttributes: {}, sourceConnectionId: clerkConn },
      { orgId: ORG, brandId: BRAND, source: "clerk", externalId: "user_rep", phoneE164: SALES_REP, primaryEmail: "rep@example.com", rawAttributes: {}, sourceConnectionId: clerkConn },
      { orgId: ORG, brandId: BRAND, source: "matrix", channel: "whatsapp", channelHandle: "@whatsapp_447911123005:hs", phoneE164: "+447911123005", rawAttributes: {}, sourceConnectionId: "fefefefe-1111-4111-8111-0000000000c1" },
    ]);
    await runPhoneWatchPass(min(1));
    expect(campaignCalls.map((c) => (c.person as Record<string, unknown>).phone).sort()).toEqual(["+447911123004", SALES_REP].sort());
    const byPhone = new Map((await reports()).map((r) => [r.phone, r]));
    expect(byPhone.get("+447911123004")).toMatchObject({ status: "reported", reason: null });
    expect(byPhone.get(SALES_REP)).toMatchObject({ status: "reported", reason: null });
    expect(byPhone.get("+447911123005")).toMatchObject({ status: "skipped", reason: "conversation_channel" });
  });

  it("an imported file is history, and a source still on its first sync waits", async () => {
    await runPhoneWatchPass(T0);
    const [upload] = await db
      .insert(contactUploads)
      .values({ orgId: ORG, brandId: BRAND, filename: "f.csv", contentHash: "h-phone", columnHeaders: [], runId: "r", status: "promoted" })
      .returning();
    await db.insert(contacts).values({ orgId: ORG, brandId: BRAND, source: "csv", primaryEmail: "a@example.com", phoneE164: "+447911123006", rawAttributes: {}, sourceUploadId: upload.id });
    // A CRM connected now, its first sync still running.
    const [crm] = await db.insert(ghlConnections).values({ orgId: ORG, brandId: BRAND, locationId: "loc-phone", createdByUserId: USER, status: "active" }).returning();
    await db.insert(contacts).values({ orgId: ORG, brandId: BRAND, source: "gohighlevel", externalId: "ghl-first-sync", phoneE164: "+447911123007", rawAttributes: {}, sourceConnectionId: crm.id });
    await runPhoneWatchPass(min(1));
    expect(campaignCalls).toHaveLength(0);
    const byPhone = new Map((await reports()).map((r) => [r.phone, r]));
    expect(byPhone.get("+447911123006")).toMatchObject({ status: "skipped", reason: "before_watch" });
    expect(byPhone.has("+447911123007")).toBe(false);
    // Its first sync done: what it held then is history too.
    await db.update(ghlConnections).set({ lastSyncedAt: new Date(min(2)) }).where(eq(ghlConnections.id, crm.id));
    await runPhoneWatchPass(min(3));
    expect((await reports()).find((r) => r.phone === "+447911123007")).toMatchObject({ reason: "before_watch" });
    expect(campaignCalls).toHaveLength(0);
  });

  it("campaign-service unreachable is retried with backoff; a 422 is final", async () => {
    await runPhoneWatchPass(T0);
    campaignStatus = 503;
    clerkUsers = [clerkUser("user_retry", "+447911123008", min(1))];
    await runPhoneWatchPass(min(2));
    let [row] = (await reports()).filter((r) => r.phone === "+447911123008");
    expect(row).toMatchObject({ status: "failed", reason: "campaign_unreachable", attempts: 1 });
    await runPhoneWatchPass(min(2) + 30_000); // inside the 1-min backoff: not retried
    expect(campaignCalls).toHaveLength(1);
    campaignStatus = 201;
    await runPhoneWatchPass(min(4));
    [row] = (await reports()).filter((r) => r.phone === "+447911123008");
    expect(row).toMatchObject({ status: "reported", attempts: 2 });
    expect(campaignCalls).toHaveLength(2);
    expect(campaignCalls[1].idempotencyKey).toBe(campaignCalls[0].idempotencyKey);
  });
});
