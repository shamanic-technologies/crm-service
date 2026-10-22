import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { DrizzleQueryError } from "drizzle-orm";

vi.mock("../../src/lib/runs-client.js", () => ({
  createPlatformRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updatePlatformRun: vi.fn().mockResolvedValue(undefined),
}));
const transferBrand = vi.fn();
vi.mock("../../src/lib/transfer-brand.js", () => ({ transferBrand: (...a: unknown[]) => transferBrand(...a) }));

const { default: internalRoutes } = await import("../../src/routes/internal.js");
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const BODY = {
  sourceBrandId: "cccccccc-1111-4111-8111-000000000003",
  sourceOrgId: "cccccccc-1111-4111-8111-000000000001",
  targetOrgId: "cccccccc-1111-4111-8111-000000000002",
};

function app() {
  const a = express();
  a.use(express.json());
  a.use(internalRoutes);
  return a;
}

describe("POST /internal/transfer-brand unique conflict (drizzle-orm >= 0.44 wraps driver errors)", () => {
  it("409s with the postgres message when drizzle wraps the unique violation", async () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "contacts_org_brand_email"'), {
      code: "23505",
      constraint_name: "contacts_org_brand_email",
    });
    transferBrand.mockRejectedValueOnce(new DrizzleQueryError("update contacts set ...", ["secret-param"], pg));
    const res = await request(app()).post("/internal/transfer-brand").set("x-api-key", API_KEY).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe("conflict");
    expect(res.body.error).toBe(
      'target already holds conflicting CRM data, nothing was moved: duplicate key value violates unique constraint "contacts_org_brand_email"',
    );
  });

  it("500s any other failure", async () => {
    transferBrand.mockRejectedValueOnce(new Error("boom"));
    const res = await request(app()).post("/internal/transfer-brand").set("x-api-key", API_KEY).send(BODY);
    expect(res.status).toBe(500);
  });
});
