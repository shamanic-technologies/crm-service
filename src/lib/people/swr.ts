/**
 * Stale-while-revalidate, in process (DASH-LATENCY-1014).
 *
 * A dashboard tab re-reads the same brand every few seconds, and several tabs
 * read it at once: recomputing per request stacked 4-5 copies of the same heavy
 * read in Postgres. One entry per key:
 *
 *  - younger than `freshMs`      → served as is, nothing runs;
 *  - younger than `maxStaleMs`   → served as is, ONE background refresh starts;
 *  - older, or never loaded      → the caller waits for the (shared) load.
 *
 * Concurrent loads of one key share one promise. A failed load is never cached:
 * a stale value keeps being served until `maxStaleMs`, then the caller waits for
 * a load and sees its error. `at` is when the load STARTED, so an entry's age is
 * the age of the data it holds.
 *
 * DASH-SPEED-1110: an optional `store` keeps each loaded entry beyond the process
 * (a deploy restarts the container): a key missing from memory is first looked up
 * there, and a stored entry is served by the same age rules (stale = served while
 * one refresh runs). `maxEntries` bounds the keys held in memory (oldest dropped).
 *
 * MON-PAGE-SPEED-1111: `serveAnyAge` = an entry held is ALWAYS served, whatever its age,
 * while ONE refresh runs behind it; only a key with nothing held makes the caller wait.
 * Past `maxStaleMs` the served entry is logged loud (key, age, the refresh's error). A
 * failed refresh is retried behind reads at most every `retryAfterMs` (60 s). Before, a
 * producer failing for over an hour (lead-service timing out at 30 s on one brand's bucket)
 * made EVERY read wait 30 s and answer 502 for 10 h while a good answer sat stored.
 */
export interface SwrStore<T> {
  read(key: string): Promise<SwrEntry<T> | undefined>;
  write(key: string, entry: SwrEntry<T>): Promise<void>;
}

export interface SwrEntry<T> {
  value: T;
  at: number;
}

export class SwrCache<T> {
  private readonly entries = new Map<string, SwrEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly seeding = new Map<string, Promise<void>>();

  constructor(
    private readonly name: string,
    private readonly freshMs: () => number,
    private readonly maxStaleMs: () => number,
    private readonly options: { store?: SwrStore<T>; maxEntries?: number; serveAnyAge?: boolean; retryAfterMs?: number } = {},
  ) {}

  /** Last failed refresh per key (serveAnyAge): when, and its error. */
  private readonly failed = new Map<string, { at: number; error: string }>();
  /** Bumped by clear(): a load started before it never writes its result after it. */
  private generation = 0;

  /** Age of the entry held for `key` (memory, else the store), undefined when none. */
  async ageOf(key: string): Promise<number | undefined> {
    await this.seed(key);
    const hit = this.entries.get(key);
    return hit ? Date.now() - hit.at : undefined;
  }

  /** Load `key` now (shared with a load already running), whatever the age of what is held. */
  reload(key: string, load: (previous: SwrEntry<T> | undefined) => Promise<T>): Promise<T> {
    return this.seed(key).then(() => this.refresh(key, load));
  }

  private seed(key: string): Promise<void> {
    const store = this.options.store;
    if (!store || this.entries.has(key)) return Promise.resolve();
    const running = this.seeding.get(key);
    if (running) return running;
    const p = store
      .read(key)
      .then((stored) => {
        if (stored && !this.entries.has(key)) this.set(key, stored);
      })
      .finally(() => this.seeding.delete(key));
    this.seeding.set(key, p);
    return p;
  }

  private set(key: string, entry: SwrEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    const max = this.options.maxEntries;
    if (max) while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value as string);
  }

  async get(key: string, load: (previous: SwrEntry<T> | undefined) => Promise<T>): Promise<T> {
    await this.seed(key);
    const hit = this.entries.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < this.freshMs()) return hit.value;
    if (hit && age < this.maxStaleMs()) {
      this.refreshBehind(key, load);
      return hit.value;
    }
    if (hit && this.options.serveAnyAge) {
      const failed = this.failed.get(key);
      console.warn(
        `[crm-service] ${this.name} served an answer ${Math.round(age / 60_000)} min old key=${key}` +
          (failed ? ` (last refresh failed ${Math.round((Date.now() - failed.at) / 1000)} s ago: ${failed.error})` : ""),
      );
      if (!failed || Date.now() - failed.at >= (this.options.retryAfterMs ?? 60_000)) this.refreshBehind(key, load);
      return hit.value;
    }
    return this.refresh(key, load);
  }

  private refreshBehind(key: string, load: (previous: SwrEntry<T> | undefined) => Promise<T>): void {
    const generation = this.generation;
    this.refresh(key, load).catch((err) => {
      if (this.options.serveAnyAge && generation === this.generation) this.failed.set(key, { at: Date.now(), error: (err as Error).message });
      console.error(`[crm-service] ${this.name} background refresh failed key=${key}:`, (err as Error).message);
    });
  }

  private refresh(key: string, load: (previous: SwrEntry<T> | undefined) => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    const startedAt = Date.now();
    const generation = this.generation;
    const p = load(this.entries.get(key))
      .then(async (value) => {
        if (generation !== this.generation) return value;
        const entry = { value, at: startedAt };
        this.set(key, entry);
        this.failed.delete(key);
        if (this.options.store) await this.options.store.write(key, entry);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  /** Memory only: a store keeps its rows (callers clear their store themselves). */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
    this.seeding.clear();
    this.failed.clear();
  }
}
