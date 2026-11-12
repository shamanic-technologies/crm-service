import { describe, it, expect } from "vitest";
import { SwrCache, type SwrEntry, type SwrStore } from "../../src/lib/people/swr.js";

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

  it("DASH-SPEED-1110: a stored entry is served when memory is empty (by the same age rules), and every load is stored", async () => {
    const rows = new Map<string, SwrEntry<number>>([["k", { value: 7, at: Date.now() - 1_000 }]]);
    let reads = 0;
    const store: SwrStore<number> = {
      async read(key) {
        reads++;
        return rows.get(key);
      },
      async write(key, entry) {
        rows.set(key, entry);
      },
    };
    let loads = 0;
    const load = async () => ++loads * 100;
    const fresh = new SwrCache<number>("t", () => 60_000, () => 120_000, { store });
    expect(await fresh.get("k", load)).toBe(7); // stored, fresh: served, nothing computed
    expect(await fresh.get("k", load)).toBe(7);
    expect([loads, reads]).toEqual([0, 1]); // read from the store once, then memory
    expect(await fresh.get("other", load)).toBe(100); // nothing stored: computed, then stored
    expect(rows.get("other")?.value).toBe(100);

    const stale = new SwrCache<number>("t", () => 1, () => 120_000, { store });
    expect(await stale.get("k", load)).toBe(7); // stale: served while one refresh runs behind it
    await tick();
    expect(rows.get("k")?.value).toBe(200);
    expect(await stale.ageOf("k")).toBeLessThan(1_000);

    const expired = new SwrCache<number>("t", () => 1, () => 1, { store });
    rows.set("k", { value: 7, at: Date.now() - 1_000 });
    expect(await expired.get("k", load)).toBe(300); // too old: the caller waits for a fresh load
  });

  it("MON-PAGE-SPEED-1111 serveAnyAge: an entry past max stale is served at once, refreshed behind; failures retried at most every retryAfterMs", async () => {
    const rows = new Map<string, SwrEntry<string>>([["k", { value: "stored", at: Date.now() - 10 * 3_600_000 }]]);
    const store: SwrStore<string> = {
      async read(key) {
        return rows.get(key);
      },
      async write(key, entry) {
        rows.set(key, entry);
      },
    };
    let fail = true;
    let loads = 0;
    const load = async () => {
      loads++;
      await tick(30);
      if (fail) throw new Error("lead-service timed out");
      return "new";
    };
    const c = new SwrCache<string>("t", () => 1, () => 1, { store, serveAnyAge: true, retryAfterMs: 50 });
    const t = Date.now();
    expect(await c.get("k", load)).toBe("stored"); // 10 h old: served at once, never the 30 s wait
    expect(Date.now() - t).toBeLessThan(25);
    await tick(40); // the refresh failed
    expect(await c.get("k", load)).toBe("stored");
    expect(await c.get("k", load)).toBe("stored");
    expect(loads).toBe(1); // no retry inside retryAfterMs
    await tick(60);
    fail = false;
    expect(await c.get("k", load)).toBe("stored"); // retried behind
    await tick(40);
    expect(loads).toBe(2);
    expect(await c.get("k", load)).toBe("new");
    // Nothing held: the caller waits and sees the error.
    fail = true;
    await expect(c.get("none", load)).rejects.toThrow("lead-service timed out");
  });

  it("without serveAnyAge, past max stale the caller still waits (other caches unchanged)", async () => {
    let loads = 0;
    const c = new SwrCache<number>("t", () => 1, () => 1);
    expect(await c.get("k", async () => ++loads)).toBe(1);
    await tick();
    expect(await c.get("k", async () => ++loads)).toBe(2);
  });

  it("DASH-SPEED-1110: maxEntries drops the oldest key", async () => {
    const c = new SwrCache<string>("t", () => 60_000, () => 120_000, { maxEntries: 2 });
    for (const k of ["a", "b", "c"]) await c.get(k, async () => k);
    let reloaded = 0;
    await c.get("a", async () => (reloaded++, "a"));
    await c.get("c", async () => (reloaded++, "c"));
    expect(reloaded).toBe(1);
  });
});
