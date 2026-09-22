import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { apiKeyAuth, requireOrg, requireOrgAndUser } from "../../src/middleware/auth.js";

/**
 * These tests assert what goes ON THE WIRE to runs-service, not what a mocked
 * run client was asked for. The prod bug (every body/path-param-scoped org route
 * 502-ing) was invisible to a suite that stubs the run client, because the stub
 * returns whatever shape its own author intended.
 *
 * The fake runs-service below therefore reproduces runs-service's real
 * create-run validation: `brandIds` is deprecated in favour of the x-brand-id
 * header and is min-1-WHEN-PRESENT, so an empty array is a 400.
 */
const ORG = "bbbbbbbb-1111-4111-8111-000000000001";
const BRAND = "bbbbbbbb-1111-4111-8111-000000000002";
const USER = "user-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

let created: Array<{ body: any; headers: Record<string, string> }> = [];
let updated: Array<{ path: string; status: string }> = [];
let runsDown = false;

function fakeRunsService() {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    if (runsDown) throw new Error("connect ECONNREFUSED");

    if (url.endsWith("/v1/runs") && init.method === "POST") {
      const body = JSON.parse(init.body);
      if ("brandIds" in body && (!Array.isArray(body.brandIds) || body.brandIds.length < 1)) {
        return new Response(
          JSON.stringify({
            error: "Invalid request",
            details: {
              formErrors: [],
              fieldErrors: { brandIds: ["Too small: expected array to have >=1 items"] },
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      created.push({ body, headers });
      return new Response(JSON.stringify({ id: "run-1", organizationId: ORG }), { status: 201 });
    }

    if (url.includes("/v1/runs/") && init.method === "PATCH") {
      updated.push({ path: url, status: JSON.parse(init.body).status });
      return new Response(JSON.stringify({ id: "run-1" }), { status: 200 });
    }

    throw new Error(`unexpected runs-service call: ${init.method} ${url}`);
  });
}

function appUnder(middleware: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post("/orgs/thing", apiKeyAuth, middleware, (_req, res) => res.json({ ok: true }));
  app.get("/orgs/thing", apiKeyAuth, middleware, (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  created = [];
  updated = [];
  runsDown = false;
  vi.stubGlobal("fetch", fakeRunsService());
});
afterEach(() => vi.unstubAllGlobals());

describe("run creation on a brand-less org request", () => {
  it("opens a run when the brand lives in the BODY (no x-brand-id header)", async () => {
    const res = await request(appUnder(requireOrg("gohighlevel-connect")))
      .post("/orgs/thing")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ brandId: BRAND, locationId: "loc-1" });

    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    // attributed from the body, since the gateway never promotes it to a header
    expect(created[0].body.brandIds).toEqual([BRAND]);
    expect(created[0].headers["x-brand-id"]).toBe(BRAND);
  });

  it("opens a run when NO brand is reachable at all (path-param route)", async () => {
    const res = await request(appUnder(requireOrg("gohighlevel-pause")))
      .post("/orgs/thing")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    // never `[]` — runs-service rejects an empty list, so the key is omitted
    expect("brandIds" in created[0].body).toBe(false);
    expect(created[0].headers["x-brand-id"]).toBeUndefined();
  });

  it("still prefers the x-brand-id header when the caller sends one", async () => {
    const other = "bbbbbbbb-1111-4111-8111-000000000009";
    const res = await request(appUnder(requireOrgAndUser("upload")))
      .post("/orgs/thing")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .set("x-brand-id", other)
      .send({ brandId: BRAND });

    expect(res.status).toBe(200);
    expect(created[0].body.brandIds).toEqual([other]);
  });

  it("attributes from a query param too", async () => {
    const res = await request(appUnder(requireOrg("serve-stats")))
      .get(`/orgs/thing?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(created[0].body.brandIds).toEqual([BRAND]);
  });

  it("ignores a non-uuid brandId rather than sending garbage", async () => {
    const res = await request(appUnder(requireOrg("thing")))
      .post("/orgs/thing")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ brandId: "not-a-uuid" });

    expect(res.status).toBe(200);
    expect("brandIds" in created[0].body).toBe(false);
  });

  it("closes the run when the response finishes", async () => {
    await request(appUnder(requireOrg("thing")))
      .post("/orgs/thing")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ brandId: BRAND });

    await new Promise((r) => setTimeout(r, 10));
    expect(updated).toEqual([{ path: expect.stringContaining("/v1/runs/run-1"), status: "completed" }]);
  });

  it("still fails LOUD (502) on a genuine runs-service outage", async () => {
    runsDown = true;
    const res = await request(appUnder(requireOrg("thing")))
      .post("/orgs/thing")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .send({ brandId: BRAND });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/run tracking unavailable/);
  });
});
