import { describe, it, expect, beforeEach, vi } from "vitest";
import { foldGoogleIntake } from "../../src/lib/connector-intake.js";
import { readGoogleIntake, resetGoogleIntakeCache, type GoogleConnection } from "../../src/lib/google-intake.js";

const NOW = Date.parse("2026-11-28T12:00:00Z");

/** google-service's served item for a mailbox whose grant Google revoked (2026-11-27 18:20 UTC). */
function revoked(account: string, brandId: string | null = null): GoogleConnection {
  return {
    source: "gmail",
    connectionId: `conn-${account}`,
    orgId: "f0420eb5-0000-4000-8000-000000000001",
    brandId,
    account,
    syncStatus: "reconnect_required",
    lastSyncedAt: "2026-11-27T18:15:00Z",
    lastError: "invalid_grant: Token has been expired or revoked.",
    status: "red",
    reasons: [{ code: "reconnect_required", text: "Google revoked access: reconnect the mailbox" }],
    newestRecordDay: "2026-11-27",
    quietDays: 1,
    usualLongestQuietDays: 2,
    activeDaysInHistory: 90,
    byDay: [{ day: "2026-11-28", records: 0 }],
  };
}

describe("foldGoogleIntake: Google connections on Monitoring > Connected tools (GMAIL-SYNC-STALL-1128)", () => {
  it("the 3 revoked mailboxes are listed red with google-service's own reason, served as-is", () => {
    const google = { ok: true as const, connections: [revoked("kevin.lourd@gmail.com"), revoked("kevin@pressbeat.io"), revoked("info@jarygo.com", "bbbbbbbb-1111-4111-8111-000000000001")] };
    const names = new Map([["bbbbbbbb-1111-4111-8111-000000000001", "Jarygo Studios"]]);
    const out = foldGoogleIntake(google, names, 7, NOW);
    expect(out.unreadable).toEqual([]);
    expect(out.connections.map((c) => [c.account, c.status, c.reasons[0].code, c.brandName])).toEqual([
      ["kevin.lourd@gmail.com", "red", "reconnect_required", null],
      ["kevin@pressbeat.io", "red", "reconnect_required", null],
      ["info@jarygo.com", "red", "reconnect_required", "Jarygo Studios"],
    ]);
    expect(out.connections[0]).toMatchObject({ source: "gmail", brandId: null, syncStatus: "reconnect_required", waiting: null });
  });

  it("an ok / paused verdict stays ok / paused (never re-graded here)", () => {
    const ok = { ...revoked("a@b.co"), status: "ok" as const, reasons: [], syncStatus: "active" };
    const paused = { ...revoked("c@d.co"), status: "paused" as const, reasons: [] };
    const out = foldGoogleIntake({ ok: true, connections: [ok, paused] }, new Map(), 7, NOW);
    expect(out.connections.map((c) => c.status)).toEqual(["ok", "paused"]);
  });

  it("google-service unreadable = a red source_unreadable row + unreadableSources, never an empty list", () => {
    const out = foldGoogleIntake({ ok: false, error: "google-service GET /internal/connector-intake answered 502: bad gateway" }, new Map(), 7, NOW);
    expect(out.unreadable).toEqual([{ source: "google", producer: "google-service", error: "google-service GET /internal/connector-intake answered 502: bad gateway" }]);
    expect(out.connections).toHaveLength(1);
    expect(out.connections[0]).toMatchObject({ source: "google", status: "red", syncStatus: "unreadable" });
    expect(out.connections[0].reasons[0].code).toBe("source_unreadable");
    expect(out.connections[0].byDay).toHaveLength(7);
  });
});

describe("readGoogleIntake: shared read, failures returned loud", () => {
  beforeEach(() => resetGoogleIntakeCache());

  it("a failing read is returned as {ok:false}, not cached: the next read asks again", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce([revoked("x@y.co")]);
    expect(await readGoogleIntake(30, fetcher)).toEqual({ ok: false, error: "timeout" });
    const second = await readGoogleIntake(30, fetcher);
    expect(second.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("concurrent and fresh reads share one call", async () => {
    const fetcher = vi.fn().mockResolvedValue([revoked("x@y.co")]);
    await Promise.all([readGoogleIntake(30, fetcher), readGoogleIntake(30, fetcher)]);
    await readGoogleIntake(30, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
