import { describe, it, expect } from "vitest";
import {
  apiCallPresences,
  describeRequest,
  describeResponse,
  isIdSegment,
  sessionsOf,
  SESSION_GAP_MS,
} from "../../src/lib/api-calls/calls.js";

const BRAND = "8a1c3e3e-1111-4111-8111-000000000001";

const req = (method: string, path: string, brandIds: string[] = [], mcpTool: string | null = null) => ({ method, path, brandIds, mcpTool });
const resp = (status: number, body: unknown, extra: Partial<{ responseBodyTruncated: boolean; responseBodyBytes: number }> = {}) => ({
  status,
  responseBody: body === null ? null : typeof body === "string" ? body : JSON.stringify(body),
  responseBodyBytes: extra.responseBodyBytes ?? 100,
  responseBodyTruncated: extra.responseBodyTruncated ?? false,
  durationMs: 42,
});

describe("api calls: what the client asked, in plain words", () => {
  it("names the brand when its name is known", () => {
    expect(describeRequest(req("GET", "/v1/emails", [BRAND]), new Map([[BRAND, "AscendQE"]]))).toBe("Listed emails for brand AscendQE");
    expect(describeRequest(req("GET", "/v1/emails", [BRAND]))).toBe("Listed emails for brand 8a1c3e3e");
  });

  it("reads the shape of the path", () => {
    expect(describeRequest(req("GET", "/v1/me"))).toBe("Asked who they are and what they can reach");
    expect(describeRequest(req("GET", `/v1/brands/${BRAND}`))).toBe("Read brand 8a1c3e3e");
    expect(describeRequest(req("GET", `/v1/brands/${BRAND}/campaigns`))).toBe("Read the campaigns of brand");
    expect(describeRequest(req("POST", "/v1/campaigns"))).toBe("Created campaign");
    expect(describeRequest(req("POST", `/v1/brands/${BRAND}/pause`))).toBe("Asked to pause brand");
    expect(describeRequest(req("PATCH", `/v1/campaigns/${BRAND}`))).toBe("Updated campaign 8a1c3e3e");
    expect(describeRequest(req("DELETE", `/v1/api-keys/${BRAND}`))).toBe("Deleted api key 8a1c3e3e");
    expect(describeRequest(req("GET", "/v1/public/features/showcase-funnels"))).toBe("Listed showcase funnels");
  });

  it("tells ids from words", () => {
    expect(isIdSegment(BRAND)).toBe(true);
    expect(isIdSegment("12345")).toBe(true);
    expect(isIdSegment("sales-cold-email-outreach")).toBe(false);
    expect(isIdSegment("emails")).toBe(false);
  });
});

describe("api calls: what we answered, in plain words", () => {
  it("counts a list, or the one list an object holds", () => {
    expect(describeResponse(resp(200, { emails: [1, 2, 3] }))).toBe("Answered: 3 emails (200, 42 ms)");
    expect(describeResponse(resp(200, [1]))).toBe("Answered: 1 item (200, 42 ms)");
    expect(describeResponse(resp(200, { id: "x", name: "y" }))).toBe("Answered (200, 42 ms)");
  });

  it("says why a call was refused or failed", () => {
    expect(describeResponse(resp(403, { error: "Not a member", message: "This key's user is not a member of organization X." }))).toBe(
      "Refused (403): This key's user is not a member of organization X.",
    );
    expect(describeResponse(resp(502, { error: "upstream down" }))).toBe("Failed (502): upstream down");
  });

  it("says when the answer was cut", () => {
    expect(describeResponse(resp(200, '{"emails":[1,2', { responseBodyTruncated: true, responseBodyBytes: 1_048_576 }))).toBe(
      "Answered (200, 42 ms, answer kept up to 256 KB of 1024 KB)",
    );
  });
});

describe("api calls: sessions and presences", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 12, 10, 0) + min * 60_000);

  it("a pause over 30 min starts a new session, per channel", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60_000);
    const s = sessionsOf([
      { callId: "a", channel: "api", calledAt: at(0) },
      { callId: "b", channel: "mcp", calledAt: at(1) },
      { callId: "c", channel: "api", calledAt: at(20) },
      { callId: "d", channel: "mcp", calledAt: at(50) },
      { callId: "e", channel: "api", calledAt: at(55) },
    ]);
    expect(Object.fromEntries(s)).toEqual({ a: "a", b: "b", c: "a", d: "d", e: "e" });
  });

  it("one presence per caller, two messages per call", () => {
    const rows = [
      { id: "1", email: "ada@acme.com", displayName: null, calledAt: at(0), channel: "api", callerOrgId: "o1", callerUserId: "u1" },
      { id: "2", email: "ada@acme.com", displayName: "Ada", calledAt: at(5), channel: "mcp", callerOrgId: null, callerUserId: "u1" },
    ];
    const [p] = apiCallPresences(rows);
    expect(p).toMatchObject({
      source: "api",
      sourceRef: "ada@acme.com",
      displayName: "Ada",
      emails: ["ada@acme.com"],
      messageCount: 4,
      inboundCount: 2,
      outboundCount: 2,
      detail: { channel: "api", channels: ["api", "mcp"], calls: 2, callerOrgIds: ["o1"], callerUserIds: ["u1"] },
    });
  });
});
