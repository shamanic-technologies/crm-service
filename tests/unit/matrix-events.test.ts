import { describe, it, expect, afterEach } from "vitest";
import {
  aggregateMessages,
  compareEvents,
  ingestionFloor,
  isAtOrAfterFloor,
  phoneFromMxid,
  renderThread,
  resolveCounterpart,
  shouldMirror,
  splitName,
} from "../../src/lib/matrix/events.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

const OWN = "@kevin:hs.example";
const PREFIX = "@whatsapp_";
const GHOST = "@whatsapp_33612345678:hs.example";

function member(
  stateKey: string,
  membership: string,
  ts: number,
  displayname?: string,
): MatrixEvent {
  return {
    event_id: `$m${ts}`,
    type: "m.room.member",
    sender: stateKey,
    origin_server_ts: ts,
    state_key: stateKey,
    content: { membership, ...(displayname ? { displayname } : {}) },
  };
}

function message(id: string, sender: string, ts: number, body: string): MatrixEvent {
  return {
    event_id: id,
    type: "m.room.message",
    sender,
    origin_server_ts: ts,
    content: { msgtype: "m.text", body },
  };
}

describe("ingestion floor", () => {
  const original = process.env.MATRIX_INGESTION_FLOOR;
  afterEach(() => {
    if (original === undefined) delete process.env.MATRIX_INGESTION_FLOOR;
    else process.env.MATRIX_INGESTION_FLOOR = original;
  });

  it("fails loud when unset", () => {
    delete process.env.MATRIX_INGESTION_FLOOR;
    expect(() => ingestionFloor()).toThrow(/MATRIX_INGESTION_FLOOR is required/);
  });

  it("fails loud on an unparsable value", () => {
    process.env.MATRIX_INGESTION_FLOOR = "not-a-date";
    expect(() => ingestionFloor()).toThrow(/not a valid date/);
  });

  it("keeps events at or after the floor and drops older ones", () => {
    process.env.MATRIX_INGESTION_FLOOR = "2026-08-01";
    const floor = ingestionFloor();
    const before = message("$a", GHOST, Date.parse("2026-07-31T23:59:59Z"), "old");
    const exactly = message("$b", GHOST, Date.parse("2026-08-01T00:00:00Z"), "boundary");
    const after = message("$c", GHOST, Date.parse("2026-08-02T10:00:00Z"), "new");

    expect(isAtOrAfterFloor(before, floor)).toBe(false);
    expect(isAtOrAfterFloor(exactly, floor)).toBe(true);
    expect(isAtOrAfterFloor(after, floor)).toBe(true);

    expect(shouldMirror(before, floor)).toBe(false);
    expect(shouldMirror(exactly, floor)).toBe(true);
  });

  it("always mirrors room state, however old — it is identity, not content", () => {
    process.env.MATRIX_INGESTION_FLOOR = "2026-08-01";
    const floor = ingestionFloor();
    // A room joined in 2019 carries a membership event with that timestamp; it
    // is the only thing that identifies the counterpart.
    const oldJoin = member(GHOST, "join", Date.parse("2019-03-01T00:00:00Z"), "Alice");
    expect(isAtOrAfterFloor(oldJoin, floor)).toBe(false);
    expect(shouldMirror(oldJoin, floor)).toBe(true);
  });
});

describe("resolveCounterpart", () => {
  it("picks the bridge ghost, not the user's own account", () => {
    const events = [
      member(OWN, "join", 1000, "Kevin"),
      member(GHOST, "join", 1001, "Alice"),
    ];
    const cp = resolveCounterpart(events, OWN, PREFIX);
    expect(cp).toEqual({ mxid: GHOST, displayName: "Alice", phoneE164: "+33612345678" });
  });

  it("returns null for a room from another bridge", () => {
    const events = [
      member(OWN, "join", 1000),
      member("@telegram_9911:hs.example", "join", 1001, "Bob"),
    ];
    expect(resolveCounterpart(events, OWN, PREFIX)).toBeNull();
  });

  it("takes the most recent member event so a display-name change wins", () => {
    const events = [
      member(GHOST, "join", 1000, "Old Name"),
      member(GHOST, "join", 5000, "New Name"),
    ];
    expect(resolveCounterpart(events, OWN, PREFIX)?.displayName).toBe("New Name");
  });

  it("ignores members who left and never joined", () => {
    const events = [member(GHOST, "leave", 1000, "Gone")];
    expect(resolveCounterpart(events, OWN, PREFIX)).toBeNull();
  });
});

describe("phoneFromMxid", () => {
  it("extracts an E.164 phone from a WhatsApp ghost id", () => {
    expect(phoneFromMxid(GHOST, PREFIX)).toBe("+33612345678");
  });

  it("returns null for opaque bridge ids", () => {
    expect(phoneFromMxid("@discord_abc123:hs.example", "@discord_")).toBeNull();
  });
});

describe("splitName", () => {
  it("splits a display name into first / last", () => {
    expect(splitName("Alice Van Damme")).toEqual({
      fullName: "Alice Van Damme",
      firstName: "Alice",
      lastName: "Van Damme",
    });
  });

  it("passes null through", () => {
    expect(splitName(null)).toEqual({ fullName: null, firstName: null, lastName: null });
  });
});

describe("aggregateMessages", () => {
  const events = [
    message("$3", OWN, 3000, "sure, tomorrow"),
    message("$1", GHOST, 1000, "hi, do you do weddings?"),
    message("$2", GHOST, 2000, "for june"),
  ];

  it("counts inbound vs outbound and finds the watermark", () => {
    const agg = aggregateMessages(events, OWN);
    expect(agg).not.toBeNull();
    expect(agg!.messageCount).toBe(3);
    expect(agg!.inboundCount).toBe(2);
    expect(agg!.outboundCount).toBe(1);
    expect(agg!.firstMessageAt.getTime()).toBe(1000);
    expect(agg!.lastMessageAt.getTime()).toBe(3000);
    expect(agg!.lastEventId).toBe("$3");
  });

  it("ignores non-message events", () => {
    const agg = aggregateMessages([...events, member(GHOST, "join", 9000, "Alice")], OWN);
    expect(agg!.messageCount).toBe(3);
    expect(agg!.lastEventId).toBe("$3");
  });

  it("returns null when the room has state only", () => {
    expect(aggregateMessages([member(GHOST, "join", 1, "Alice")], OWN)).toBeNull();
  });

  it("breaks timestamp ties deterministically by event id", () => {
    const a = message("$aaa", GHOST, 500, "a");
    const b = message("$bbb", OWN, 500, "b");
    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(aggregateMessages([b, a], OWN)!.lastEventId).toBe("$bbb");
  });
});

describe("renderThread", () => {
  it("renders oldest-first with direction, windowed to the last N", () => {
    const lines = renderThread(
      [
        message("$1", GHOST, 1000, "one"),
        message("$2", OWN, 2000, "two"),
        message("$3", GHOST, 3000, "three"),
      ],
      OWN,
      2,
    );
    expect(lines.map((l) => l.body)).toEqual(["two", "three"]);
    expect(lines.map((l) => l.direction)).toEqual(["outbound", "inbound"]);
  });
});
