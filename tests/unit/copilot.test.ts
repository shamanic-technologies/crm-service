import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { copilotPresences, isCopilotDestination } from "../../src/lib/copilot/messages.js";
import copilotRoutes from "../../src/routes/copilot.js";
import type { CopilotMessage } from "../../src/db/schema.js";

const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const STAFF_ORG = "c0c0c0c0-1111-4111-8111-000000000001";
const BRAND = "c0c0c0c0-1111-4111-8111-000000000002";

const row = (over: Partial<CopilotMessage>): CopilotMessage => ({
  id: "r",
  orgId: STAFF_ORG,
  brandId: BRAND,
  chatOrgId: "c0c0c0c0-1111-4111-8111-000000000004",
  chatUserId: "c0c0c0c0-1111-4111-8111-000000000005",
  email: "jane@prospect.io",
  displayName: null,
  sessionId: "s1",
  messageId: "m",
  role: "user",
  text: "hi",
  sentAt: new Date("2026-10-11T10:00:00Z"),
  receivedAt: new Date(),
  runId: null,
  ...over,
});

describe("copilot destination", () => {
  afterEach(() => {
    delete process.env.COPILOT_UNIBOX_ORG_ID;
    delete process.env.COPILOT_UNIBOX_BRAND_ID;
  });
  it("is the staff org AND brand, never the brand id alone", () => {
    process.env.COPILOT_UNIBOX_ORG_ID = STAFF_ORG;
    process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
    expect(isCopilotDestination(STAFF_ORG, BRAND)).toBe(true);
    expect(isCopilotDestination("c0c0c0c0-1111-4111-8111-000000000009", BRAND)).toBe(false);
  });
  it("is nobody when unset", () => {
    expect(isCopilotDestination(STAFF_ORG, BRAND)).toBe(false);
  });
});

describe("copilotPresences", () => {
  it("one presence per address: counts, dates, latest name", () => {
    const [p] = copilotPresences([
      row({ id: "a", messageId: "1", role: "user", displayName: "Jane", sentAt: new Date("2026-10-11T10:00:00Z") }),
      row({ id: "b", messageId: "2", role: "assistant", sentAt: new Date("2026-10-11T10:00:05Z") }),
      row({ id: "c", messageId: "3", role: "user", sessionId: "s2", displayName: "Jane Doe", sentAt: new Date("2026-10-12T09:00:00Z") }),
    ]);
    expect(p).toMatchObject({
      source: "copilot",
      sourceRef: "jane@prospect.io",
      emails: ["jane@prospect.io"],
      displayName: "Jane Doe",
      firstActivityAt: "2026-10-11T10:00:00.000Z",
      lastActivityAt: "2026-10-12T09:00:00.000Z",
      messageCount: 3,
      inboundCount: 2,
      outboundCount: 1,
    });
    expect(p.detail.sessions).toBe(2);
  });
});

describe("POST /internal/copilot/messages", () => {
  const app = express();
  app.use(express.json());
  app.use(copilotRoutes);
  const fetchSpy = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchSpy));
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COPILOT_UNIBOX_ORG_ID;
    delete process.env.COPILOT_UNIBOX_BRAND_ID;
  });
  const body = {
    orgId: "c0c0c0c0-1111-4111-8111-000000000004",
    userId: "c0c0c0c0-1111-4111-8111-000000000005",
    email: "jane@prospect.io",
    sessionId: "s1",
    messages: [{ messageId: "m1", role: "user", text: "hi", at: "2026-10-11T10:00:00Z" }],
  };

  it("401 without the service key", async () => {
    expect((await request(app).post("/internal/copilot/messages").send(body)).status).toBe(401);
  });
  it("400 on a malformed body (no messages, bad role), before any run", async () => {
    const res = await request(app).post("/internal/copilot/messages").set("x-api-key", API_KEY).send({ ...body, messages: [{ ...body.messages[0], role: "system" }] });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("503 when the staff scope is not configured: nothing filed anywhere", async () => {
    const res = await request(app).post("/internal/copilot/messages").set("x-api-key", API_KEY).send(body);
    expect(res.status).toBe(503);
    expect(res.body.type).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
