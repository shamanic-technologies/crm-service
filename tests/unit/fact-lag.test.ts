import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PersonIndex, withRecordKeys, type CandidateFact } from "../../src/lib/people/facts.js";
import { factFeedSettlement, FACT_SETTLE_MARGIN_MS } from "../../src/lib/people/fact-ids.js";
import type { TimelineItem } from "../../src/lib/people/timeline.js";

/** UNIBOX-FACT-LAG-1028: the pure parts of "a fact is on the feed within the minute". */

const candidate = (over: Partial<CandidateFact> = {}): CandidateFact => ({
  naturalKey: "stripe|payment|ch_1",
  family: "stripe_money",
  type: "payment",
  source: "stripe",
  sourceRef: "ch_1",
  sourceContactId: "cus_new",
  crmContactId: "contact-new",
  occurredAt: "2026-10-28T05:00:39.000Z",
  dateBasis: "created",
  payload: { status: "failed" },
  subject: { presence: "stripe:cus_new", keys: [], standalone: false, emails: [], phones: [], fullName: "Tari" },
  ...over,
});

const person = {
  personKey: "email:tari@x.com",
  emails: ["tari@x.com"],
  phones: [],
  displayName: "Tari",
  identityKeys: ["email:tari@x.com", "uid:user_1"],
  presences: [{ source: "clerk", sourceRef: "c1", detail: { externalId: "user_1" } }],
  humanId: null,
};

describe("a record the build has not joined yet is filed on the person holding its keys", () => {
  it("a new Stripe customer's charge resolves on the customer's email, not held", () => {
    const index = new PersonIndex([person] as never);
    const c = candidate();
    expect(index.resolve(c.subject)).toBeNull();
    const keyed = withRecordKeys(c, new Map([["contact-new", ["email:tari@x.com"]]]));
    expect(keyed.subject.keys).toEqual(["email:tari@x.com"]);
    expect(index.resolve(keyed.subject)?.personKey).toBe("email:tari@x.com");
  });

  it("leaves alone a subject that states keys already, a standalone row, or a record with no keys", () => {
    const keys = new Map([["contact-new", ["email:tari@x.com"]]]);
    const own = candidate({ subject: { ...candidate().subject, keys: ["email:other@x.com"] } });
    expect(withRecordKeys(own, keys)).toBe(own);
    const standalone = candidate({ subject: { ...candidate().subject, standalone: true } });
    expect(withRecordKeys(standalone, keys)).toBe(standalone);
    const noKeys = candidate({ crmContactId: "contact-unknown" });
    expect(withRecordKeys(noKeys, keys)).toBe(noKeys);
  });
});

const item = (ref: Record<string, string | null>, over: Partial<TimelineItem> = {}): TimelineItem => ({
  at: "2026-10-28T05:00:39.000Z",
  source: "stripe",
  channel: "payment",
  kind: "event",
  direction: null,
  subject: null,
  text: null,
  from: null,
  to: [],
  ref,
  textClean: null,
  outreachFact: null,
  event: { step: "payment", dateBasis: "created", detail: {} },
  ...over,
});

describe("factFeedSettlement: is the thread on the feed yet?", () => {
  const statedThrough = new Date("2026-10-28T05:04:31.000Z");

  it("an item recorded after the last emission began, with no live fact = in flight", () => {
    const s = factFeedSettlement([item({ factKey: "stripe|payment|ch_1", recordedAt: "2026-10-28T05:04:05.000Z" })], [], statedThrough);
    expect(s.settled).toBe(false);
    expect(s.pending).toEqual([
      { source: "stripe", at: "2026-10-28T05:00:39.000Z", step: "payment", factKey: "stripe|payment|ch_1", recordedAt: "2026-10-28T05:04:05.000Z" },
    ]);
    expect(s.statedThrough).toBe("2026-10-28T05:04:31.000Z");
  });

  it("stated (a live fact id) = settled, whenever it was recorded", () => {
    const s = factFeedSettlement([item({ factKey: "stripe|payment|ch_1", recordedAt: "2026-10-28T05:04:30.000Z", factId: "f-1" })], [], statedThrough);
    expect(s).toMatchObject({ settled: true, pending: [] });
  });

  it("recorded well before an emission began and still no fact = no fact by rule, not in flight", () => {
    const old = new Date(statedThrough.getTime() - FACT_SETTLE_MARGIN_MS - 1).toISOString();
    expect(factFeedSettlement([item({ factKey: "posthog|visit|v1", recordedAt: old })], [], statedThrough).settled).toBe(true);
  });

  it("an item that is no fact (no key, or nothing recorded) never holds a thread", () => {
    const coldEmail = item({ campaignId: "c1" }, { source: "instantly", kind: "message", direction: "outbound", event: null });
    const becameCustomer = item({ factKey: null, recordedAt: "2026-10-28T05:04:30.000Z" });
    expect(factFeedSettlement([coldEmail, becameCustomer], [], statedThrough).settled).toBe(true);
  });

  it("a Matrix message is keyed on its event; never emitted for the scope = everything recorded is in flight", () => {
    const msg = item({ eventId: "$e1", recordedAt: "2026-10-28T05:11:01.000Z" }, { source: "matrix", kind: "message", direction: "inbound", event: null });
    expect(factFeedSettlement([msg], [], null)).toMatchObject({ settled: false, statedThrough: null, pending: [{ factKey: "matrix|$e1" }] });
  });
});

describe("feed order is a guarantee: one writer, under the feed lock", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  const src = files("src").map((p) => [p, readFileSync(p, "utf8")] as const);

  it("only facts.ts writes people_facts", () => {
    const writers = src.filter(([, s]) => /(insert|update|delete)\(peopleFacts\)|(INSERT INTO|UPDATE|DELETE FROM)\s+people_facts/.test(s)).map(([p]) => p);
    expect(writers).toEqual([join("src", "lib", "people", "facts.ts")]);
  });

  it("emitScopeFacts takes the exclusive feed lock before its first write; readFacts reads under it shared", () => {
    const facts = src.find(([p]) => p.endsWith(join("people", "facts.ts")))![1];
    const emit = facts.slice(facts.indexOf("export async function emitScopeFacts"), facts.indexOf("// ─── the read"));
    const lock = emit.indexOf("await tx.execute(FEED_LOCK)");
    expect(lock).toBeGreaterThan(0);
    for (const write of ["insertAll(tx", "tx.update(peopleFacts)"]) {
      expect(emit.indexOf(write)).toBeGreaterThan(lock);
    }
    const read = facts.slice(facts.indexOf("export async function readFacts"));
    expect(read.indexOf("FEED_READ_LOCK")).toBeGreaterThan(0);
    expect(read.indexOf("FEED_READ_LOCK")).toBeLessThan(read.indexOf(".from(peopleFacts)"));
  });
});

const emitted: string[] = [];
let release: (() => void) | null = null;
vi.mock("../../src/lib/people/facts.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/people/facts.js")>()),
  emitScopeFacts: vi.fn(async (scope: { id: string }) => {
    emitted.push(scope.id);
    await new Promise<void>((r) => (release = r));
    return { emitted: emitted.length };
  }),
}));

describe("requestEmission: one emission per scope at a time, one more after it at most", () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it("requests while one runs coalesce into ONE more run after it", async () => {
    const { requestEmission } = await import("../../src/lib/people/fact-emitter.js");
    const scope = { id: "s1", orgId: "o", brandId: "b" };
    const first = requestEmission(scope);
    const second = requestEmission(scope);
    const third = requestEmission(scope);
    expect(second).toBe(third);
    expect(emitted).toEqual(["s1"]);
    release!();
    await first;
    await vi.waitFor(() => expect(emitted).toEqual(["s1", "s1"]));
    release!();
    await second;
    expect(emitted).toEqual(["s1", "s1"]);
  });
});
