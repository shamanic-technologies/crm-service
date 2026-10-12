import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, contactServes, people, peopleScopes } from "../../src/db/schema.js";
import contactRoutes from "../../src/routes/contacts.js";
import { serveNextPeople } from "../../src/lib/serve.js";

/**
 * POST /orgs/contacts/still-fits against a real Postgres (gated on CRM_TEST_DB):
 * one person judged against the SAME pool rule serve-next applies, today.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "5f5f5f5f-1111-4111-8111-000000000001";
const BRAND = "5f5f5f5f-1111-4111-8111-000000000002";
const UPLOAD_A = "5f5f5f5f-1111-4111-8111-00000000000a";
const UPLOAD_B = "5f5f5f5f-1111-4111-8111-00000000000b";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const POOL = { signedUp: true, replied: false, reachableBy: "phone" as const };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubRuns() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(contactRoutes);
  return a;
}
const ask = (body: unknown) =>
  request(app()).post("/orgs/contacts/still-fits").set("x-api-key", API_KEY).set("x-org-id", ORG).send(body);

interface Seeded {
  name: string;
  presences: Record<string, unknown>[];
  phones?: string[];
}

const clerk = { source: "clerk", sourceRef: "u", emails: [], phones: [], detail: {} };
const PEOPLE: Seeded[] = [
  // Signed up, never answered, has a phone: in the pool.
  { name: "quiet", presences: [clerk, { source: "gmail", sourceRef: "g", emails: [], phones: [], inboundCount: 0, outboundCount: 2, detail: {} }], phones: ["+33600000001"] },
  // Signed up, then a WhatsApp thread merged in: wrote 10 messages.
  {
    name: "talker",
    presences: [clerk, { source: "matrix", sourceRef: "m", emails: [], phones: [], inboundCount: 10, outboundCount: 44, detail: { channel: "whatsapp" } }],
    phones: ["+33600000002"],
  },
  // Never signed up, no phone, answered by email.
  { name: "stranger", presences: [{ source: "gmail", sourceRef: "g2", emails: [], phones: [], inboundCount: 1, outboundCount: 1, detail: {} }] },
];
const email = (n: string) => `${n}@fits.test`;

async function seed() {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "u", status: "built" }).returning();
  for (const p of PEOPLE) {
    await db.insert(people).values({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personKey: `email:${email(p.name)}`,
      identityKeys: [`email:${email(p.name)}`],
      displayName: p.name,
      emails: [email(p.name)],
      phones: p.phones ?? [],
      sources: p.presences.map((x) => x.source as string),
      presences: p.presences as never,
      mergeEvidence: [],
      state: "in_conversation",
      stateSource: "none",
    });
  }
  const csv = (primaryEmail: string, over: Record<string, unknown> = {}) => ({
    orgId: ORG,
    brandId: BRAND,
    primaryEmail,
    rawAttributes: {},
    sourceUploadId: UPLOAD_A,
    sourceRowId: sql`gen_random_uuid()` as unknown as string,
    ...over,
  });
  await db.insert(contacts).values([csv("csv-ok@fits.test"), csv("csv-unsub@fits.test", { unsubscribed: true })]);
}

describe.skipIf(!RUN)("POST /orgs/contacts/still-fits", () => {
  const wipe = async () => {
    await db.delete(contactServes).where(eq(contactServes.brandId, BRAND));
    await db.delete(contacts).where(eq(contacts.brandId, BRAND));
    await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  };
  beforeEach(async () => {
    stubRuns();
    await wipe();
    await seed();
  });
  afterAll(wipe);

  it("a person still in the pool fits, even once served (the question marks nobody)", async () => {
    const served = await serveNextPeople(ORG, BRAND, 10, "run-1", POOL);
    expect(served.contacts.map((c) => c.primaryEmail)).toEqual([email("quiet")]);
    const r = await ask({ brandId: BRAND, email: email("QUIET"), people: POOL });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fits: true, pool: "people" });
    const serves = await db.select().from(contactServes).where(eq(contactServes.brandId, BRAND));
    expect(serves).toHaveLength(1);
  });

  it("a person who wrote on WhatsApp no longer fits 'never answered', named by channel", async () => {
    const r = await ask({ brandId: BRAND, email: email("talker"), people: POOL });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      fits: false,
      pool: "people",
      reason: "Has written to the brand on WhatsApp",
      failed: [{ code: "replied", reason: "Has written to the brand on WhatsApp" }],
    });
  });

  it("every failed rule is listed", async () => {
    const r = await ask({ brandId: BRAND, email: email("stranger"), people: POOL });
    expect(r.body.fits).toBe(false);
    expect(r.body.failed.map((f: { code: string }) => f.code)).toEqual(["signed_up", "replied", "no_phone"]);
    expect(r.body.reason).toBe("Not signed up to the product; Has written to the brand on email; Holds no phone number");
  });

  it("asking writes nothing: the same pool still serves the person after", async () => {
    await ask({ brandId: BRAND, email: email("quiet"), people: POOL });
    const served = await serveNextPeople(ORG, BRAND, 10, "run-2", POOL);
    expect(served.contacts).toHaveLength(1);
  });

  it("unknown address = 404, never a silent fits", async () => {
    const r = await ask({ brandId: BRAND, email: "nobody@fits.test", people: POOL });
    expect(r.status).toBe(404);
    expect(r.body.type).toBe("person_not_found");
  });

  it("CSV pool: sendable contact fits, opted-out does not, a file binding is honoured", async () => {
    expect((await ask({ brandId: BRAND, email: "csv-ok@fits.test" })).body).toEqual({ fits: true, pool: "csv" });
    expect((await ask({ brandId: BRAND, email: "csv-ok@fits.test", uploadIds: [UPLOAD_A] })).body).toEqual({ fits: true, pool: "csv" });
    const moved = await ask({ brandId: BRAND, email: "csv-ok@fits.test", uploadIds: [UPLOAD_B] });
    expect(moved.body).toMatchObject({ fits: false, failed: [{ code: "not_in_file" }] });
    const unsub = await ask({ brandId: BRAND, email: "csv-unsub@fits.test" });
    expect(unsub.body).toMatchObject({ fits: false, reason: "Marked do not contact in the brand's CRM" });
    expect((await ask({ brandId: BRAND, email: "nobody@fits.test" })).status).toBe(404);
  });

  it("400 on a bad body", async () => {
    expect((await ask({ brandId: BRAND })).status).toBe(400);
    expect((await ask({ brandId: BRAND, email: "a@b.c", people: {}, uploadIds: [UPLOAD_A] })).status).toBe(400);
  });
});
