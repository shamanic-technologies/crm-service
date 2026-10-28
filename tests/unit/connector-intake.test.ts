import { describe, it, expect } from "vitest";
import { assessIntake, dailySeries } from "../../src/lib/connector-intake-core.js";

const NOW = Date.parse("2026-10-28T14:00:00Z");
const synced = new Date("2026-10-28T13:45:00Z");
/** One active day every `step` days from `from` to `to` (inclusive). */
function every(step: number, from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += step * 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

describe("assessIntake: a sync that takes in nothing is not healthy", () => {
  it("Doc Dinners 2026-10-28: active, synced 15 min ago, longest past gap 5 days, nothing new for 8 days = red", () => {
    const days = [...every(2, "2026-05-01", "2026-10-09"), "2026-10-13", "2026-10-16", "2026-10-19", "2026-10-20"];
    const a = assessIntake({ activeDays: days, syncStatus: "active", lastSyncedAt: synced, lastError: null, now: NOW });
    expect(a).toMatchObject({ status: "red", newestRecordDay: "2026-10-20", quietDays: 8, usualLongestQuietDays: 5 });
    expect(a.reasons.map((r) => r.code)).toEqual(["quiet_unusual"]);
  });
  it("same account, quiet for no longer than its habit = ok", () => {
    const days = [...every(2, "2026-05-01", "2026-10-09"), "2026-10-14", "2026-10-16", "2026-10-19", "2026-10-24"];
    expect(assessIntake({ activeDays: days, syncStatus: "active", lastSyncedAt: synced, lastError: null, now: NOW }).status).toBe("ok");
  });
  it("a sparse account (one record a month) is never red for being itself", () => {
    const a = assessIntake({ activeDays: every(30, "2026-05-01", "2026-09-20"), syncStatus: "active", lastSyncedAt: synced, lastError: null, now: NOW });
    expect(a.status).toBe("ok");
    expect(a.quietDays).toBe(60);
  });
  it("a busy account quiet for 3 days is not red (3 days is the floor), 4 days is", () => {
    const busy = every(1, "2026-06-01", "2026-10-25");
    expect(assessIntake({ activeDays: busy, syncStatus: "active", lastSyncedAt: synced, lastError: null, now: NOW }).status).toBe("ok");
    expect(assessIntake({ activeDays: every(1, "2026-06-01", "2026-10-24"), syncStatus: "active", lastSyncedAt: synced, lastError: null, now: NOW }).status).toBe("red");
  });
  it("a failing or late sync is red, a paused one never", () => {
    const days = every(1, "2026-06-01", "2026-10-28");
    const err = assessIntake({ activeDays: days, syncStatus: "error", lastSyncedAt: synced, lastError: "GoHighLevel /contacts/ returned 401: Invalid JWT", now: NOW });
    expect(err.reasons.map((r) => r.code)).toEqual(["sync_error"]);
    expect(err.reasons[0].text).toContain("Invalid JWT");
    const late = assessIntake({ activeDays: days, syncStatus: "active", lastSyncedAt: new Date("2026-10-28T11:00:00Z"), lastError: null, now: NOW });
    expect(late.reasons.map((r) => r.code)).toEqual(["sync_late"]);
    expect(assessIntake({ activeDays: days, syncStatus: "active", lastSyncedAt: null, lastError: null, now: NOW }).status).toBe("red");
    expect(assessIntake({ activeDays: [], syncStatus: "paused", lastSyncedAt: null, lastError: null, now: NOW }).status).toBe("paused");
  });
  it("only the 180 days before the newest record make the habit", () => {
    // A 60-day hole a year ago does not excuse an 8-day silence now.
    const days = [...every(1, "2025-01-01", "2025-06-01"), ...every(1, "2025-08-01", "2026-10-20")];
    expect(assessIntake({ activeDays: days, syncStatus: "active", lastSyncedAt: synced, lastError: null, now: NOW }).status).toBe("red");
  });
});

describe("dailySeries", () => {
  it("zero-fills the last N UTC days up to today", () => {
    const s = dailySeries(new Map([["2026-10-27", 4]]), 3, NOW);
    expect(s).toEqual([
      { day: "2026-10-26", records: 0 },
      { day: "2026-10-27", records: 4 },
      { day: "2026-10-28", records: 0 },
    ]);
  });
});
