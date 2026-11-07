/**
 * POSTHOG-429-1107, pure parts: when PostHog says reads come back, the in-process gate (no fetch before then), the
 * bytes ledger, who is KNOWN without the persons filter, what the client reads, and Monitoring's verdict.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesReadLastHour,
  hogql,
  isKnownPerson,
  PosthogThrottled,
  resetPosthogBudgetState,
  retryAtOf,
  throttledUntil,
} from "../../src/lib/posthog/client.js";
import { posthogSyncState } from "../../src/lib/posthog/sync.js";
import { assessIntake } from "../../src/lib/connector-intake-core.js";

const target = { region: "eu" as const, projectId: "171095", apiKey: "phx" };
const NOW = Date.parse("2026-11-07T06:00:00Z");
const MESSAGE =
  "This project used its hourly budget of data read by API queries. To stay under it, read less data per query or run queries less often. See https://posthog.com/docs/sql/optimizing-queries for ways to read less. Expected available in 160 seconds.";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPosthogBudgetState();
});

describe("retryAtOf", () => {
  it("PostHog's Retry-After header wins, then its own words, else one minute", () => {
    expect(retryAtOf("60", MESSAGE, NOW).toISOString()).toBe("2026-11-07T06:01:00.000Z");
    expect(retryAtOf(null, MESSAGE, NOW).toISOString()).toBe("2026-11-07T06:02:40.000Z");
    expect(retryAtOf(null, "slow down", NOW).toISOString()).toBe("2026-11-07T06:01:00.000Z");
  });
});

describe("hogql: a 429 closes the gate, no fetch before PostHog said", () => {
  it("throws PosthogThrottled with retryAt, and the next read throws without calling PostHog", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ type: "throttled_error", code: "api_queries_budget_exceeded", detail: MESSAGE }), {
        status: 429,
        headers: { "retry-after": "120" },
      });
    });
    const t0 = Date.now();
    const err = await hogql(target, "SELECT 1").catch((e) => e);
    expect(err).toBeInstanceOf(PosthogThrottled);
    expect(err.status).toBe(429);
    expect(err.vendorMessage).toContain("hourly budget");
    expect(err.retryAt.getTime()).toBeGreaterThanOrEqual(t0 + 120_000);
    expect(throttledUntil(target)).toEqual(err.retryAt);
    await expect(hogql(target, "SELECT 1")).rejects.toBeInstanceOf(PosthogThrottled);
    expect(calls).toBe(1);
    // Another project is not held.
    expect(throttledUntil({ region: "eu", projectId: "999" })).toBeNull();
  });
  it("records the bytes PostHog reports for each read, over the last hour", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ columns: ["n"], results: [[1]] }), {
        status: 200,
        headers: { "x-posthog-query-bytes-read": "2836018" },
      }),
    );
    await hogql(target, "SELECT 1");
    await hogql(target, "SELECT 1");
    expect(bytesReadLastHour(target)).toBe(2 * 2836018);
    expect(bytesReadLastHour(target, Date.now() + 61 * 60_000)).toBe(0);
  });
});

describe("isKnownPerson (the IDENTIFIED rule, applied in code)", () => {
  it("identified, or an email / phone / name / website; nothing = anonymous", () => {
    expect(isKnownPerson({ is_identified: 1 })).toBe(true);
    expect(isKnownPerson({ is_identified: 0, email: "a@b.c" })).toBe(true);
    expect(isKnownPerson({ prop_phone_number: "+33612345678" })).toBe(true);
    expect(isKnownPerson({ first_name: "Ana" })).toBe(true);
    expect(isKnownPerson({ prop_website: "acme.io" })).toBe(true);
    expect(isKnownPerson({ is_identified: 0, email: "", name: null, prop_website: "  " })).toBe(false);
  });
});

describe("posthogSyncState: a wait is catching up, never a failure", () => {
  const base = {
    status: "active",
    lastError: null,
    lastSyncedAt: new Date("2026-11-02T16:32:24Z"),
    syncedThrough: new Date("2026-11-02T16:32:03Z"),
    rateLimitedUntil: null as Date | null,
    rateLimitedSince: null as Date | null,
    rateLimitMessage: null as string | null,
  };
  it("waiting for PostHog's read budget", () => {
    const s = posthogSyncState(
      { ...base, rateLimitedUntil: new Date(NOW + 160_000), rateLimitedSince: new Date("2026-11-02T16:39:00Z"), rateLimitMessage: MESSAGE },
      12,
      NOW,
    );
    expect(s).toEqual({
      state: "catching_up",
      reason: "posthog_read_budget",
      retryAt: "2026-11-07T06:02:40.000Z",
      waitingSince: "2026-11-02T16:39:00.000Z",
      behindSince: "2026-11-02T16:32:03.000Z",
      historyBacklog: 12,
      message: MESSAGE,
    });
  });
  it("a real failure, history still reading, up to date, paused, first sync", () => {
    expect(posthogSyncState({ ...base, status: "error", lastError: "401: invalid key" }, 0, NOW)).toMatchObject({ state: "failed", message: "401: invalid key" });
    expect(posthogSyncState(base, 5, NOW)).toMatchObject({ state: "catching_up", reason: "reading_history", retryAt: null });
    expect(posthogSyncState(base, 0, NOW)).toMatchObject({ state: "up_to_date", reason: null });
    expect(posthogSyncState({ ...base, status: "paused" }, 0, NOW).state).toBe("paused");
    expect(posthogSyncState({ ...base, lastSyncedAt: null }, null, NOW).state).toBe("first_sync");
  });
});

describe("Monitoring > Connectors: red while broken, normal while just waiting", () => {
  const days = Array.from({ length: 60 }, (_, i) => new Date(NOW - i * 86_400_000).toISOString().slice(0, 10));
  it("a wait with a fresh last sync is ok, and says it waits", () => {
    const a = assessIntake({
      activeDays: days,
      syncStatus: "active",
      lastSyncedAt: new Date(NOW - 20 * 60_000),
      lastError: null,
      now: NOW,
      waitingSince: new Date(NOW - 5 * 60_000),
      waitingUntil: new Date(NOW + 160_000),
    });
    expect(a.status).toBe("ok");
    expect(a.waiting).toEqual({ until: "2026-11-07T06:02:40.000Z", since: "2026-11-07T05:55:00.000Z" });
  });
  it("a wait that left the mirror 5 days behind is red (the gap is real), saying why", () => {
    const a = assessIntake({
      activeDays: days,
      syncStatus: "active",
      lastSyncedAt: new Date("2026-11-02T16:32:24Z"),
      lastError: null,
      now: NOW,
      waitingSince: new Date("2026-11-02T16:39:00Z"),
      waitingUntil: new Date(NOW + 160_000),
    });
    expect(a.status).toBe("red");
    expect(a.reasons.map((r) => r.code)).toEqual(["sync_late"]);
    expect(a.reasons[0].text).toContain("read limit");
    expect(a.reasons[0].text).toContain("2026-11-07T06:02:40.000Z");
  });
  it("no wait = waiting null (every other connector)", () => {
    expect(assessIntake({ activeDays: days, syncStatus: "active", lastSyncedAt: new Date(NOW), lastError: null, now: NOW }).waiting).toBeNull();
  });
});
