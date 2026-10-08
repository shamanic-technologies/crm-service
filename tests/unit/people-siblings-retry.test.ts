import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConnectError, siblingGet, siblingGetOk, SIBLING_CONNECT_RETRY_DELAYS_MS } from "../../src/lib/people/siblings.js";

const identity = { orgId: "o", userId: "u", runId: "r", brandId: "b" };

/** What undici throws when the port refuses: `TypeError: fetch failed` with the code on `cause`. */
const refused = () =>
  new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8080"), { code: "ECONNREFUSED" }) });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("sibling reads survive a sibling's deploy window", () => {
  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "f";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a refused-then-accepted read returns the answer", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    const p = siblingGetOk("features", "/x", identity);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a sibling that stays down fails loud once the budget is spent", async () => {
    const fetchMock = vi.fn().mockRejectedValue(refused());
    vi.stubGlobal("fetch", fetchMock);
    const p = siblingGet("features", "/x", identity);
    const assertion = expect(p).rejects.toThrow(
      `features-service GET /x unreachable (after ${SIBLING_CONNECT_RETRY_DELAYS_MS.length + 1} attempts): fetch failed`,
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(SIBLING_CONNECT_RETRY_DELAYS_MS.length + 1);
  });

  it("an answered 5xx is never retried", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(siblingGetOk("features", "/x", identity)).rejects.toThrow("returned 502");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("our own timeout (abort) is never retried", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal("fetch", fetchMock);
    await expect(siblingGet("features", "/x", identity)).rejects.toThrow(/unreachable: timed out after/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("isConnectError", () => {
  it("finds the code on cause and inside an AggregateError; rejects everything else", () => {
    expect(isConnectError(refused())).toBe(true);
    const agg = new TypeError("fetch failed", {
      cause: new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]),
    });
    expect(isConnectError(agg)).toBe(true);
    expect(isConnectError(new TypeError("fetch failed", { cause: Object.assign(new Error("r"), { code: "ECONNRESET" }) }))).toBe(true);
    expect(isConnectError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isConnectError(new TypeError("fetch failed", { cause: Object.assign(new Error("d"), { code: "ENOTFOUND" }) }))).toBe(false);
    expect(isConnectError(new Error("plain"))).toBe(false);
  });
});
