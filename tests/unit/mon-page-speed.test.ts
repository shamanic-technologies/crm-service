import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson, contentHash } from "../../src/lib/people/facts.js";
import { attachHeldEvidence } from "../../src/lib/people/build.js";

// MON-PAGE-SPEED-1111: the former implementations, verbatim, as the reference the fast ones must equal byte for byte
// (stored content hashes are compared against fresh ones: one differing byte re-emits every fact of every brand).
const stable = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
};
const formerHash = (c: { type: unknown; occurredAt: unknown; dateBasis: unknown; sourceContactId: unknown; payload: unknown }) =>
  createHash("sha256")
    .update(JSON.stringify(stable([c.type, c.occurredAt, c.dateBasis, c.sourceContactId, c.payload])))
    .digest("hex");

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomValue(rnd: () => number, depth: number): unknown {
  const r = rnd();
  if (depth > 3 || r < 0.35) {
    const pick = Math.floor(rnd() * 12);
    return [
      null,
      undefined,
      true,
      false,
      0,
      -0,
      Math.round(rnd() * 1e6) / 100,
      "plain",
      "é ünïcode   \"quoted\" \\ \n",
      new Date(Date.UTC(2026, 10, 11, 13, Math.floor(rnd() * 60))),
      NaN,
      "",
    ][pick];
  }
  if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 5) }, () => randomValue(rnd, depth + 1));
  const keys = ["b", "a", "10", "2", "0", "z", "A", "_x", "4294967295", "4294967294", "01", "-1", "1.5", "__proto_", "ä", "B"];
  const o: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(rnd() * 7); i++) o[keys[Math.floor(rnd() * keys.length)]] = randomValue(rnd, depth + 1);
  return o;
}

describe("canonicalJson / contentHash (MON-PAGE-SPEED-1111)", () => {
  it("writes exactly what the former sorted-copy stringify wrote, on 5,000 random payloads", () => {
    const rnd = seeded(42);
    for (let i = 0; i < 5000; i++) {
      const v = randomValue(rnd, 0);
      expect(canonicalJson([v])).toBe(JSON.stringify(stable([v])));
    }
  });

  it("orders index keys first ascending, then the rest sorted, as an object built from sorted entries does", () => {
    const v = { b: 1, "10": 2, a: 3, "2": 4, "01": 5, "4294967295": 6 };
    expect(canonicalJson(v)).toBe(JSON.stringify(stable(v)));
    expect(canonicalJson(v)).toBe('{"2":4,"10":2,"01":5,"4294967295":6,"a":3,"b":1}');
  });

  it("drops undefined members of objects, writes null for them in arrays, a Date as its ISO string", () => {
    const at = new Date("2026-11-11T13:14:00.000Z");
    expect(canonicalJson({ a: undefined, b: [undefined, at] })).toBe('{"b":[null,"2026-11-11T13:14:00.000Z"]}');
  });

  it("the hash of real-shaped facts is unchanged", () => {
    const facts = [
      { type: "signup", occurredAt: "2026-11-01T10:00:00.000Z", dateBasis: "event", sourceContactId: "user_2abc", payload: { email: "x@y.com", plan: null, tags: ["b", "a"] } },
      { type: "payment", occurredAt: new Date("2026-11-02T00:00:00Z"), dateBasis: "event", sourceContactId: null, payload: { amountCents: 1000, currency: "usd", refunds: [{ id: "re_1", amount: 0 }] } },
      { type: "website_visit", occurredAt: null, dateBasis: "none", sourceContactId: "ph_1", payload: { url: "https://distribute.you/?a=1", props: { $os: "Mac", "0": "first" } } },
    ];
    for (const f of facts) expect(contentHash(f as never)).toBe(formerHash(f));
  });
});

describe("attachHeldEvidence (MON-PAGE-SPEED-1111)", () => {
  type Ev = { id: string; keys: string[] };
  type Cl = { identityKeys: string[]; evidence: Ev[] };
  const former = (clusters: Cl[], held: Ev[]) => {
    for (const e of held) {
      const ks = new Set(e.keys);
      for (const c of clusters) if (c.identityKeys.some((k) => ks.has(k))) c.evidence.push(e);
    }
  };

  it("gives every cluster the same judgments, in the same order, as the scan of every cluster", () => {
    const rnd = seeded(7);
    const key = () => `email:p${Math.floor(rnd() * 60)}@x.com`;
    for (let round = 0; round < 50; round++) {
      const shape = Array.from({ length: 40 }, () => [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, key))].sort());
      const held = Array.from({ length: 30 }, (_, i) => ({ id: `j${i}`, keys: Array.from({ length: 1 + Math.floor(rnd() * 3) }, key) }));
      const a: Cl[] = shape.map((identityKeys) => ({ identityKeys, evidence: [] }));
      const b: Cl[] = shape.map((identityKeys) => ({ identityKeys, evidence: [] }));
      former(a, held);
      attachHeldEvidence(b, held, (e) => e.keys);
      expect(b.map((c) => c.evidence.map((e) => e.id))).toEqual(a.map((c) => c.evidence.map((e) => e.id)));
    }
  });

  it("stays fast on a big brand (41k people x 2k judgments)", () => {
    const clusters: Cl[] = Array.from({ length: 41_000 }, (_, i) => ({ identityKeys: [`email:p${i}@x.com`, `phone:+1${i}`], evidence: [] }));
    const held = Array.from({ length: 2_000 }, (_, i) => ({ id: `j${i}`, keys: [`email:p${i * 7}@x.com`] }));
    const t = Date.now();
    attachHeldEvidence(clusters, held, (e) => e.keys);
    expect(Date.now() - t).toBeLessThan(2_000); // measured ~30 ms; the former scan: 82M key tests
    expect(clusters[7].evidence.map((e) => e.id)).toEqual(["j1"]);
  });
});
