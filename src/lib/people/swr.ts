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
 */
export interface SwrEntry<T> {
  value: T;
  at: number;
}

export class SwrCache<T> {
  private readonly entries = new Map<string, SwrEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly name: string,
    private readonly freshMs: () => number,
    private readonly maxStaleMs: () => number,
  ) {}

  async get(key: string, load: (previous: SwrEntry<T> | undefined) => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < this.freshMs()) return hit.value;
    if (hit && age < this.maxStaleMs()) {
      this.refresh(key, load).catch((err) =>
        console.error(`[crm-service] ${this.name} background refresh failed key=${key}:`, (err as Error).message),
      );
      return hit.value;
    }
    return this.refresh(key, load);
  }

  private refresh(key: string, load: (previous: SwrEntry<T> | undefined) => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    const startedAt = Date.now();
    const p = load(this.entries.get(key))
      .then((value) => {
        this.entries.set(key, { value, at: startedAt });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
