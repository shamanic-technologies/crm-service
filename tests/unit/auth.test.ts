import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { apiKeyAuth } from "../../src/middleware/auth.js";

function appWithProtectedRoute() {
  const app = express();
  app.get("/public/ping", apiKeyAuth, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("apiKeyAuth", () => {
  it("rejects a request without x-api-key", async () => {
    const res = await request(appWithProtectedRoute()).get("/public/ping");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    const res = await request(appWithProtectedRoute())
      .get("/public/ping")
      .set("x-api-key", "wrong");
    expect(res.status).toBe(401);
  });

  it("accepts the correct key", async () => {
    const res = await request(appWithProtectedRoute())
      .get("/public/ping")
      .set("x-api-key", process.env.CRM_SERVICE_API_KEY!);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
