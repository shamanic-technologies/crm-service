import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { whatsappSends } from "../../src/db/schema.js";
import whatsappRoutes from "../../src/routes/whatsapp.js";

/**
 * POST /orgs/whatsapp/sends/query (WA-SENDS-BATCH-1014): one campaign's sends to
 * a list of people in one call, against a real database. runs-service is
 * stubbed at `fetch`.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "cacacaca-1111-4111-8111-000000000001";
const OTHER_ORG = "cacacaca-1111-4111-8111-000000000009";
const BRAND = "cacacaca-1111-4111-8111-000000000002";
const OTHER_BRAND = "cacacaca-1111-4111-8111-000000000003";
const CAMPAIGN = "cacacaca-1111-4111-8111-0000000000c1";
const OTHER_CAMPAIGN = "cacacaca-1111-4111-8111-0000000000c2";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": "user-q-1" };

let runCreates = 0;

function app() {
  const a = express();
  a.use(express.json());
  a.use(whatsappRoutes);
  return a;
}

async function wipe() {
  await db.delete(whatsappSends).where(inArray(whatsappSends.orgId, [ORG, OTHER_ORG]));
}

let seq = 0;
async function send(row: {
  email: string | null;
  status: "sending" | "sent" | "refused" | "failed";
  campaignId?: string | null;
  brandId?: string;
  orgId?: string;
  createdAt: string;
  code?: string;
}) {
  seq += 1;
  await db.insert(whatsappSends).values({
    orgId: row.orgId ?? ORG,
    brandId: row.brandId ?? BRAND,
    idempotencyKey: `q-${seq}`,
    email: row.email,
    phone: "+33600000001",
    text: "hi",
    status: row.status,
    errorCode: row.code ?? null,
    campaignId: row.campaignId === undefined ? CAMPAIGN : row.campaignId,
    sentAt: row.status === "sent" ? new Date(row.createdAt) : null,
    createdAt: new Date(row.createdAt),
  });
}

describe.skipIf(!RUN)("POST /orgs/whatsapp/sends/query (DB)", () => {
  beforeEach(async () => {
    await wipe();
    runCreates = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/runs")) {
        if ((init?.method ?? "GET") === "POST") runCreates += 1;
        return new Response(JSON.stringify({ id: "run-q" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url.toString()}`);
    });
  });
  afterAll(wipe);

  it("answers, for one campaign, which listed people it has a send for, every status, newest first, in ONE run", async () => {
    await send({ email: "ann@acme.com", status: "sent", createdAt: "2026-10-12T10:00:00Z" });
    await send({ email: "ann@acme.com", status: "refused", code: "send_in_progress", createdAt: "2026-10-13T10:00:00Z" });
    await send({ email: "bob@acme.com", status: "sending", createdAt: "2026-10-13T09:00:00Z" });
    await send({ email: "cat@acme.com", status: "failed", code: "bridge down", createdAt: "2026-10-11T09:00:00Z" });

    const res = await request(app())
      .post("/orgs/whatsapp/sends/query")
      .set(headers)
      .send({ brandId: BRAND, campaignId: CAMPAIGN, emails: ["ANN@acme.com", "bob@acme.com", "cat@acme.com", "dan@acme.com"] });

    expect(res.status).toBe(200);
    expect(runCreates).toBe(1);
    expect(res.body.invalidEmails).toEqual([]);
    expect(res.body.sends.map((s: { email: string; status: string }) => `${s.email}:${s.status}`)).toEqual([
      "ann@acme.com:refused",
      "bob@acme.com:sending",
      "ann@acme.com:sent",
      "cat@acme.com:failed",
    ]);
    const annSent = res.body.sends.find((s: { status: string }) => s.status === "sent");
    expect(annSent).toMatchObject({ campaignId: CAMPAIGN, code: null, sentAt: "2026-10-12T10:00:00.000Z" });
    expect(annSent.sendId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.sends.find((s: { email: string }) => s.email === "cat@acme.com")).toMatchObject({ sentAt: null, code: "bridge down" });
  });

  it("never names another campaign's, brand's or org's send, nor a send with no campaign", async () => {
    await send({ email: "ann@acme.com", status: "sent", campaignId: OTHER_CAMPAIGN, createdAt: "2026-10-12T10:00:00Z" });
    await send({ email: "ann@acme.com", status: "sent", campaignId: null, createdAt: "2026-10-12T10:00:00Z" });
    await send({ email: "ann@acme.com", status: "sent", brandId: OTHER_BRAND, createdAt: "2026-10-12T10:00:00Z" });
    await send({ email: "ann@acme.com", status: "sent", orgId: OTHER_ORG, createdAt: "2026-10-12T10:00:00Z" });

    const res = await request(app())
      .post("/orgs/whatsapp/sends/query")
      .set(headers)
      .send({ brandId: BRAND, campaignId: CAMPAIGN, emails: ["ann@acme.com"] });

    expect(res.status).toBe(200);
    expect(res.body.sends).toEqual([]);
  });

  it("names an entry that is not an email instead of dropping it", async () => {
    await send({ email: "ann@acme.com", status: "sent", createdAt: "2026-10-12T10:00:00Z" });
    const res = await request(app())
      .post("/orgs/whatsapp/sends/query")
      .set(headers)
      .send({ brandId: BRAND, campaignId: CAMPAIGN, emails: ["not-an-email", "ann@acme.com"] });
    expect(res.status).toBe(200);
    expect(res.body.invalidEmails).toEqual(["not-an-email"]);
    expect(res.body.sends).toHaveLength(1);
  });

  it("refuses a request without brand, campaign or emails, and more than 500 emails", async () => {
    const q = (body: unknown) => request(app()).post("/orgs/whatsapp/sends/query").set(headers).send(body as object);
    expect((await q({ campaignId: CAMPAIGN, emails: ["a@b.co"] })).status).toBe(400);
    expect((await q({ brandId: BRAND, emails: ["a@b.co"] })).status).toBe(400);
    expect((await q({ brandId: BRAND, campaignId: CAMPAIGN, emails: [] })).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => `p${i}@acme.com`);
    expect((await q({ brandId: BRAND, campaignId: CAMPAIGN, emails: many })).status).toBe(400);
  });

  it("requires the service key and an org", async () => {
    const body = { brandId: BRAND, campaignId: CAMPAIGN, emails: ["a@b.co"] };
    expect((await request(app()).post("/orgs/whatsapp/sends/query").send(body)).status).toBe(401);
    expect((await request(app()).post("/orgs/whatsapp/sends/query").set({ "x-api-key": API_KEY }).send(body)).status).toBe(400);
  });

  it("leaves the per-person read unchanged", async () => {
    await send({ email: "ann@acme.com", status: "sent", createdAt: "2026-10-12T10:00:00Z" });
    const res = await request(app()).get(`/orgs/whatsapp/messages?brandId=${BRAND}&email=ann@acme.com`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.sends).toHaveLength(1);
    expect(Object.keys(res.body.sends[0]).sort()).toEqual(
      ["campaignId", "code", "createdAt", "email", "error", "eventId", "fromAccount", "phoneSource", "sendId", "sentAt", "status", "text", "to"].sort(),
    );
  });
});

