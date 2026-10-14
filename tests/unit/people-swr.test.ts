import { describe, it, expect } from "vitest";
import { SwrCache } from "../../src/lib/people/swr.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("SwrCache (DASH-LATENCY-1014)", () => {
  it("fresh: served as is, the load runs once even for concurrent callers", async () => {
    let loads = 0;
    const c = new SwrCache<number>("t", () => 60_000, () => 120_000);
    const load = async () => {
      loads++;
      await tick();
      return loads;
    };
    const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    expect(await c.get("k", load)).toBe(1);
    expect(loads).toBe(1);
  });

  it("stale: the old value is served at once and ONE background refresh replaces it", async () => {
    let loads = 0;
    let fresh = 60_000;
    const c = new SwrCache<number>("t", () => fresh, () => 120_000);
    const load = async () => {
      loads++;
      await tick(20);
      return loads;
    };
    expect(await c.get("k", load)).toBe(1);
    fresh = 0;
    expect(await c.get("k", load)).toBe(1); // stale, served
    expect(await c.get("k", load)).toBe(1); // same refresh still running, no second one
    await tick(40);
    fresh = 60_000;
    expect(await c.get("k", load)).toBe(2);
    expect(loads).toBe(2);
  });

  it("past max stale the caller waits; a failed load is never cached and the error reaches the caller", async () => {
    let fail = true;
    const c = new SwrCache<string>("t", () => 0, () => 0);
    const load = async () => {
      if (fail) throw new Error("down");
      return "ok";
    };
    await expect(c.get("k", load)).rejects.toThrow("down");
    fail = false;
    expect(await c.get("k", load)).toBe("ok");
  });

  it("the loader sees the previous entry (to reuse it when its inputs did not move)", async () => {
    const c = new SwrCache<number>("t", () => 0, () => 0);
    expect(await c.get("k", async (prev) => (prev?.value ?? 0) + 1)).toBe(1);
    expect(await c.get("k", async (prev) => (prev?.value ?? 0) + 1)).toBe(2);
  });
});
