import { describe, it, expect } from "vitest";
import { changePending, CHANGE_CONFIRM_MS, unitsFromFacts } from "../../src/lib/people/freshness.js";
import { freshFor, freshReadDue, STORE_FORMAT, storedBeforeChange } from "../../src/lib/people/search.js";

const ORG = "aaaaaaaa-2222-4222-8222-000000000001";
const BRAND = "aaaaaaaa-2222-4222-8222-000000000002";

const fact = (over: Record<string, unknown> = {}) => ({
  seq: "1",
  recordedAt: "2026-10-10T07:00:00.000Z",
  leadEmail: "Robert.Burke@Fondren.com",
  orgId: ORG,
  campaignId: "f7b1b610-4fa1-4b54-8fec-f7be124dc32b",
  brandIds: [BRAND],
  ...over,
});

describe("unitsFromFacts", () => {
  const since = Date.parse("2026-10-09T07:00:00.000Z");
  it("names the (campaign, lowercased lead) thread, once", () => {
    expect(unitsFromFacts({ orgId: ORG, brandId: BRAND }, [fact(), fact({ seq: "2" })], since)).toEqual([
      "f7b1b610-4fa1-4b54-8fec-f7be124dc32b:robert.burke@fondren.com",
    ]);
  });
  it("ignores another org, another brand, a campaign-less fact and a fact recorded before `since`", () => {
    expect(
      unitsFromFacts(
        { orgId: ORG, brandId: BRAND },
        [
          fact({ orgId: "other" }),
          fact({ brandIds: ["other"] }),
          fact({ campaignId: null }),
          fact({ recordedAt: "2026-10-01T00:00:00.000Z" }),
        ],
        since,
      ),
    ).toEqual([]);
  });
});

describe("changePending / storedBeforeChange", () => {
  const changedAt = new Date("2026-10-10T07:00:00.000Z");
  const t = changedAt.getTime();
  it("no known move: nothing pending", () => {
    expect(changePending({ changedAt: null, indexedAt: new Date(t - 1) }, t)).toBe(false);
    expect(storedBeforeChange({ changedAt: null, indexedAt: new Date(t - 1) })).toBe(false);
  });
  it("read before the move: pending, and an open re-reads it", () => {
    expect(changePending({ changedAt, indexedAt: new Date(t - 1000) }, t)).toBe(true);
    expect(storedBeforeChange({ changedAt, indexedAt: new Date(t - 1000) })).toBe(true);
  });
  it("read right after the move: one confirmation read once CHANGE_CONFIRM_MS has passed, then done", () => {
    const readSoon = { changedAt, indexedAt: new Date(t + 1000) };
    expect(storedBeforeChange(readSoon)).toBe(false);
    expect(changePending(readSoon, t + 2000)).toBe(false);
    expect(changePending(readSoon, t + CHANGE_CONFIRM_MS)).toBe(true);
    expect(changePending({ changedAt, indexedAt: new Date(t + CHANGE_CONFIRM_MS + 1) }, t + CHANGE_CONFIRM_MS + 5000)).toBe(false);
  });
});

describe("read-through (RIGHT-MOMENT-OR-LATER-1014)", () => {
  const now = Date.parse("2026-10-14T14:24:38.000Z");
  const W = 10_000;
  const unit = (agoMs: number, over: Record<string, unknown> = {}) => ({
    status: "ok",
    indexedAt: new Date(now - agoMs),
    format: STORE_FORMAT,
    changedAt: null as Date | null,
    ...over,
  });
  it("a thread read inside the window is not re-read; one read before it is", () => {
    expect(freshReadDue(unit(3_000), now, W)).toBe(false);
    expect(freshReadDue(unit(30_000), now, W)).toBe(true);
  });
  it("a never-read, failed, older-format or moved-since thread is re-read", () => {
    expect(freshReadDue(undefined, now, W)).toBe(true);
    expect(freshReadDue(unit(1_000, { status: "failed" }), now, W)).toBe(true);
    expect(freshReadDue(unit(1_000, { format: STORE_FORMAT - 1 }), now, W)).toBe(true);
    expect(freshReadDue(unit(1_000, { changedAt: new Date(now) }), now, W)).toBe(true);
  });
  it("only a successful read inside the window, not before a known move, answers as fresh", () => {
    expect(freshFor(unit(-500), now, W)).toBe(true); // re-read during this answer
    expect(freshFor(unit(9_000), now, W)).toBe(true);
    expect(freshFor(unit(30_000), now, W)).toBe(false);
    expect(freshFor(unit(-500, { status: "failed" }), now, W)).toBe(false);
    expect(freshFor(unit(1_000, { changedAt: new Date(now) }), now, W)).toBe(false);
    expect(freshFor(undefined, now, W)).toBe(false);
  });
});
