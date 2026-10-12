import { describe, it, expect } from "vitest";
import { readThreadForReply, type RoomSend } from "../../src/lib/reply-trigger/thread.js";
import { idempotencyKeyFor, nextAttemptDue, replyOccurrenceBody } from "../../src/lib/reply-trigger/watch.js";
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
  it("never reads a thread no campaign wrote to (the owner's personal chats)", () => {
    const events = [msg("$1", GHOST, 0, "hey"), msg("$2", OWN, 1, "hi!")];
    expect(readThreadForReply(events, OWN, [])).toEqual({ kind: "not_campaign_thread" });
    // A staff probe through the route with no campaign does not make it a campaign thread either.
    expect(readThreadForReply(events, OWN, [sent("$2", 1, null)])).toEqual({ kind: "not_campaign_thread" });
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

  it("a message typed by hand on the account after the campaign wrote = taken over, for good", () => {
    const events = [
      msg("$c", OWN, 0, "Hi"),
      msg("$a", GHOST, 2, "Hi!"),
      msg("$h", OWN, 3, "Hey it's me, typing on my phone"),
      msg("$x", GHOST, 6, "Great"),
    ];
    const r = readThreadForReply(events, OWN, [sent("$c", 0)]);
    expect(r.kind).toBe("taken_over");
    if (r.kind === "taken_over") {
      expect(r.takenOverBy.eventId).toBe("$h");
      expect(r.burst.map((m) => m.eventId)).toEqual(["$x"]);
    }
  });

  it("hand-typed messages BEFORE the campaign wrote are history, not a takeover", () => {
    const events = [msg("$h", OWN, -10, "(misclick)"), msg("$c", OWN, 0, "Hi"), msg("$a", GHOST, 2, "Yes")];
    expect(readThreadForReply(events, OWN, [sent("$c", 0)]).kind).toBe("unanswered");
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

  it("backs off 1, 2, 4... minutes, capped at an hour", () => {
    const last = new Date(T0);
    expect(nextAttemptDue(0, null)).toBe(0);
    expect(nextAttemptDue(1, last)).toBe(T0 + 60_000);
    expect(nextAttemptDue(3, last)).toBe(T0 + 240_000);
    expect(nextAttemptDue(20, last)).toBe(T0 + 3_600_000);
  });
});
