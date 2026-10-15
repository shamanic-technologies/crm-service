import { describe, it, expect } from "vitest";
import { readThreadForReply, type RoomSend } from "../../src/lib/reply-trigger/thread.js";
import { idempotencyKeyFor, nextAttemptDue, pickTaggedOffer, replyOccurrenceBody } from "../../src/lib/reply-trigger/watch.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

const OWN = "@crm_own:hs";
const GHOST = "@whatsapp_lid-1:hs";
const CAMPAIGN = "4af21454-ae93-4d62-8528-cc95081145ac";
const T0 = Date.parse("2026-10-12T15:00:00Z");
const at = (min: number) => T0 + min * 60_000;

function msg(id: string, sender: string, min: number, body: string, extra: Record<string, unknown> = {}): MatrixEvent {
  return { event_id: id, type: "m.room.message", sender, origin_server_ts: at(min), content: { msgtype: "m.text", body, ...extra } } as MatrixEvent;
}
const sent = (eventId: string, min: number, campaignId: string | null = CAMPAIGN): RoomSend => ({
  eventId,
  campaignId,
  status: "sent",
  sentAt: new Date(at(min)),
});

describe("readThreadForReply", () => {
  it("reads every thread: one nobody of ours opened (the person wrote first) is an unanswered burst", () => {
    const events = [msg("$1", GHOST, 0, "hey, do you have references?")];
    expect(readThreadForReply(events, OWN, [])).toEqual({
      kind: "unanswered",
      campaignId: null,
      burst: [{ eventId: "$1", at: new Date(at(0)).toISOString(), text: "hey, do you have references?" }],
    });
    // Answered by hand: nobody waiting. A send with no campaign: the burst after it names no campaign.
    expect(readThreadForReply([...events, msg("$2", OWN, 1, "hi!")], OWN, [])).toEqual({ kind: "answered" });
    const r = readThreadForReply([msg("$2", OWN, 1, "hi!"), msg("$3", GHOST, 2, "thanks")], OWN, [sent("$2", 1, null)]);
    expect(r).toMatchObject({ kind: "unanswered", campaignId: null });
  });

  it("the whole unanswered history is one burst (the watch keeps only what was mirrored after it started)", () => {
    const events = [msg("$old", GHOST, -100, "personal history"), msg("$c", OWN, 0, "Hi"), msg("$a", GHOST, 2, "Hi!")];
    const r = readThreadForReply([events[0]], OWN, []);
    expect(r).toMatchObject({ kind: "unanswered", campaignId: null });
    expect(readThreadForReply(events, OWN, [sent("$c", 0)])).toMatchObject({ kind: "unanswered", campaignId: CAMPAIGN });
  });

  it("an answer after the campaign wrote is one unanswered burst, three messages included", () => {
    const events = [
      msg("$old", GHOST, -100, "personal history before the campaign"),
      msg("$c", OWN, 0, "Hi, it's Kevin from Distribute.you"),
      msg("$a", GHOST, 2, "Hi!"),
      msg("$b", GHOST, 3, "What is it about?"),
      msg("$d", GHOST, 4, "Price?"),
    ];
    const r = readThreadForReply(events, OWN, [sent("$c", 0)]);
    expect(r).toEqual({
      kind: "unanswered",
      campaignId: CAMPAIGN,
      burst: [
        { eventId: "$a", at: new Date(at(2)).toISOString(), text: "Hi!" },
        { eventId: "$b", at: new Date(at(3)).toISOString(), text: "What is it about?" },
        { eventId: "$d", at: new Date(at(4)).toISOString(), text: "Price?" },
      ],
    });
  });

  it("after our answer (a send through the route) the next message is a NEW burst", () => {
    const events = [msg("$c", OWN, 0, "Hi"), msg("$a", GHOST, 2, "Hi!"), msg("$r", OWN, 5, "AI answer"), msg("$n", GHOST, 9, "Ok, Friday?")];
    const answered = readThreadForReply(events.slice(0, 3), OWN, [sent("$c", 0), sent("$r", 5, "responder-campaign")]);
    expect(answered).toEqual({ kind: "answered" });
    const r = readThreadForReply(events, OWN, [sent("$c", 0), sent("$r", 5, "responder-campaign")]);
    expect(r.kind).toBe("unanswered");
    if (r.kind === "unanswered") {
      expect(r.burst.map((m) => m.eventId)).toEqual(["$n"]);
      expect(r.campaignId).toBe("responder-campaign");
    }
  });

  it("our send not mirrored yet still closes the burst (placed at its send time)", () => {
    const events = [msg("$c", OWN, 0, "Hi"), msg("$a", GHOST, 2, "Hi!")];
    expect(readThreadForReply(events, OWN, [sent("$c", 0), sent("$r-not-mirrored", 5, null)])).toEqual({ kind: "answered" });
  });

  it("a message typed by hand on the account is one of ours: it ends the burst, never takes the thread over", () => {
    const events = [
      msg("$c", OWN, 0, "Hi"),
      msg("$a", GHOST, 2, "Hi!"),
      msg("$h", OWN, 3, "Hey it's me, typing on my phone"),
      msg("$x", GHOST, 6, "Great"),
    ];
    expect(readThreadForReply(events.slice(0, 3), OWN, [sent("$c", 0)])).toEqual({ kind: "answered" });
    const r = readThreadForReply(events, OWN, [sent("$c", 0)]);
    expect(r).toMatchObject({ kind: "unanswered", campaignId: CAMPAIGN });
    if (r.kind === "unanswered") expect(r.burst.map((m) => m.eventId)).toEqual(["$x"]);
  });

  it("machine lines are not an answer: a bridge notice, an uncaptioned photo, an edit", () => {
    const events = [
      msg("$c", OWN, 0, "Hi"),
      msg("$n", GHOST, 1, "Failed to bridge photo, please view it on the WhatsApp app", { msgtype: "m.notice" }),
      msg("$p", GHOST, 2, "IMG_1.jpg", { msgtype: "m.image", filename: "IMG_1.jpg" }),
    ];
    expect(readThreadForReply(events, OWN, [sent("$c", 0)])).toEqual({ kind: "answered" });
    const edit = msg("$e", GHOST, 3, "* typo", { "m.relates_to": { rel_type: "m.replace", event_id: "$n" } });
    expect(readThreadForReply([...events, edit], OWN, [sent("$c", 0)])).toEqual({ kind: "answered" });
  });

  it("holds back while one of our sends is in flight (its event cannot be told from a hand-typed one)", () => {
    const events = [msg("$c", OWN, 0, "Hi"), msg("$a", GHOST, 2, "Hi!")];
    const inFlight: RoomSend = { eventId: null, campaignId: null, status: "sending", sentAt: null };
    expect(readThreadForReply(events, OWN, [sent("$c", 0), inFlight])).toEqual({ kind: "send_in_flight" });
  });
});

describe("replyOccurrenceBody", () => {
  it("is campaign-service's strict body: positive_reply_received, person by email, the burst as item", () => {
    const body = replyOccurrenceBody({
      brandId: "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb",
      offerId: "5a2868bb-ac88-42f6-a00a-e49b89b04079",
      report: { anchorEventId: "$a", channel: "whatsapp", campaignId: CAMPAIGN, conversationId: "c1", roomId: "!r", source: "matrix" },
      person: { email: "a@b.com", name: null, phone: "+33770657585", personId: "p1" },
      messages: [{ eventId: "$a", at: "2026-10-12T15:02:00.000Z", text: "Hi!" }],
    });
    expect(body).toEqual({
      triggerId: "positive_reply_received",
      brandId: "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb",
      offerId: "5a2868bb-ac88-42f6-a00a-e49b89b04079",
      idempotencyKey: "crm:matrix:reply:$a",
      occurredAt: "2026-10-12T15:02:00.000Z",
      person: { email: "a@b.com", phone: "+33770657585" },
      item: {
        kind: "reply",
        source: "matrix",
        channel: "whatsapp",
        campaignId: CAMPAIGN,
        openedBy: "campaign",
        personId: "p1",
        conversationId: "c1",
        roomId: "!r",
        firstMessageAt: "2026-10-12T15:02:00.000Z",
        lastMessageAt: "2026-10-12T15:02:00.000Z",
        messages: [{ eventId: "$a", at: "2026-10-12T15:02:00.000Z", text: "Hi!" }],
      },
    });
    expect(idempotencyKeyFor("$a")).toBe("crm:matrix:reply:$a");
  });

  it("carries the latest 10 messages of a long burst, and openedBy not_campaign when no campaign wrote", () => {
    const messages = Array.from({ length: 14 }, (_, i) => ({ eventId: `$${i}`, at: new Date(at(i)).toISOString(), text: `m${i}` }));
    const body = replyOccurrenceBody({
      brandId: "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb",
      offerId: "5a2868bb-ac88-42f6-a00a-e49b89b04079",
      report: { anchorEventId: "$0", channel: "whatsapp", campaignId: null, conversationId: "c1", roomId: "!r", source: "matrix" },
      person: { email: "a@b.com", name: null, phone: null, personId: null },
      messages,
    });
    const item = body.item as { messages: { text: string }[]; openedBy: string; campaignId: string | null };
    expect(item.messages.map((m) => m.text)).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13"]);
    expect(item).toMatchObject({ openedBy: "not_campaign", campaignId: null });
    expect(body.idempotencyKey).toBe("crm:matrix:reply:$0");
  });

  it("picks the offer Jev is most sure the conversation is about", () => {
    expect(pickTaggedOffer([], null)).toBeNull();
    expect(pickTaggedOffer(["a", "b"], { a: 0.6, b: 0.9 })).toBe("b");
    expect(pickTaggedOffer(["b", "a"], null)).toBe("a");
  });

  it("backs off 1, 2, 4... minutes, capped at an hour", () => {
    const last = new Date(T0);
    expect(nextAttemptDue(0, null)).toBe(0);
    expect(nextAttemptDue(1, last)).toBe(T0 + 60_000);
    expect(nextAttemptDue(3, last)).toBe(T0 + 240_000);
    expect(nextAttemptDue(20, last)).toBe(T0 + 3_600_000);
  });
});
