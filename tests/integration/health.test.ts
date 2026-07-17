import { describe, it, expect } from "vitest";
import request from "supertest";
import { createHealthApp } from "../helpers/test-app.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(createHealthApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "crm-service" });
  });
});
