import { describe, it, expect } from "vitest";
import {
  applyObservation,
  foldObservations,
  isDown,
  observeLogins,
  parseLoggedOutRefusal,
  rollupDays,
  type LineObservation,
} from "../../src/lib/whatsapp/line-health-core.js";

const t = (iso: string) => new Date(iso);
const LOGOUT = "You were logged out from another device. Relogin to continue using the bridge.";

describe("observeLogins: the line's state is what the bridge says", () => {
  const at = t("2026-10-23T08:00:00Z");
  it("a logged-out line reads logged_out with the bridge's words and time", () => {
    const o = observeLogins(
      [{ id: "77776879632", name: "", state: { state_event: "BAD_CREDENTIALS", message: LOGOUT, timestamp: Date.parse("2026-10-19T14:39:00Z") / 1000 } }],
      "77776879632",
      at,
      null,
    );
    expect(o).toMatchObject({ state: "logged_out", bridgeState: "BAD_CREDENTIALS", reason: LOGOUT, since: t("2026-10-19T14:39:00Z") });
    expect(isDown(o.state, o.since!, at)).toBe(true);
  });
  it("a connected line reads connected", () => {
    const o = observeLogins([{ id: "33770657585", name: "", state: { state_event: "CONNECTED" } }], "33770657585", at, t("2026-10-10T10:15:00Z"));
    expect(o.state).toBe("connected");
    expect(isDown(o.state, o.since!, at)).toBe(false);
  });
  it("a login gone from the bridge reads logged_out", () => {
    expect(observeLogins([], "33770657585", at, null).state).toBe("logged_out");
  });
  it("a transient state reads reconnecting, red only after 15 min", () => {
    const o = observeLogins([{ id: "1", name: "", state: { state_event: "TRANSIENT_DISCONNECT" } }], "1", at, null);
    expect(o.state).toBe("reconnecting");
    expect(isDown("reconnecting", t("2026-10-23T07:50:00Z"), at)).toBe(false);
    expect(isDown("reconnecting", t("2026-10-23T07:40:00Z"), at)).toBe(true);
  });
});

describe("applyObservation", () => {
  const conn = (at: string): LineObservation => ({ state: "connected", bridgeState: "CONNECTED", reason: null, since: null, at: t(at) });
  it("the same state within the gap grows the span", () => {
    const a = applyObservation({ state: "connected", bridgeState: null, reason: null, startedAt: t("2026-10-23T07:00:00Z"), lastSeenAt: t("2026-10-23T07:58:00Z") }, conn("2026-10-23T08:00:00Z"), 15 * 60_000);
    expect(a).toMatchObject({ kind: "extend", lastSeenAt: t("2026-10-23T08:00:00Z") });
  });
  it("a gap longer than allowed opens a new span and leaves the gap unknown", () => {
    const a = applyObservation({ state: "connected", bridgeState: null, reason: null, startedAt: t("2026-10-23T05:00:00Z"), lastSeenAt: t("2026-10-23T06:00:00Z") }, conn("2026-10-23T08:00:00Z"), 15 * 60_000);
    expect(a).toMatchObject({ kind: "open", closePreviousAt: null });
  });
  it("a logout opens at the bridge's stated time and the connected span ends there", () => {
    const a = applyObservation(
      { state: "connected", bridgeState: null, reason: null, startedAt: t("2026-10-19T10:00:00Z"), lastSeenAt: t("2026-10-19T14:38:00Z") },
      { state: "logged_out", bridgeState: "BAD_CREDENTIALS", reason: LOGOUT, since: t("2026-10-19T14:39:00Z"), at: t("2026-10-19T14:40:00Z") },
      15 * 60_000,
    );
    expect(a).toMatchObject({ kind: "open", closePreviousAt: t("2026-10-19T14:39:00Z"), span: { startedAt: t("2026-10-19T14:39:00Z") } });
  });
});

describe("parseLoggedOutRefusal", () => {
  it("reads the number, the bridge's time and words; the old wording names nobody", () => {
    const text = `WhatsApp logged out +77776879632 at 2026-10-19 14:39 UTC (the bridge says: "${LOGOUT}"). Relink it from the Integrations page.`;
    expect(parseLoggedOutRefusal(text, t("2026-10-20T18:24:46Z"))).toEqual([
      { phone: "+77776879632", observation: { state: "logged_out", bridgeState: null, reason: LOGOUT, since: t("2026-10-19T14:39:00Z"), at: t("2026-10-20T18:24:46Z") } },
    ]);
    expect(parseLoggedOutRefusal("The brand's WhatsApp is linked but not connected right now (logged out or offline).", new Date())).toEqual([]);
  });
});

describe("backfill of the real 2026-10-19 → 10-22 outage of +77776879632 (prod rows)", () => {
  // What crm-service held: successful sends from the line, refusals naming it, the relink time.
  const sent = (at: string): LineObservation => ({ state: "connected", bridgeState: null, reason: null, since: null, at: t(at) });
  const refused = (at: string) =>
    parseLoggedOutRefusal(`WhatsApp logged out +77776879632 at 2026-10-19 14:39 UTC (the bridge says: "${LOGOUT}"). Relink it.`, t(at))[0].observation;
  const obs: LineObservation[] = [
    sent("2026-10-19T06:32:34Z"),
    sent("2026-10-19T14:39:47Z"),
    refused("2026-10-19T19:01:48Z"),
    refused("2026-10-20T18:24:46Z"),
    refused("2026-10-21T02:59:48Z"),
    refused("2026-10-22T15:43:51Z"),
    { state: "connected", bridgeState: null, reason: null, since: t("2026-10-22T18:41:46Z"), at: t("2026-10-22T18:41:46Z") }, // relink
    sent("2026-10-22T18:56:52Z"),
    sent("2026-10-22T23:59:34Z"),
  ];
  const days = rollupDays(foldObservations(obs, 6 * 3_600_000), t("2026-10-23T00:00:00Z"));
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));

  it("reads 10-20 and 10-21 down the whole day", () => {
    expect(byDay["2026-10-20"]).toMatchObject({ status: "down", downMinutes: 1440, connectedMinutes: 0 });
    expect(byDay["2026-10-21"]).toMatchObject({ status: "down", downMinutes: 1440, lastReason: LOGOUT });
  });
  it("reads 10-19 down from the logout and 10-22 down until the relink, then connected", () => {
    expect(byDay["2026-10-19"].status).toBe("down");
    expect(byDay["2026-10-19"].downMinutes).toBe(560); // 14:39:47 → 24:00
    expect(byDay["2026-10-22"]).toMatchObject({ status: "down", lastState: "connected" });
    expect(byDay["2026-10-22"].downMinutes).toBe(1122); // 00:00 → 18:41:46
    expect(byDay["2026-10-22"].connectedMinutes).toBe(318); // 18:41:46 → 23:59:34
  });
});

describe("rollupDays", () => {
  it("a short reconnect followed by connected is not red and counts as healed on its own", () => {
    const days = rollupDays(
      [
        { state: "connected", bridgeState: null, reason: null, startedAt: t("2026-10-23T00:00:00Z"), lastSeenAt: t("2026-10-23T05:00:00Z") },
        { state: "reconnecting", bridgeState: "TRANSIENT_DISCONNECT", reason: null, startedAt: t("2026-10-23T05:00:00Z"), lastSeenAt: t("2026-10-23T05:04:00Z") },
        { state: "connected", bridgeState: null, reason: null, startedAt: t("2026-10-23T05:04:00Z"), lastSeenAt: t("2026-10-23T06:00:00Z") },
      ],
      t("2026-10-23T06:00:00Z"),
    );
    expect(days).toEqual([
      expect.objectContaining({ day: "2026-10-23", status: "ok", connectedMinutes: 356, reconnectingMinutes: 4, downMinutes: 0, unknownMinutes: 0, recoveredOnItsOwn: 1 }),
    ]);
  });
  it("a reconnect stuck over 15 min reads down", () => {
    const [d] = rollupDays(
      [{ state: "reconnecting", bridgeState: "UNKNOWN_ERROR", reason: null, startedAt: t("2026-10-23T05:00:00Z"), lastSeenAt: t("2026-10-23T05:30:00Z") }],
      t("2026-10-23T06:00:00Z"),
    );
    expect(d).toMatchObject({ status: "down", downMinutes: 30, unknownMinutes: 330 });
  });
});
