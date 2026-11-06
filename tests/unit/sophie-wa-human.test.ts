import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

/**
 * SOPHIE-WA-HUMAN-1106: the answering AI reads what the person really sent us: their quotes, their photos, only the
 * mails between them and us; it can quote back and show « typing… ». Pure parts here; DB parts in
 * tests/integration/sophie-wa-human.test.ts.
 */
const typingCalls: string[] = [];
vi.mock("../../src/lib/matrix/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/matrix/client.js")>()),
  setTyping: vi.fn(async (_t: string, room: string, _u: string, typing: boolean, timeout?: number) => {
    typingCalls.push(`${room}:${typing}${typing ? `:${timeout}` : ""}`);
  }),
}));

const { foldEdits, inReplyToOf, messageWords, photoOf, quoteOf, PHOTO_WORDS } = await import("../../src/lib/matrix/events.js");
const { readThreadForReply } = await import("../../src/lib/reply-trigger/thread.js");
const { threadBeforeBurst } = await import("../../src/lib/reply-trigger/line-context.js");
const { exchangedWithUs } = await import("../../src/lib/people/brand-addresses.js");
const { fitItem, ITEM_MAX_CHARS } = await import("../../src/lib/reply-trigger/watch.js");
const { replyToResult } = await import("../../src/lib/whatsapp/send.js");
const typing = await import("../../src/lib/whatsapp/typing.js");

const OWN = "@sophie:hs";
const GHOST = "@whatsapp_lid-1:hs";
const T0 = Date.parse("2026-11-04T11:50:00Z");

function ev(id: string, sender: string, at: number, content: Record<string, unknown>): MatrixEvent {
  return { event_id: id, type: "m.room.message", sender, origin_server_ts: at, content };
}
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: "m.text", body, ...extra });
const reply = (to: string) => ({ "m.relates_to": { "m.in_reply_to": { event_id: to } } });
const image = (body = "image.jpg", extra: Record<string, unknown> = {}) => ({
  msgtype: "m.image",
  body,
  filename: "image.jpg",
  url: "mxc://hs/abc",
  info: { mimetype: "image/jpeg", size: 206376, w: 853, h: 1280 },
  ...extra,
});

describe("photos are messages", () => {
  it("an uncaptioned photo reads `📷 Photo`, a captioned one `📷 Photo: <caption>`", () => {
    expect(messageWords(image())).toBe(PHOTO_WORDS);
    expect(messageWords(image("Look at this"))).toBe(`${PHOTO_WORDS}: Look at this`);
    expect(messageWords(text("hi"))).toBe("hi");
    // A bridge notice or an uncaptioned video stay no message.
    expect(messageWords({ msgtype: "m.notice", body: "Old photo. Media will be requested" })).toBe("");
    expect(messageWords({ msgtype: "m.video", body: "v.mp4", filename: "v.mp4", url: "mxc://hs/v" })).toBe("");
  });

  it("photoOf names the fetchable photo with what the client stated", () => {
    expect(photoOf(image("Caption"), "$p")).toEqual({
      kind: "image",
      eventId: "$p",
      mimeType: "image/jpeg",
      sizeBytes: 206376,
      width: 853,
      height: 1280,
      caption: "Caption",
    });
    expect(photoOf(image(), "$p")?.caption).toBeNull();
    expect(photoOf(text("x"), "$t")).toBeNull();
  });

  it("prod 2026-11-02: an uncaptioned photo alone is an unanswered burst, carrying its photo", () => {
    const reading = readThreadForReply(
      [ev("$a", OWN, T0, text("How can I help?")), ev("$p", GHOST, T0 + 60_000, image())],
      OWN,
      [],
    );
    expect(reading.kind).toBe("unanswered");
    if (reading.kind !== "unanswered") return;
    expect(reading.burst).toHaveLength(1);
    expect(reading.burst[0]).toMatchObject({ eventId: "$p", text: PHOTO_WORDS, photo: { eventId: "$p", mimeType: "image/jpeg" } });
  });
});

describe("WhatsApp « Reply » quotes travel beside the message", () => {
  it("reads the quoted event id", () => {
    expect(inReplyToOf(text("yes", reply("$q")))).toBe("$q");
    expect(inReplyToOf(text("yes"))).toBeNull();
  });

  it("resolves the quoted message from the room: its words, direction and time; unknown = named, no words", () => {
    const events = [ev("$q", OWN, T0, text("Want the pricing page?"))];
    const byId = new Map(events.map((e) => [e.event_id, e]));
    expect(quoteOf(text("yes", reply("$q")), byId, OWN)).toEqual({
      eventId: "$q",
      direction: "outbound",
      at: new Date(T0).toISOString(),
      text: "Want the pricing page?",
    });
    expect(quoteOf(text("yes", reply("$gone")), byId, OWN)).toEqual({ eventId: "$gone", direction: null, at: null, text: null });
    expect(quoteOf(text("yes"), byId, OWN)).toBeNull();
  });

  it("a burst message carries what it quoted", () => {
    const reading = readThreadForReply(
      [ev("$q", OWN, T0, text("Monday or Tuesday?")), ev("$r", GHOST, T0 + 1_000, text("this one", reply("$q")))],
      OWN,
      [],
    );
    expect(reading.kind === "unanswered" && reading.burst[0].quote).toEqual({
      eventId: "$q",
      direction: "outbound",
      at: new Date(T0).toISOString(),
      text: "Monday or Tuesday?",
    });
  });

  it("an edit keeps what the message quoted", () => {
    const folded = foldEdits([
      ev("$r", GHOST, T0, text("ths one", reply("$q"))),
      ev("$e", GHOST, T0 + 500, { msgtype: "m.text", body: "* this one", "m.new_content": text("this one"), "m.relates_to": { rel_type: "m.replace", event_id: "$r" } }),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0].content?.body).toBe("this one");
    expect(inReplyToOf(folded[0].content)).toBe("$q");
  });

  it("thread lines carry their event id (to quote back), their quote and their photo", () => {
    const lines = threadBeforeBurst(
      [
        ev("$1", OWN, T0, text("Hello Kevin")),
        ev("$2", GHOST, T0 + 1_000, image("my desk")),
        ev("$3", GHOST, T0 + 2_000, text("see above", reply("$1"))),
        ev("$burst", GHOST, T0 + 3_000, text("so?")),
      ],
      OWN,
      "$burst",
      new Date(T0 + 3_000).toISOString(),
    );
    expect(lines.map((l) => [l.eventId, l.direction, l.text])).toEqual([
      ["$1", "outbound", "Hello Kevin"],
      ["$2", "inbound", `${PHOTO_WORDS}: my desk`],
      ["$3", "inbound", "see above"],
    ]);
    expect(lines[1].photo?.eventId).toBe("$2");
    expect(lines[2].quote).toMatchObject({ eventId: "$1", text: "Hello Kevin", direction: "outbound" });
    expect(lines[0].quote).toBeUndefined();
  });
});

describe("only mails between the person and us (prod 2026-11-04, Kevin = the connected mailbox's owner)", () => {
  const own = {
    addresses: { status: "ok" as const, addresses: new Set(["k.lourd@sendmail.io"]), domain: "distribute.you", error: null },
    mailboxes: new Set(["kevin.lourd@gmail.com"]),
  };
  const kevin = new Set(["kevin.lourd@gmail.com", "kevin@polaritycourse.com", "b00390394@essec.edu"]);
  const prospect = new Set(["ann@acme.com"]);

  it("drops the person's mail to a third party and the newsletters landing in the mailbox", () => {
    // « Re: 1-month project: your trading research tool », 2026-11-04 08:56 UTC.
    expect(exchangedWithUs({ from: "kevin.lourd@gmail.com", to: ["thierry@dualityfund.com"] }, kevin, own)).toBe(false);
    expect(exchangedWithUs({ from: "thierry@dualityfund.com", to: ["kevin.lourd@gmail.com"] }, kevin, own)).toBe(false);
    expect(exchangedWithUs({ from: "news@maif.fr", to: ["kevin.lourd@gmail.com"] }, kevin, own)).toBe(false);
    // A draft (no recipient) of the mailbox's owner names nobody on the other side.
    expect(exchangedWithUs({ from: "kevin.lourd@gmail.com", to: [] }, kevin, own)).toBe(false);
  });

  it("keeps a real exchange with our lines, both ways, for anyone", () => {
    expect(exchangedWithUs({ from: "ann@acme.com", to: ["kevin.lourd@gmail.com"] }, prospect, own)).toBe(true);
    expect(exchangedWithUs({ from: "Kevin.Lourd@gmail.com", to: ["ann@acme.com", "bob@acme.com"] }, prospect, own)).toBe(true);
    expect(exchangedWithUs({ from: "ann@acme.com", to: ["sales@distribute.you"] }, prospect, own)).toBe(true);
    expect(exchangedWithUs({ from: "k.lourd@sendmail.io", to: ["ann@acme.com"] }, prospect, own)).toBe(true);
    // Bcc'd to us (no To): the person's mail counts.
    expect(exchangedWithUs({ from: "ann@acme.com", to: [] }, prospect, own)).toBe(true);
    // The person writing to someone else is not to us.
    expect(exchangedWithUs({ from: "ann@acme.com", to: ["bob@other.com"] }, prospect, own)).toBe(false);
    // Kevin writing from another address of his to our mailbox IS a mail to us.
    expect(exchangedWithUs({ from: "kevin@polaritycourse.com", to: ["kevin.lourd@gmail.com"] }, kevin, own)).toBe(true);
    expect(exchangedWithUs({ from: null, to: ["kevin.lourd@gmail.com"] }, kevin, own)).toBe(false);
  });
});

describe("the occurrence stays under campaign-service's 20,000-character item cap", () => {
  it("untouched when it fits", () => {
    const item = { kind: "reply", messages: [{ eventId: "$1", at: "x", text: "hi" }], thread: [] };
    expect(fitItem(item)).toBe(item);
  });
  it("drops the oldest thread lines first, keeps the burst", () => {
    const thread = Array.from({ length: 30 }, (_, i) => ({ eventId: `$t${i}`, at: String(i), direction: "inbound", kind: "message", text: "x".repeat(1500) }));
    const out = fitItem({ kind: "reply", messages: [{ eventId: "$b", at: "y", text: "the burst" }], thread });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(ITEM_MAX_CHARS);
    const kept = out.thread as { eventId: string }[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[kept.length - 1].eventId).toBe("$t29");
    expect((out.messages as { text: string }[])[0].text).toBe("the burst");
  });
});

describe("quote-reply answer", () => {
  it("says whether the send quoted the message asked", () => {
    expect(replyToResult(null, true)).toBeUndefined();
    expect(replyToResult("$q", true)).toEqual({ eventId: "$q", quoted: true, reason: null });
    expect(replyToResult("$q", false)).toEqual({ eventId: "$q", quoted: false, reason: "not_in_room" });
    expect(replyToResult("$q", "already_sent")).toEqual({ eventId: "$q", quoted: false, reason: "already_sent" });
  });
});

describe("« typing… » held while the AI works", () => {
  const acct = { accessToken: "tok", matrixUserId: "@sophie:hs" };
  beforeEach(() => {
    vi.useFakeTimers();
    typingCalls.length = 0;
    typing.clearTypingHolds();
  });
  afterEach(() => {
    typing.clearTypingHolds();
    vi.useRealTimers();
  });

  it("start shows it at once and re-sends it every 20 s; stop ends it at once", async () => {
    const key = typing.typingKey("o", "b", { phone: "+33770657585", email: null });
    await typing.startTyping(key, acct, "!room");
    expect(typingCalls).toEqual([`!room:true:${typing.TYPING_TIMEOUT_MS}`]);
    await vi.advanceTimersByTimeAsync(typing.TYPING_REFRESH_MS * 2);
    expect(typingCalls.filter((c) => c.startsWith("!room:true"))).toHaveLength(3);
    expect(await typing.stopTyping(key)).toBe(true);
    expect(typingCalls[typingCalls.length - 1]).toBe("!room:false");
    await vi.advanceTimersByTimeAsync(typing.TYPING_REFRESH_MS * 3);
    expect(typingCalls[typingCalls.length - 1]).toBe("!room:false");
    expect(await typing.stopTyping(key)).toBe(false);
  });

  it("ends by itself 3 min after the last start, a later start extends it", async () => {
    const key = typing.typingKey("o", "b", { phone: "+1", email: null });
    await typing.startTyping(key, acct, "!r", Date.now());
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await typing.startTyping(key, acct, "!r", Date.now());
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(typing.heldTyping(key)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(typing.TYPING_HOLD_MS);
    expect(typing.heldTyping(key)).toBeNull();
    expect(typingCalls[typingCalls.length - 1]).toBe("!r:false");
  });

  it("a send into the room ends the hold", async () => {
    const key = typing.typingKey("o", "b", { phone: "+2", email: null });
    await typing.startTyping(key, acct, "!s");
    typing.endTypingIn("!s", acct.matrixUserId);
    expect(typing.heldTyping(key)).toBeNull();
    expect(typingCalls[typingCalls.length - 1]).toBe("!s:false");
  });
});
