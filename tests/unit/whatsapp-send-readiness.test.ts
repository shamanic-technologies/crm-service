import { beforeEach, describe, expect, it, vi } from "vitest";

// WA-NOT-CONNECTED-1019: a send is refused `whatsapp_not_connected` ONLY when
// WhatsApp logged the account out (with the bridge's own reason); a reconnect
// is waited for, then reported as transient, never "relink".

const bridgeLogins = vi.fn();
vi.mock("../../src/lib/matrix/bridge.js", () => ({ bridgeLogins }));
vi.mock("../../src/db/index.js", () => ({ db: {} }));

process.env.WHATSAPP_RECONNECT_WAIT_MS = "300";
process.env.WHATSAPP_RECONNECT_POLL_MS = "10";

const { loginStatus, describeLoggedOut, sendReadiness } = await import("../../src/lib/whatsapp/accounts.js");

const account = {
  linkId: "l1",
  connectionId: "c1",
  matrixUserId: "@crm_x:hs",
  accessToken: "t",
  loginId: "77776879632",
  outreachDefault: false,
  automationAllowed: true,
  persona: null,
};

const login = (state_event: string, extra: Record<string, unknown> = {}) => [
  { id: "77776879632", name: "+77776879632", state: { state_event, ...extra } },
];

// The bridge's answer for Sophie's number on 2026-10-19 06:47 UTC, verbatim shape.
const PROD_LOGGED_OUT = login("BAD_CREDENTIALS", {
  timestamp: 1792391556,
  error: "wa-logged-out",
  message: "You were logged out from another device. Relogin to continue using the bridge.",
  info: { reachout_timelock_until: "2026-10-19T12:32:36Z" },
});

describe("loginStatus", () => {
  it("CONNECTED and BACKFILLING can send", () => {
    expect(loginStatus(login("CONNECTED"), "77776879632").kind).toBe("connected");
    expect(loginStatus(login("BACKFILLING"), "77776879632").kind).toBe("connected");
  });
  it("a reconnect is transient, not logged out", () => {
    for (const s of ["TRANSIENT_DISCONNECT", "CONNECTING", "BRIDGE_UNREACHABLE", "UNKNOWN_ERROR"]) {
      expect(loginStatus(login(s), "77776879632")).toEqual({ kind: "transient", stateEvent: s });
    }
  });
  it("BAD_CREDENTIALS carries the bridge's words, when, and WhatsApp's reach-out lock", () => {
    const st = loginStatus(PROD_LOGGED_OUT, "77776879632");
    expect(st).toEqual({
      kind: "logged_out",
      stateEvent: "BAD_CREDENTIALS",
      message: "You were logged out from another device. Relogin to continue using the bridge.",
      since: new Date(1792391556 * 1000),
      reachoutLockedUntil: new Date("2026-10-19T12:32:36Z"),
    });
  });
  it("a login gone from the bridge is logged out", () => {
    expect(loginStatus([], "77776879632").kind).toBe("logged_out");
  });
});

describe("describeLoggedOut", () => {
  it("names the number, the time, the bridge's reason and the lock", () => {
    const st = loginStatus(PROD_LOGGED_OUT, "77776879632");
    if (st.kind !== "logged_out") throw new Error("expected logged_out");
    const text = describeLoggedOut([{ loginId: "77776879632", status: st }], new Date("2026-10-19T06:42:31Z"));
    expect(text).toBe(
      'WhatsApp logged out +77776879632 at 2026-10-19 06:32 UTC (the bridge says: "You were logged out from another device. Relogin to continue using the bridge."). WhatsApp also limits this number from writing to new people until 2026-10-19 12:32 UTC. Relink it from the Integrations page.',
    );
  });
});

describe("sendReadiness", () => {
  beforeEach(() => bridgeLogins.mockReset());

  it("waits out a reconnect and sends", async () => {
    bridgeLogins.mockResolvedValueOnce(login("TRANSIENT_DISCONNECT")).mockResolvedValueOnce(login("CONNECTING")).mockResolvedValue(login("CONNECTED"));
    const r = await sendReadiness([account]);
    expect(r.connected).toEqual([account]);
    expect(bridgeLogins).toHaveBeenCalledTimes(3);
  });

  it("a reconnect that outlasts the wait is reported as reconnecting, not logged out", async () => {
    bridgeLogins.mockResolvedValue(login("TRANSIENT_DISCONNECT"));
    const r = await sendReadiness([account]);
    expect(r.connected).toEqual([]);
    expect(r.loggedOut).toEqual([]);
    expect(r.reconnecting).toEqual([{ account, stateEvent: "TRANSIENT_DISCONNECT" }]);
  });

  it("logged out answers at once, no wait", async () => {
    bridgeLogins.mockResolvedValue(PROD_LOGGED_OUT);
    const r = await sendReadiness([account]);
    expect(bridgeLogins).toHaveBeenCalledTimes(1);
    expect(r.loggedOut).toHaveLength(1);
    expect(r.reconnecting).toEqual([]);
  });
});
