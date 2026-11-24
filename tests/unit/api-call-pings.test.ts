import { describe, it, expect } from "vitest";
import { composeCallText, composeGroupedText, GROUPED_TEXT_MAX, type CallLine } from "../../src/lib/api-calls/ping-text.js";
import { planSend, telegramRetryAfterSeconds } from "../../src/lib/api-calls/ping-text.js";
import { describeRequest } from "../../src/lib/api-calls/calls.js";

const base = (over: Partial<CallLine> = {}): CallLine => ({
  callId: "c1",
  channel: "api",
  email: "jane@prospect.io",
  name: "Jane Doe",
  orgName: "Prospect Inc",
  noAccount: false,
  mcpTool: null,
  did: "Listed emails for brand AscendQE",
  status: 200,
  result: "Answered: 3 emails (200, 120 ms)",
  at: new Date("2026-11-24T10:00:05Z"),
  ...over,
});

describe("one call, one line: who, what, result", () => {
  it("an API call", () => {
    expect(composeCallText(base(), "https://dashboard.distribute.you/x")).toBe(
      [
        "API call · Jane Doe (jane@prospect.io) · Prospect Inc",
        "Did: Listed emails for brand AscendQE",
        "Result: ✅ Answered: 3 emails (200, 120 ms)",
        "Thread: https://dashboard.distribute.you/x",
      ].join("\n"),
    );
  });

  it("an MCP call names the tool; an error says its status", () => {
    const text = composeCallText(
      base({ channel: "mcp", mcpTool: "distribute_list_emails", status: 403, result: "Refused (403): Not a member of this organization" }),
      null,
    );
    expect(text).toBe(
      [
        "MCP call · Jane Doe (jane@prospect.io) · Prospect Inc",
        "Did: tool distribute_list_emails · Listed emails for brand AscendQE",
        "Result: ❌ Refused (403): Not a member of this organization",
      ].join("\n"),
    );
  });

  it("an agent signing up (no account yet) is named by the address it typed", () => {
    const did = describeRequest({ method: "POST", path: "/v1/agent-signups/start", brandIds: [], mcpTool: null });
    expect(did).toBe("Agent signup: asked for a sign-in code by email");
    const text = composeCallText(base({ name: null, orgName: null, noAccount: true, did }), null);
    expect(text.split("\n")[0]).toBe("API call · jane@prospect.io · no account yet");
    expect(describeRequest({ method: "GET", path: "/v1/agent-signups/approve", brandIds: [], mcpTool: null })).toBe("Agent signup: opened the approve link");
  });

  it("never an em or en dash", () => {
    expect(composeCallText(base({ did: "a — b – c" }), null)).not.toMatch(/[—–]/);
  });
});

describe("a burst: one grouped message, every call accounted for", () => {
  const burst = (n: number, people = 1) =>
    Array.from({ length: n }, (_, i) =>
      base({ callId: `c${i}`, email: `p${i % people}@prospect.io`, name: null, at: new Date(Date.UTC(2026, 10, 24, 10, 0, i % 60)), status: i % 10 === 0 ? 500 : 200 }),
    );

  it("50 calls of one person: listed one by one in ONE message", () => {
    const { text, mode } = composeGroupedText(burst(50), new Map(), 6);
    expect(mode).toBe("grouped");
    expect(text.length).toBeLessThanOrEqual(GROUPED_TEXT_MAX);
    expect(text.split("\n")[0]).toMatch(/^50 API \/ MCP calls by 1 person at 10:00 UTC, grouped/);
    expect(text).toContain("p0@prospect.io · Prospect Inc: 50 calls");
    expect(text.split("\n").filter((l) => /^10:00:\d\d API /.test(l))).toHaveLength(50);
    expect(text).toContain("❌ 500");
  });

  it("too many to list: a per-person summary, the people that do not fit are counted", () => {
    const { text, mode } = composeGroupedText(burst(1000, 200), new Map(), 6);
    expect(mode).toBe("summary");
    expect(text.length).toBeLessThanOrEqual(GROUPED_TEXT_MAX + 100);
    expect(text.split("\n")[0]).toMatch(/^1000 API \/ MCP calls by 200 people/);
    const named = [...text.matchAll(/: (\d+) calls\n/g)].reduce((n, m) => n + Number(m[1]), 0);
    const rest = /\+(\d+) more people, (\d+) calls/.exec(text);
    expect(rest).not.toBeNull();
    expect(named + Number(rest![2])).toBe(1000);
  });
});

describe("the budget", () => {
  it("lines while a slot stays free for a catch-up, else one grouped message, nothing when spent", () => {
    expect(planSend(0, 6)).toBe("none");
    expect(planSend(1, 6)).toBe("lines");
    expect(planSend(5, 6)).toBe("lines");
    expect(planSend(6, 6)).toBe("grouped");
    expect(planSend(50, 6)).toBe("grouped");
    expect(planSend(1, 1)).toBe("lines");
    expect(planSend(2, 1)).toBe("grouped");
    expect(planSend(3, 0)).toBe("none");
  });

  it("reads Telegram's retry after", () => {
    expect(telegramRetryAfterSeconds("Telegram refused 429: Too Many Requests: retry after 17")).toBe(17);
    expect(telegramRetryAfterSeconds("Telegram refused 502: Bad Gateway")).toBeNull();
  });
});
