import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { TRANSFER_TABLES } from "../../src/lib/transfer-brand.js";
import internalRoutes from "../../src/routes/internal.js";

const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

describe("transfer-brand table coverage", () => {
  it("moves EVERY table carrying brand_id (a new brand-scoped table must be added)", () => {
    const brandScoped = Object.values(schema)
      .filter((v): v is PgTable => is(v, PgTable))
      .filter((t) => getTableConfig(t).columns.some((c) => c.name === "brand_id"))
      .map((t) => getTableConfig(t).name)
      .sort();
    const covered = TRANSFER_TABLES.map((t) => getTableConfig(t).name).sort();
    expect(brandScoped.length).toBeGreaterThanOrEqual(16);
    expect(covered).toEqual(brandScoped);
  });

  it("every moved table carries org_id too", () => {
    for (const t of TRANSFER_TABLES) {
      expect(getTableConfig(t).columns.map((c) => c.name)).toContain("org_id");
    }
  });
});

describe("POST /internal/transfer-brand validation", () => {
  const app = express();
  app.use(express.json());
  app.use(internalRoutes);
  const fetchSpy = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchSpy));
  afterEach(() => vi.unstubAllGlobals());

  it("401 without the service key", async () => {
    const res = await request(app).post("/internal/transfer-brand").send({});
    expect(res.status).toBe(401);
  });

  it("400 on a malformed body, before any run is opened", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
